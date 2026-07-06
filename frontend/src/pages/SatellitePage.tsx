import { useEffect, useRef, useState } from 'react'

interface SatPacket {
  time:            number
  satellite:       string
  norad:           number
  mode:            string
  frequency:       number
  frequency_error: number
  f_doppler:       number
  rssi:            number
  snr:             number
  crc_error:       boolean
  noisy:           boolean
  data:            string
  data_raw:        string
  sf?:             number | null
  cr?:             number | null
  bw?:             number | null
  bitrate?:        number | null
  freqdev?:        number | null
}

interface StationInfo {
  satellite?:  string
  modem_conf?: number
  board?:      number
  version?:    number
  ip?:         string
  vbat?:       number
  mem?:        number
  wifi_rssi?:  number
  inst_rssi?:  number
  radio_err?:  number
  seconds?:    number
}

function fmtTime(unix: number): string {
  if (!unix) return '—'
  const d = new Date(unix * 1000)
  return d.toLocaleTimeString('en-GB', { hour12: false })
}

function fmtFreq(mhz: number): string {
  return mhz ? `${mhz.toFixed(3)} MHz` : '—'
}

function rssiBar(rssi: number): string {
  // -50 dBm = excellent, -120 dBm = floor
  const pct = Math.max(0, Math.min(100, ((rssi + 120) / 70) * 100))
  const filled = Math.round(pct / 10)
  return '█'.repeat(filled) + '░'.repeat(10 - filled)
}

function rssiColor(rssi: number): string {
  if (rssi > -80) return '#00ff88'
  if (rssi > -100) return '#ffcc44'
  return '#ff4444'
}

function hexRows(raw: string): string[] {
  if (!raw) return []
  const bytes = raw.match(/.{1,2}/g) || []
  const rows: string[] = []
  for (let i = 0; i < bytes.length; i += 16) {
    const chunk = bytes.slice(i, i + 16)
    const hex   = chunk.map(b => b.padStart(2, '0')).join(' ')
    const ascii = chunk.map(b => {
      const c = parseInt(b, 16)
      return c >= 32 && c < 127 ? String.fromCharCode(c) : '.'
    }).join('')
    rows.push(`${String(i).padStart(4, '0')}  ${hex.padEnd(47)}  ${ascii}`)
  }
  return rows
}

