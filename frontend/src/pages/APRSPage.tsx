import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// Layout reuses the adsb-* CSS classes — identical map + side-panel shell.

interface Station {
  callsign:      string
  latitude?:     number
  longitude?:    number
  altitude?:     number
  course?:       number
  speed?:        number
  symbol?:       string
  symbol_table?: string
  comment?:      string
  status?:       string
  weather?:      Record<string, number>
  path?:         string[]
  format?:       string
  last_heard:    number
  count:         number
}

interface Packet {
  ts:            number
  raw:           string
  from:          string
  format?:       string
  latitude?:     number
  longitude?:    number
  message_text?: string
  addresse?:     string
  object_name?:  string
  comment?:      string
  weather?:      Record<string, number>
  [k: string]:   unknown
}

const SYMBOL_EMOJI: Record<string, string> = {
  '>': '🚗', '<': '🏍', 'k': '🛻', 'j': '🚙', 'U': '🚌', 'u': '🚚',
  '_': '☁️', 'W': '☁️', 'b': '🚲', 'Y': '⛵', 's': '🚤', "'": '🛩',
  '-': '🏠', '#': '⭐', '&': '🌐', 'r': '📶', 'O': '🎈', '[': '🚶',
}

function stationIcon(st: Station, selected: boolean): L.DivIcon {
  const glyph = SYMBOL_EMOJI[st.symbol ?? ''] ?? '📍'
  const size  = selected ? 26 : 20
  return L.divIcon({
    className: '',
    html: `<div style="font-size:${size}px;line-height:1;text-shadow:0 0 5px #000">${glyph}</div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size],
  })
}

function ago(ts: number): string {
  const s = Math.max(0, Date.now() / 1000 - ts)
  if (s < 60)   return `${Math.floor(s)}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h`
}

function pktSummary(p: Packet): string {
  if (p.message_text) return `→ ${p.addresse ?? '?'}: ${p.message_text}`
  if (p.weather)      return `WX ${p.weather.temperature != null ? Math.round(p.weather.temperature) + '°C' : ''} ${p.weather.wind_speed != null ? Math.round(p.weather.wind_speed) + 'm/s' : ''}`.trim()
  if (p.latitude != null) return `pos ${p.latitude.toFixed(4)}, ${p.longitude!.toFixed(4)}${p.comment ? ' ' + p.comment : ''}`
  return p.comment ?? p.format ?? ''
}

function MapFitter({ stations }: { stations: Record<string, Station> }) {
  const map    = useMap()
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current) return
    const pts = Object.values(stations).filter(s => s.latitude != null)
    if (pts.length === 0) return
    if (pts.length === 1) map.setView([pts[0].latitude!, pts[0].longitude!], 10)
    else map.fitBounds(pts.map(s => [s.latitude!, s.longitude!] as [number, number]), { padding: [40, 40] })
    fitted.current = true
  }, [stations, map])
  return null
}

export default function APRSPage() {
  const [stations, setStations]   = useState<Record<string, Station>>({})
  const [packets, setPackets]     = useState<Packet[]>([])
  const [selected, setSelected]   = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [frames, setFrames]       = useState(0)
  const wsRef = useRef<WebSocket | null>(null)

  function applyPacket(p: Packet) {
    setPackets(prev => [p, ...prev].slice(0, 200))
    const name = (p.object_name as string) || p.from
    if (!name) return
    setStations(prev => {
      const st: Station = { ...(prev[name] ?? { callsign: name, count: 0, last_heard: 0 }) }
      st.count      += 1
      st.last_heard  = p.ts
      for (const k of ['latitude', 'longitude', 'altitude', 'course', 'speed',
                       'symbol', 'symbol_table', 'comment', 'status', 'weather',
                       'path', 'format'] as const) {
        if (p[k] != null) (st as unknown as Record<string, unknown>)[k] = p[k]
      }
      return { ...prev, [name]: st }
    })
  }

  useEffect(() => {
    fetch('/api/aprs/stations').then(r => r.json())
      .then((list: Station[]) => setStations(Object.fromEntries(list.map(s => [s.callsign, s]))))
      .catch(() => {})
    fetch('/api/aprs/packets').then(r => r.json())
      .then(setPackets).catch(() => {})

    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/aprs'))
      wsRef.current = ws
      ws.onopen  = () => setConnected(true)
      ws.onclose = () => { setConnected(false); if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('APRS WS error')
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'packet') applyPacket(msg.packet)
          else if (msg.type === 'status') setFrames(msg.frames)
        } catch {}
      }
    }
    connect()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  const positioned = Object.values(stations).filter(s => s.latitude != null)
  const selSt      = selected ? stations[selected] : null

  return (
    <div className="adsb-page">
      <div className="adsb-header">
        <span className="adsb-header-title" style={{ color: '#ff8844' }}>📻 APRS 144.390</span>
        <span className="adsb-count">{Object.keys(stations).length} stations · {packets.length || frames} pkts</span>
        <span className={'badge ' + (connected ? 'badge-green' : 'badge-red')}>
          {connected ? '● Live' : '○ Offline'}
        </span>
      </div>

      <div className="adsb-body">
        <div className="adsb-map-wrap">
          <MapContainer center={[39, -98]} zoom={4} style={{ height: '100%', width: '100%' }} zoomControl scrollWheelZoom>
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            />
            <MapFitter stations={stations} />
            {positioned.map(st => (
              <Marker
                key={st.callsign}
                position={[st.latitude!, st.longitude!]}
                icon={stationIcon(st, st.callsign === selected)}
                eventHandlers={{ click: () => setSelected(st.callsign) }}
              >
                <Popup>
                  <div className="adsb-popup">
                    <div className="adsb-popup-call">{st.callsign}</div>
                    <div>{st.comment ?? st.status ?? ''}</div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        <div className="adsb-side">
          {selSt ? (
            <div className="adsb-detail">
              <div className="adsb-detail-header">
                <span className="adsb-detail-call">{selSt.callsign}</span>
                <button className="adsb-close-btn" onClick={() => setSelected(null)}>×</button>
              </div>
              <div className="adsb-detail-icao">
                {SYMBOL_EMOJI[selSt.symbol ?? ''] ?? '📍'} {selSt.format ?? ''} · heard {ago(selSt.last_heard)} ago · {selSt.count} pkts
              </div>
              <div className="adsb-detail-grid">
                <span className="adsb-detail-label">Position</span>
                <span className="adsb-detail-val">
                  {selSt.latitude != null ? `${selSt.latitude.toFixed(4)}, ${selSt.longitude!.toFixed(4)}` : '—'}
                </span>
                <span className="adsb-detail-label">Course/Spd</span>
                <span className="adsb-detail-val">
                  {selSt.course != null ? selSt.course + '°' : '—'} / {selSt.speed != null ? Math.round(selSt.speed) + ' km/h' : '—'}
                </span>
                <span className="adsb-detail-label">Altitude</span>
                <span className="adsb-detail-val">{selSt.altitude != null ? Math.round(selSt.altitude) + ' m' : '—'}</span>
                <span className="adsb-detail-label">Path</span>
                <span className="adsb-detail-val">{selSt.path?.join(',') ?? '—'}</span>
                {selSt.weather && (
                  <>
                    <span className="adsb-detail-label">Weather</span>
                    <span className="adsb-detail-val">
                      {selSt.weather.temperature != null && `${selSt.weather.temperature.toFixed(1)}°C `}
                      {selSt.weather.wind_speed != null && `wind ${selSt.weather.wind_speed.toFixed(1)} m/s `}
                      {selSt.weather.rain_1h != null && `rain ${selSt.weather.rain_1h} mm`}
                    </span>
                  </>
                )}
                {selSt.comment && (
                  <>
                    <span className="adsb-detail-label">Comment</span>
                    <span className="adsb-detail-val">{selSt.comment}</span>
                  </>
                )}
              </div>
            </div>
          ) : (
            <div className="adsb-list" style={{ display: 'flex', flexDirection: 'column' }}>
              <div style={{ flex: '0 0 50%', overflowY: 'auto' }}>
                {Object.keys(stations).length === 0 ? (
                  <div className="adsb-list-empty">
                    {connected ? 'Waiting for packets…' : 'APRS offline — switch SDR mode on the home page'}
                  </div>
                ) : (
                  Object.values(stations)
                    .sort((a, b) => b.last_heard - a.last_heard)
                    .map(st => (
                      <div key={st.callsign} className="adsb-list-row" onClick={() => setSelected(st.callsign)}>
                        <span className="adsb-list-plane">{SYMBOL_EMOJI[st.symbol ?? ''] ?? '📍'}</span>
                        <span className="adsb-list-id">{st.callsign}</span>
                        <span className="adsb-list-hdg">{ago(st.last_heard)}</span>
                        <span className="adsb-list-spd">{st.count}</span>
                      </div>
                    ))
                )}
              </div>
              <div style={{ flex: 1, overflowY: 'auto', borderTop: '1px solid #333', fontSize: 11, padding: 4 }}>
                {packets.map((p, i) => (
                  <div key={i} style={{ padding: '2px 0', borderBottom: '1px solid #222' }}>
                    <span style={{ color: '#ff8844' }}>{p.from}</span>{' '}
                    <span style={{ color: '#888' }}>{ago(p.ts)}</span>{' '}
                    <span>{pktSummary(p)}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
