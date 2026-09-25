import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'

interface Status { running: boolean; freq: number; gain: number; count: number; last_log: string }
interface Page { ts: number; proto: string; addr: number | null; func: number | null; text: string }

export default function PagerPage() {
  const [st, setSt]       = useState<Status | null>(null)
  const [pages, setPages] = useState<Page[]>([])
  const [mode, setMode]   = useState('')
  const [busy, setBusy]   = useState(false)
  const [err, setErr]     = useState('')
  const [freqIn, setFreqIn] = useState('')
  const [gainIn, setGainIn] = useState('')
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch('/api/pager/status').then(r => r.json()).then((d: Status) => {
      setSt(d); setFreqIn((d.freq / 1e6).toFixed(4)); setGainIn(String(d.gain))
    }).catch(() => {})
    fetch('/api/pager/messages').then(r => r.json()).then((m: Page[]) => setPages(m.reverse())).catch(() => {})
    fetch('/api/sdr/mode').then(r => r.json()).then(d => setMode(d.mode)).catch(() => {})

    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/pager'))
      wsRef.current = ws
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('Pager WS error')
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'status') setSt(msg)
          else if (msg.type === 'page') setPages(prev => [msg, ...prev].slice(0, 300))
        } catch { /* */ }
      }
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); wsRef.current?.close() }
  }, [])

  async function enable() {
    setBusy(true)
    try { const r = await fetch('/api/sdr/mode?mode=pager', { method: 'POST' }); setMode((await r.json()).mode) } catch { /* */ }
    setBusy(false)
  }

  async function tune() {
    const mhz = parseFloat(freqIn)
    if (!isFinite(mhz) || mhz <= 0) return
    const g = parseFloat(gainIn)
    setBusy(true); setErr('')
    const q = `freq=${Math.round(mhz * 1e6)}` + (isFinite(g) ? `&gain=${g}` : '')
    try {
      const r = await fetch(`/api/pager/tune?${q}`, { method: 'POST' })
      const d = await r.json()
      if (r.ok) setSt(d)
      else setErr(d.detail ?? `HTTP ${r.status}`)
    } catch { setErr('lost the server mid-retune') }
    setBusy(false)
  }

  const active = mode === 'pager'
  const freq = st?.freq ?? 152007500

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10, padding: 12 }}>
      <div className="header">
        <span className="header-title">Pager</span>
        <span className="header-freq">{(freq / 1e6).toFixed(4)} MHz</span>
        <span className={'badge ' + (active && st?.running ? 'badge-green' : 'badge-red')}>
          {active && st?.running ? '● Listening' : '○ Idle'}
        </span>
        <span style={{ fontSize: 12, color: '#9aa5a0' }}>POCSAG 512/1200/2400 · FLEX</span>
        <span style={{ fontSize: 12, color: '#9aa5a0' }}>{st?.count ?? 0} pages</span>
      </div>

      {!active ? (
        <div className="mode-banner">
          Pager decode needs device 0 to itself (rtl_fm → multimon-ng). Switching stops the current mode and
          listens on {(freq / 1e6).toFixed(4)} MHz.{' '}
          <button className="btn" onClick={enable} disabled={busy}>{busy ? 'switching…' : 'Switch to PAGER mode'}</button>
        </div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, color: '#9aa5a0', flexWrap: 'wrap' }}>
          <span>FREQ</span>
          <input value={freqIn} onChange={e => setFreqIn(e.target.value)} onKeyDown={e => e.key === 'Enter' && tune()}
                 style={{ width: 100 }} /> MHz
          <span style={{ marginLeft: 8 }}>GAIN</span>
          <input value={gainIn} onChange={e => setGainIn(e.target.value)} onKeyDown={e => e.key === 'Enter' && tune()}
                 style={{ width: 50 }} /> dB
          <button className="btn" onClick={tune} disabled={busy}>{busy ? 'retuning…' : 'Tune'}</button>
          <span style={{ color: '#66716c' }}>US paging lives at 152–159 MHz (VHF) and 929–932 MHz (UHF, mostly FLEX).</span>
          {err && <span style={{ color: '#e05858' }}>{err}</span>}
        </div>
      )}

      {active && st?.last_log && (
        <div style={{ fontSize: 11, color: '#9aa5a0', background: '#000', border: '1px solid #252b2c', padding: '4px 8px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {st.last_log}
        </div>
      )}

      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', border: '1px solid #343c3d', background: '#0d1011' }}>
        {pages.length === 0 ? (
          <div style={{ color: '#66716c', padding: 12, fontSize: 13 }}>
            No pages yet. An active paging channel bursts every few seconds to minutes — if nothing lands in
            a couple of minutes, try another frequency.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ color: '#66716c', textAlign: 'left' }}>
                <th style={{ padding: '4px 10px' }}>TIME</th><th>PROTO</th><th>ADDR</th><th>FN</th><th>MESSAGE</th>
              </tr>
            </thead>
            <tbody>
              {pages.map((p, i) => (
                <tr key={i} style={{ borderTop: '1px solid #252b2c', color: '#cfd6d2', verticalAlign: 'top' }}>
                  <td style={{ padding: '4px 10px', color: '#8a9590', whiteSpace: 'nowrap' }}>{new Date(p.ts * 1000).toLocaleTimeString()}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>{p.proto}</td>
                  <td>{p.addr ?? '—'}</td>
                  <td>{p.func ?? ''}</td>
                  <td style={{ color: '#e7ece9', wordBreak: 'break-word' }}>{p.text || <span style={{ color: '#66716c' }}>(tone only)</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