function PacketCard({ pkt }: { pkt: SatPacket }) {
  const [expanded, setExpanded] = useState(false)
  const col = rssiColor(pkt.rssi)
  const valid = !pkt.crc_error && !pkt.noisy

  return (
    <div className="sat-packet" style={{ borderLeftColor: valid ? col : '#ff4444' }}>
      <div className="sat-packet-header" onClick={() => setExpanded(e => !e)}>
        <div className="sat-packet-left">
          <span className="sat-packet-time">{fmtTime(pkt.time)}</span>
          <span className="sat-packet-sat">{pkt.satellite}</span>
          {pkt.norad > 0 && <span className="sat-packet-norad">#{pkt.norad}</span>}
        </div>
        <div className="sat-packet-right">
          <span className={`sat-badge ${valid ? 'sat-badge-ok' : 'sat-badge-err'}`}>
            {pkt.crc_error ? 'CRC ERR' : pkt.noisy ? 'NOISY' : 'OK'}
          </span>
          <span className="sat-rssi" style={{ color: col }}>
            {pkt.rssi.toFixed(1)} dBm
          </span>
          <span className="sat-snr">
            SNR {pkt.snr.toFixed(1)}
          </span>
          <span className="sat-expand">{expanded ? '▲' : '▼'}</span>
        </div>
      </div>

      <div className="sat-packet-meta">
        <span>{fmtFreq(pkt.frequency)}</span>
        {pkt.frequency_error !== 0 && (
          <span className="sat-ferr">Δ{pkt.frequency_error > 0 ? '+' : ''}{pkt.frequency_error.toFixed(0)} Hz</span>
        )}
        {pkt.f_doppler !== 0 && (
          <span className="sat-ferr">doppler {pkt.f_doppler > 0 ? '+' : ''}{pkt.f_doppler.toFixed(0)} Hz</span>
        )}
        <span className="sat-mode">{pkt.mode}</span>
        {pkt.mode === 'LoRa' && pkt.sf && (
          <span>SF{pkt.sf} CR{pkt.cr} BW{pkt.bw}</span>
        )}
        {pkt.mode !== 'LoRa' && pkt.bitrate && (
          <span>{pkt.bitrate} kbps</span>
        )}
      </div>

      <div className="sat-rssi-bar" style={{ color: col }}>
        {rssiBar(pkt.rssi)}
      </div>

      {expanded && (
        <div className="sat-packet-detail">
          {pkt.data && (
            <div className="sat-data-section">
              <div className="sat-data-label">decoded</div>
              <div className="sat-data-value">{pkt.data}</div>
            </div>
          )}
          {pkt.data_raw && (
            <div className="sat-data-section">
              <div className="sat-data-label">raw hex</div>
              <pre className="sat-hex">{hexRows(pkt.data_raw).join('\n')}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function SatellitePage() {
  const [connected, setConnected]   = useState(false)
  const [mqttOk, setMqttOk]         = useState(false)
  const [station, setStation]       = useState<StationInfo>({})
  const [packets, setPackets]       = useState<SatPacket[]>([])
  const [piIp, setPiIp]             = useState('')
  const wsRef                        = useRef<WebSocket | null>(null)

  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const ws = new WebSocket(`${proto}://${location.host}/ws/satellite`)
    wsRef.current = ws

    ws.onopen  = () => setConnected(true)
    ws.onclose = () => { setConnected(false); setMqttOk(false); if (alive) retry = setTimeout(connect, 3000) }

    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data)

      if (msg.type === 'packet') {
        const pkt: SatPacket = msg
        setPackets(prev => [pkt, ...prev].slice(0, 100))
      } else if (msg.type === 'mqtt_connected') {
        setMqttOk(true)
      } else if (msg.type === 'mqtt_disconnected') {
        setMqttOk(false)
      } else if (msg.type === 'status') {
        setMqttOk(msg.mqtt_connected ?? false)
        if (msg.station) setStation(s => ({ ...s, ...msg.station }))
        if (msg.packets) setPackets(msg.packets)
      } else if (msg.type === 'ping' || msg.type === 'station_status') {
        setStation(s => ({ ...s, ...msg }))
      }
    }
    }
    connect()

    // Seed from REST on load
    fetch('/api/sysinfo').then(r => r.json()).then(d => setPiIp(d.local_ip ?? '')).catch(() => {})
    fetch('/api/satellite/status').then(r => r.json()).then(d => {
      setMqttOk(d.mqtt_connected ?? false)
      if (d.station) setStation(d.station)
    }).catch(() => {})

    fetch('/api/satellite/packets').then(r => r.json()).then(pkts => {
      if (pkts.length) setPackets(pkts)
    }).catch(() => {})

    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  return (
    <div className="sat-page">
      <div className="sat-header">
        <div className="sat-title">Satellite Telemetry</div>
        <div className="sat-badges">
          <span className={`sat-dot ${connected ? 'sat-dot-ok' : 'sat-dot-off'}`}>
            WS {connected ? 'connected' : 'disconnected'}
          </span>
          <span className={`sat-dot ${mqttOk ? 'sat-dot-ok' : 'sat-dot-off'}`}>
            MQTT {mqttOk ? 'connected' : 'waiting'}
          </span>
        </div>
      </div>

      <div className="sat-station">
        <div className="sat-station-row">
          {station.satellite && (
            <span className="sat-station-item">
              <span className="sat-station-label">listening</span>
              <span className="sat-station-val">{station.satellite}</span>
            </span>
          )}
          {station.ip && (
            <span className="sat-station-item">
              <span className="sat-station-label">board IP</span>
              <span className="sat-station-val">{station.ip}</span>
            </span>
          )}
          {station.vbat != null && station.vbat > 0 && (
            <span className="sat-station-item">
              <span className="sat-station-label">Vbat</span>
              <span className="sat-station-val">{station.vbat.toFixed(2)} V</span>
            </span>
          )}
          {station.mem != null && (
            <span className="sat-station-item">
              <span className="sat-station-label">free mem</span>
              <span className="sat-station-val">{((station.mem ?? 0) / 1024).toFixed(0)} KB</span>
            </span>
          )}
          {station.wifi_rssi != null && (
            <span className="sat-station-item">
              <span className="sat-station-label">WiFi</span>
              <span className="sat-station-val">{station.wifi_rssi} dBm</span>
            </span>
          )}
          {station.inst_rssi != null && (
            <span className="sat-station-item">
              <span className="sat-station-label">radio RSSI</span>
              <span className="sat-station-val">{station.inst_rssi?.toFixed(1)} dBm</span>
            </span>
          )}
        </div>
        {!mqttOk && (
          <div className="sat-setup-hint">
            No broker link. Check the TinyGS board is plugged in and powered, and that its
            web config points MQTT at this Pi{piIp ? <> (<strong>{piIp}</strong> port <strong>1883</strong>)</> : ''} — not mqtt.tinygs.com.
          </div>
        )}
      </div>

      <div className="sat-count">
        {packets.length === 0
          ? 'No packets yet — they arrive when the board hears a satellite pass'
          : `${packets.length} packet${packets.length !== 1 ? 's' : ''} received`}
      </div>

      <div className="sat-feed">
        {packets.map((pkt, i) => (
          <PacketCard key={`${pkt.time}-${i}`} pkt={pkt} />
        ))}
      </div>
    </div>
  )
}
