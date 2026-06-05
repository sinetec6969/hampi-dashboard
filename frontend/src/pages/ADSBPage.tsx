import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup, Polyline, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// ── Types ─────────────────────────────────────────────────────────────────

interface Aircraft {
  icao:      string
  callsign:  string | null
  altitude:  number | null
  lat:       number | null
  lon:       number | null
  speed:     number | null
  heading:   number | null
  vrate:     number | null
  last_seen: number
  track:     [number, number][]
}

// ── Helpers ───────────────────────────────────────────────────────────────

function altColor(alt: number | null): string {
  if (alt === null) return '#888'
  if (alt <  2000) return '#44ff88'
  if (alt < 10000) return '#44ccff'
  if (alt < 25000) return '#4488ff'
  return '#ffffff'
}

function planeIcon(heading: number | null, altitude: number | null, selected: boolean): L.DivIcon {
  const deg   = heading ?? 0
  const color = selected ? '#ffcc00' : altColor(altitude)
  const size  = selected ? 22 : 18
  return L.divIcon({
    className: '',
    html: `<div style="font-size:${size}px;line-height:1;transform:rotate(${deg}deg);color:${color};text-shadow:0 0 5px #000,0 0 2px #000;filter:drop-shadow(0 0 3px ${color}44)">✈</div>`,
    iconSize:   [size, size],
    iconAnchor: [size / 2, size / 2],
  })
}

function fmtAlt(ft: number | null): string {
  if (ft === null) return '—'
  return ft.toLocaleString() + ' ft'
}

function fmtSpd(kts: number | null): string {
  if (kts === null) return '—'
  return kts + ' kts'
}

function fmtVr(fpm: number | null): string {
  if (fpm === null) return '—'
  const sign = fpm > 0 ? '+' : ''
  return sign + fpm.toLocaleString() + ' fpm'
}

function fmtHdg(deg: number | null): string {
  if (deg === null) return '—'
  return deg + '°'
}

const STALE_S = 10

function staleness(last_seen: number): number {
  return Date.now() / 1000 - last_seen
}

function isFresh(ac: Aircraft): boolean {
  return staleness(ac.last_seen) <= STALE_S
}

// ── Map auto-fit ─────────────────────────────────────────────────────────

function MapFitter({ aircraft }: { aircraft: Record<string, Aircraft> }) {
  const map    = useMap()
  const fitted = useRef(false)
  useEffect(() => {
    if (fitted.current) return
    const pts = Object.values(aircraft).filter(a => a.lat !== null && a.lon !== null)
    if (pts.length === 0) return
    if (pts.length === 1) {
      map.setView([pts[0].lat!, pts[0].lon!], 9)
    } else {
      map.fitBounds(
        pts.map(a => [a.lat!, a.lon!] as [number, number]),
        { padding: [40, 40] }
      )
    }
    fitted.current = true
  }, [aircraft, map])
  return null
}

// ── Main component ────────────────────────────────────────────────────────

