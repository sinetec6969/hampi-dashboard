import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'

interface Status { running: boolean; devices: number; trackers: number; ttl_s: number; error: string }
interface Device {
  addr: string; name: string | null; rssi: number; tx_power: number | null
  vendor: string | null; mfr_ids: number[]; services: string[]; tracker: string | null
  first: number; last: number; count: number
}

function dur(s: number): string {
  s = Math.max(0, Math.round(s))
  if (s < 60) return `${s}s`
  if (s < 3600) return `${Math.floor(s / 60)}m`
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}`
}

export default function BLEPage() {
  const [st, setSt]           = useState<Status | null>(null)
  const [devices, setDevices] = useState<Device[]>([])
  const [onlyTrackers, setOnlyTrackers] = useState(false)
  const [now, setNow]         = useState(() => Date.now())
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch('/api/ble/status').then(r => r.json()).then(setSt).catch(() => {})
    fetch('/api/ble/devices').then(r => r.json()).then(setDevices).catch(() => {})
    const tick = setInterval(() => setNow(Date.now()), 1000)

    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/ble'))
      wsRef.current = ws
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('BLE WS error')
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'devices') { setDevices(msg.devices); setSt(msg.status) }
        } catch { /* */ }
      }
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); wsRef.current?.close(); clearInterval(tick) }
  }, [])

  const t = now / 1000
  const shown = devices
    .filter(d => !onlyTrackers || d.tracker)
    .sort((a, b) => Number(!!b.tracker) - Number(!!a.tracker) || b.rssi - a.rssi)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10, padding: 12 }}>
      <div className="header">
        <span className="header-title">┌─ BLE SCAN</span>
        <span className="header-freq">2.4 GHz · hci0</span>
        <span className={'badge ' + (st?.running ? 'badge-green' : 'badge-red')}>
          {st?.running ? '● Scanning' : '○ Stopped'}
        </span>
        <span style={{ fontSize: 12, color: '#7fbf9a' }}>{devices.length} devices</span>
        <span style={{ fontSize: 12, color: st?.trackers ? '#ffb000' : '#4d7a62' }}>{st?.trackers ?? 0} trackers</span>
        <label style={{ fontSize: 12, color: '#7fbf9a', marginLeft: 'auto', cursor: 'pointer' }}>
          <input type="checkbox" checked={onlyTrackers} onChange={e => setOnlyTrackers(e.target.checked)} /> trackers only
        </label>
      </div>

      {st && !st.running && (
        <div className="mode-banner">
          Scanner not running{st.error ? `: ${st.error}` : ''}. Check <code>rfkill list bluetooth</code> —
          unblock with <code>rfkill unblock bluetooth</code>, then restart the service.
        </div>
      )}

      <div style={{ fontSize: 11, color: '#4d7a62' }}>
        Built-in radio, runs beside any SDR mode. Addresses rotate on most phones and tags, so one
        device can show as several rows. "Find My · separated" is a tag away from its owner — the one
        worth watching if it keeps showing up over time. Rows drop after {dur(st?.ttl_s ?? 600)} unheard.
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid #1d4030', background: '#040805' }}>
        {shown.length === 0 ? (
          <div style={{ color: '#4d7a62', padding: 12, fontSize: 13 }}>
            {onlyTrackers ? 'No trackers heard.' : 'Nothing heard yet.'}
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#4d7a62', textAlign: 'left' }}>
                <th style={{ padding: '4px 10px' }}>ADDRESS</th><th>NAME</th><th>VENDOR</th><th>TRACKER</th>
                <th style={{ textAlign: 'right' }}>RSSI</th><th style={{ textAlign: 'right' }}>SEEN FOR</th>
                <th style={{ textAlign: 'right' }}>LAST</th><th style={{ paddingLeft: 12 }}>SERVICES</th>
              </tr>
            </thead>
            <tbody>
              {shown.map(d => (
                <tr key={d.addr} style={{ borderTop: '1px solid #0d2418', color: d.tracker ? '#ffb000' : '#a8e8c4' }}>
                  <td style={{ padding: '4px 10px', color: d.tracker ? '#ffb000' : '#6aa886' }}>{d.addr}</td>
                  <td style={{ color: '#c8ffe0' }}>{d.name ?? '—'}</td>
                  <td>{d.vendor ?? (d.mfr_ids.length ? d.mfr_ids.map(i => `0x${i.toString(16).padStart(4, '0')}`).join(' ') : '—')}</td>
                  <td>{d.tracker ?? ''}</td>
                  <td style={{ textAlign: 'right' }}>{d.rssi}</td>
                  <td style={{ textAlign: 'right' }}>{dur(d.last - d.first)}</td>
                  <td style={{ textAlign: 'right', color: t - d.last < 30 ? '#00ff88' : '#6aa886' }}>{dur(t - d.last)}</td>
                  <td style={{ paddingLeft: 12, color: '#7fbf9a', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 260 }}>
                    {d.services.join(', ')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
