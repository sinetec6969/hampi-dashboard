import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'

interface Status {
  running: boolean
  freqs: number[]
  cur_freq: number | null
  hop_s: number | null
  devices: number
  events: number
  last_log: string
}
type Ev = Record<string, unknown> & { model: string; time?: string }
interface Device {
  key: string; model: string; id?: string | number; channel?: string | number
  first: number; last: number; count: number; rssi?: number; last_event: Ev
}

const META = new Set(['time', 'model', 'id', 'channel', 'protocol', 'rssi', 'snr', 'noise', 'mic', 'mod', 'freq', 'freq1', 'freq2'])

function readings(ev: Ev): string {
  return Object.entries(ev)
    .filter(([k]) => !META.has(k))
    .slice(0, 5)
    .map(([k, v]) => `${k}=${typeof v === 'number' ? +v.toFixed(2) : String(v)}`)
    .join(' ')
}

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round(now / 1000 - ts))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

const mhz = (f: number) => (f / 1e6).toFixed(3)

export default function SubGHzPage() {
  const [st, setSt]           = useState<Status | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [events, setEvents]   = useState<Ev[]>([])
  const [mode, setMode]       = useState('')
  const [switching, setSwitching] = useState(false)
  const [now, setNow]         = useState(() => Date.now())
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch('/api/subghz/status').then(r => r.json()).then(setSt).catch(() => {})
    fetch('/api/subghz/devices').then(r => r.json()).then(setDevices).catch(() => {})
    fetch('/api/sdr/mode').then(r => r.json()).then(d => setMode(d.mode)).catch(() => {})
    const tick = setInterval(() => setNow(Date.now()), 1000)

    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/subghz'))
      wsRef.current = ws
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('SubGHz WS error')
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'status') setSt(msg)
          else if (msg.type === 'event') {
            const d: Device = msg.device
            setDevices(prev => [d, ...prev.filter(x => x.key !== d.key)])
            setEvents(prev => [msg.event, ...prev].slice(0, 100))
          }
        } catch { /* */ }
      }
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); wsRef.current?.close(); clearInterval(tick) }
  }, [])

  async function enable() {
    setSwitching(true)
    try { const r = await fetch('/api/sdr/mode?mode=subghz', { method: 'POST' }); setMode((await r.json()).mode) } catch { /* */ }
    setSwitching(false)
  }

  const active = mode === 'subghz'
  const freqs = st?.freqs ?? [433920000, 315000000]

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10, padding: 12 }}>
      <div className="header">
        <span className="header-title">Sub-GHz ISM</span>
        <span className="header-freq">
          {active && st?.cur_freq ? `${mhz(st.cur_freq)} MHz` : freqs.map(mhz).join(' / ') + ' MHz'}
        </span>
        <span className={'badge ' + (active && st?.running ? 'badge-green' : 'badge-red')}>
          {active && st?.running ? '● Listening' : '○ Idle'}
        </span>
        {active && st?.hop_s && <span style={{ fontSize: 12, color: '#9aa5a0' }}>hop {st.hop_s}s</span>}
        <span style={{ fontSize: 12, color: '#9aa5a0' }}>{devices.length} devices</span>
      </div>

      {!active && (
        <div className="mode-banner">
          rtl_433 needs device 0 to itself. Switching stops the current mode and listens on{' '}
          {freqs.map(mhz).join(' / ')} MHz.{' '}
          <button className="btn" onClick={enable} disabled={switching}>
            {switching ? 'switching…' : 'Switch to SUB-GHZ mode'}
          </button>
          <div className="mode-banner-sub">
            433.92 carries weather stations, doorbells and remotes; 315 is where US TPMS lives.
          </div>
        </div>
      )}

      {active && st?.last_log && (
        <div style={{ fontSize: 11, color: '#9aa5a0', background: '#000', border: '1px solid #252b2c', padding: '4px 8px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {st.last_log}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid #343c3d', background: '#0d1011' }}>
        <div style={{ color: '#35d07f', fontWeight: 600, fontSize: 13, padding: '8px 10px 4px' }}>Devices heard</div>
        {devices.length === 0 ? (
          <div style={{ color: '#66716c', padding: 12, fontSize: 13 }}>
            Nothing decoded yet. Sensors transmit every 30–60 s; TPMS only while a car is rolling past.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#66716c', textAlign: 'left' }}>
                <th style={{ padding: '4px 10px' }}>MODEL</th><th>ID</th><th>CH</th>
                <th style={{ textAlign: 'right' }}>×</th><th style={{ textAlign: 'right' }}>LAST</th>
                <th style={{ textAlign: 'right' }}>RSSI</th><th style={{ paddingLeft: 12 }}>READINGS</th>
              </tr>
            </thead>
            <tbody>
              {devices.map(d => (
                <tr key={d.key} style={{ borderTop: '1px solid #252b2c', color: '#cfd6d2' }}>
                  <td style={{ padding: '4px 10px', color: '#e7ece9' }}>{d.model}</td>
                  <td>{d.id ?? '—'}</td>
                  <td>{d.channel ?? '—'}</td>
                  <td style={{ textAlign: 'right' }}>{d.count}</td>
                  <td style={{ textAlign: 'right', color: now / 1000 - d.last < 120 ? '#35d07f' : '#8a9590' }}>{ago(d.last, now)}</td>
                  <td style={{ textAlign: 'right' }}>{d.rssi != null ? d.rssi.toFixed(1) : '—'}</td>
                  <td style={{ paddingLeft: 12, color: '#9aa5a0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 360 }}>
                    {readings(d.last_event)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {events.length > 0 && (
        <div style={{ maxHeight: 160, overflowY: 'auto', border: '1px solid #252b2c', background: '#000', padding: '4px 8px', fontSize: 11, color: '#9aa5a0' }}>
          {events.map((e, i) => (
            <div key={i} style={{ whiteSpace: 'nowrap' }}>
              <span style={{ color: '#66716c' }}>{e.time ? new Date(Number(e.time) * 1000).toLocaleTimeString() : ''}</span>{' '}
              <span style={{ color: '#e7ece9' }}>{e.model}</span> {String(e.id ?? '')} {readings(e)}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