export default function ADSBPage() {
  const [aircraft, setAircraft]   = useState<Record<string, Aircraft>>({})
  const [selected, setSelected]   = useState<string | null>(null)
  const [connected, setConnected] = useState(false)
  const [latRef, setLatRef]       = useState(0)
  const [lonRef, setLonRef]       = useState(0)
  const [, setTick]               = useState(0)
  const wsRef = useRef<WebSocket | null>(null)

  // Per-second tick — drives stale expiry and map refresh without waiting for WS messages
  useEffect(() => {
    const id = setInterval(() => setTick(t => t + 1), 1000)
    return () => clearInterval(id)
  }, [])

  // Fetch reference position and initial snapshot
  useEffect(() => {
    fetch('/api/adsb/status')
      .then(r => r.json())
      .then(d => {
        if (d.lat_ref) setLatRef(d.lat_ref)
        if (d.lon_ref) setLonRef(d.lon_ref)
      })
      .catch(() => {})

    fetch('/api/adsb/aircraft')
      .then(r => r.json())
      .then((list: Aircraft[]) => {
        setAircraft(prev => {
          const next = { ...prev }
          for (const ac of list) next[ac.icao] = ac
          return next
        })
      })
      .catch(() => {})
  }, [])

  // WebSocket
  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws    = new WebSocket(`${proto}://${location.host}/ws/adsb`)
    wsRef.current = ws

    ws.onopen  = () => setConnected(true)
    ws.onclose = () => setConnected(false)

    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'aircraft') {
          const ac: Aircraft = msg.aircraft
          setAircraft(prev => ({ ...prev, [ac.icao]: ac }))
        } else if (msg.type === 'prune') {
          const expired: string[] = msg.expired
          setAircraft(prev => {
            const next = { ...prev }
            for (const icao of expired) delete next[icao]
            return next
          })
          setSelected(prev => expired.includes(prev ?? '') ? null : prev)
        }
      } catch {}
    }

    return () => { ws.close() }
  }, [])

  const fresh    = Object.values(aircraft).filter(isFresh)
  const visible  = fresh.filter(a => a.lat !== null && a.lon !== null)
  const selAc    = selected && isFresh(aircraft[selected] ?? { last_seen: 0 } as Aircraft)
                   ? aircraft[selected]
                   : null
  const mapCenter: [number, number] = latRef && lonRef ? [latRef, lonRef] : [39, -98]
  const mapZoom  = latRef && lonRef ? 8 : 4
  const count    = fresh.length

  return (
    <div className="adsb-page">
      <div className="adsb-header">
        <span className="adsb-header-title">✈ ADS-B Aircraft</span>
        <span className="adsb-count">{count} tracked</span>
        <span className={'badge ' + (connected ? 'badge-green' : 'badge-red')}>
          {connected ? '● Live' : '○ Offline'}
        </span>
      </div>

      <div className="adsb-body">
        <div className="adsb-map-wrap">
          <MapContainer
            center={mapCenter}
            zoom={mapZoom}
            style={{ height: '100%', width: '100%' }}
            zoomControl
            scrollWheelZoom
          >
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
            />

            <MapFitter aircraft={aircraft} />

            {/* Track polyline for selected aircraft */}
            {selAc && selAc.track.length > 1 && (
              <Polyline
                positions={selAc.track as [number, number][]}
                pathOptions={{ color: '#ffcc00', weight: 2, opacity: 0.7 }}
              />
            )}

            {/* Aircraft markers */}
            {visible.map(ac => (
              <Marker
                key={ac.icao}
                position={[ac.lat!, ac.lon!]}
                icon={planeIcon(ac.heading, ac.altitude, ac.icao === selected)}
                opacity={staleness(ac.last_seen) > 45 ? 0.45 : 1}
                eventHandlers={{ click: () => setSelected(ac.icao) }}
              >
                <Popup>
                  <div className="adsb-popup">
                    <div className="adsb-popup-call">{ac.callsign ?? ac.icao.toUpperCase()}</div>
                    <div>{fmtAlt(ac.altitude)}</div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>

        {/* Side panel: detail or list */}
        <div className="adsb-side">
          {selAc ? (
            <div className="adsb-detail">
              <div className="adsb-detail-header">
                <span className="adsb-detail-call">
                  {selAc.callsign ?? '—'}
                </span>
                <button className="adsb-close-btn" onClick={() => setSelected(null)}>×</button>
              </div>
              <div className="adsb-detail-icao">{selAc.icao.toUpperCase()}</div>

              <div className="adsb-detail-grid">
                <span className="adsb-detail-label">Altitude</span>
                <span className="adsb-detail-val">{fmtAlt(selAc.altitude)}</span>

                <span className="adsb-detail-label">Speed</span>
                <span className="adsb-detail-val">{fmtSpd(selAc.speed)}</span>

                <span className="adsb-detail-label">Heading</span>
                <span className="adsb-detail-val">{fmtHdg(selAc.heading)}</span>

                <span className="adsb-detail-label">Vert rate</span>
                <span className="adsb-detail-val" style={{
                  color: selAc.vrate === null ? undefined
                       : selAc.vrate > 100 ? '#44ff88'
                       : selAc.vrate < -100 ? '#ff4444'
                       : undefined
                }}>
                  {fmtVr(selAc.vrate)}
                </span>

                <span className="adsb-detail-label">Track pts</span>
                <span className="adsb-detail-val">{selAc.track.length}</span>
              </div>
            </div>
          ) : (
            <div className="adsb-list">
              {fresh.length === 0 ? (
                <div className="adsb-list-empty">
                  {connected
                    ? 'Waiting for aircraft…'
                    : 'ADS-B offline — switch SDR mode or enable ADSB_ENABLE=1'}
                </div>
              ) : (
                <>
                  <div className="adsb-list-cols">
                    <span/>
                    <span>ID</span>
                    <span>HDG</span>
                    <span>SPD</span>
                  </div>
                  {fresh
                    .sort((a, b) => (b.altitude ?? 0) - (a.altitude ?? 0))
                    .map(ac => (
                      <div
                        key={ac.icao}
                        className={'adsb-list-row' + (ac.lat === null ? ' adsb-list-row-nopos' : '')}
                        onClick={() => ac.lat !== null && setSelected(ac.icao)}
                      >
                        <span className="adsb-list-plane" style={{ color: altColor(ac.altitude) }}>✈</span>
                        <span className="adsb-list-id">{ac.callsign ?? ac.icao.toUpperCase()}</span>
                        <span className="adsb-list-hdg">{ac.heading !== null ? ac.heading + '°' : '—'}</span>
                        <span className="adsb-list-spd">{ac.speed !== null ? ac.speed + 'kt' : '—'}</span>
                      </div>
                    ))
                  }
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
