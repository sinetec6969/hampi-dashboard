import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'

interface Call { _encrypted?: boolean; [k: string]: string | boolean | undefined }
interface Status {
  running: boolean
  tuner_locked: boolean
  system: string
  systems: string[]
  site: string
  protocol: string
  control_freq: number
  color_code: number | null
  encrypted_seen: boolean
  vnc_url: string
  recent: Call[]
}

// SDRTrunk v0.6.1 call_events header columns — show these if present.
const COLS = ['TIMESTAMP', 'PROTOCOL', 'EVENT', 'FROM', 'TO', 'TIMESLOT', 'DETAILS']

export default function TrunkPage() {
  const [st, setSt]   = useState<Status | null>(null)
  const [mode, setMode] = useState('')
  const [switching, setSwitching] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch('/api/trunk/status').then(r => r.json()).then(setSt).catch(() => {})
    fetch('/api/sdr/mode').then(r => r.json()).then(d => setMode(d.mode)).catch(() => {})

    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/trunk'))
      wsRef.current = ws
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'status') setSt(msg)
          // call events also arrive live, but status carries `recent` so we just
          // let the next status frame (≤2s) refresh the table.
        } catch { /* */ }
      }
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); wsRef.current?.close() }
  }, [])

  async function setSdrMode(m: string) {
    setSwitching(true)
    try { const r = await fetch(`/api/sdr/mode?mode=${m}`, { method: 'POST' }); setMode((await r.json()).mode) }
    catch { /* */ }
    setSwitching(false)
  }

  async function setSystem(name: string) {
    setSwitching(true)
    try {
      await fetch(`/api/trunk/system?name=${encodeURIComponent(name)}`, { method: 'POST' })
      const s = await fetch('/api/trunk/status').then(r => r.json())
      setSt(s)
    } catch { /* */ }
    setSwitching(false)
  }

  const active = mode === 'trunk'
  const recent = st?.recent ?? []
  let cols = COLS.slice(0, 5)
  if (recent.length) {
    const present = COLS.filter(c => c in recent[0])
    cols = present.length ? present : Object.keys(recent[0]).filter(k => k !== '_encrypted')
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10, padding: 12 }}>
      <div className="header">
        <span className="header-title">┌─ TRUNKED DMR</span>
        <span className="header-freq">{((st?.control_freq ?? 454031250) / 1e6).toFixed(5)} MHz control · CC{st?.color_code ?? '?'}</span>
        <span className={'badge ' + (active && st?.tuner_locked ? 'badge-green' : active && st?.running ? 'badge-amber' : 'badge-red')}>
          {active && st?.tuner_locked ? '● Locked' : active && st?.running ? '◐ Starting' : '○ Idle'}
        </span>
        {st?.encrypted_seen && <span className="badge badge-red" title="At least one decoded call was encrypted">🔒 Encrypted TG seen</span>}
        {active && (
          <button className="btn" onClick={() => setSdrMode('dmr')} disabled={switching}
                  title="Stop SDRTrunk and return the dongle to the dashboard (DMR mode)">
            {switching ? 'switching…' : '■ Stop / release SDR'}
          </button>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#6aa886', fontSize: 12 }}>
        <label>System:</label>
        <select value={st?.system ?? ''} disabled={switching || !st?.systems?.length}
                onChange={e => setSystem(e.target.value)}
                style={{ background: '#0c0c0c', color: '#a8e8c4', border: '1px solid #1d4030', padding: '2px 4px', font: 'inherit' }}>
          {(st?.systems ?? []).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <span>· {st?.site} · {st?.protocol === 'cap_plus' ? 'Capacity Plus' : 'Connect Plus'} (SDRTrunk)</span>
        {active && <span style={{ color: '#4d7a62' }}>— switching reloads SDRTrunk (~20 s to relock)</span>}
      </div>

      {!active && (
        <div className="mode-banner">
          Trunked DMR hands device 0 to the SDRTrunk service (control-channel tracking needs
          the dongle to itself). The dashboard's own SDR stops while it runs.{' '}
          <button className="btn" onClick={() => setSdrMode('trunk')} disabled={switching}>
            {switching ? 'switching…' : 'Switch to Trunk mode'}
          </button>
          <div className="mode-banner-sub">Tuner lock takes about 20 seconds after the switch.</div>
        </div>
      )}

      {active && st?.vnc_url && (
        <div style={{ fontSize: 12, color: '#7fbf9a' }}>
          Full UI over Tailscale VNC: <code style={{ color: '#a8e8c4' }}>{st.vnc_url}</code>
        </div>
      )}

      <div style={{ flex: 1, overflowY: 'auto', border: '1px solid #1d4030', background: '#0c0c0c' }}>
        <div style={{ color: '#7fbf9a', fontSize: 12, padding: '6px 8px' }}>
          Decoded calls <span style={{ color: '#4d7a62' }}>({recent.length})</span>
        </div>
        {recent.length === 0 ? (
          <div style={{ color: '#4d7a62', padding: 12 }}>
            {active ? 'Waiting for the control channel to grant a call…' : 'Switch to Trunk mode to begin decoding.'}
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12, fontFamily: 'inherit' }}>
            <thead>
              <tr style={{ color: '#00b95f', textAlign: 'left' }}>
                {cols.map(c => <th key={c} style={{ padding: '4px 8px', borderBottom: '1px solid #0d2418' }}>{c}</th>)}
              </tr>
            </thead>
            <tbody>
              {recent.slice().reverse().map((row, i) => (
                <tr key={i} style={{ color: row._encrypted ? '#f66' : '#a8e8c4' }}>
                  {cols.map(c => (
                    <td key={c} style={{ padding: '3px 8px', borderBottom: '1px solid #07120c', whiteSpace: 'nowrap' }}>
                      {row._encrypted && c === cols[0] && '🔒 '}{String(row[c] ?? '')}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          </div>
        )}
      </div>
    </div>
  )
}
