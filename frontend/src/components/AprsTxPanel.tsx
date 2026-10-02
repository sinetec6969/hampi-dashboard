import { useEffect, useState } from 'react'
import { Radio, Send, TriangleAlert, ChevronDown, ChevronRight, Network } from 'lucide-react'
import { StatusBadge, Button } from './ui'

interface TxStatus {
  ready: boolean; tx_enable: boolean; callsign: string; mycall?: string
  ptt_present: boolean; last_desc?: string
  station?: { callsign?: string; ssid?: number; lat?: number; lon?: number; comment?: string }
}
interface Tnc { port: number; lan_enabled: boolean; active: boolean; hint: string }

export default function AprsTxPanel() {
  const [open, setOpen] = useState(false)
  const [st, setSt] = useState<TxStatus | null>(null)
  const [tnc, setTnc] = useState<Tnc | null>(null)
  const [to, setTo] = useState('')
  const [text, setText] = useState('')
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  function refresh() {
    fetch('/api/aprs/tx/status').then(r => r.json()).then(setSt).catch(() => {})
    fetch('/api/aprs/tnc').then(r => r.json()).then(setTnc).catch(() => {})
  }
  useEffect(() => { refresh() }, [])

  async function post(path: string, body?: object) {
    setBusy(true); setMsg('')
    try {
      const r = await fetch(path, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      const d = await r.json()
      setMsg(r.ok ? `Sent: ${d.desc ?? 'ok'}` : `${d.detail ?? 'error'}`)
    } catch { setMsg('request failed') }
    setBusy(false); refresh()
  }

  const ready = st?.ready

  return (
    <div className="aprs-tx">
      <button className="aprs-tx-bar" onClick={() => setOpen(v => !v)}>
        {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
        <Radio size={15} />
        <span className="aprs-tx-title">Transmit &amp; TNC</span>
        {ready ? <StatusBadge tone="amber">TX armed</StatusBadge> : <StatusBadge tone="gray">TX disabled</StatusBadge>}
        {tnc && <span className="aprs-tnc-chip"><Network size={13} /> KISS :{tnc.port} {tnc.lan_enabled ? 'LAN' : 'local'}</span>}
      </button>

      {open && (
        <div className="aprs-tx-body">
          {!ready && (
            <div className="notice amber">
              <TriangleAlert />
              <span>
                Transmit is gated off. Set <code>station.callsign</code> and <code>radio.tx_enable: true</code> in
                config.yaml, plug in the Digirig, then restart. Transmitting without a valid callsign is illegal.
                {st && !st.ptt_present && <> PTT device not present.</>}
              </span>
            </div>
          )}

          <div className="aprs-tx-row">
            <span className="metric-label">Station</span>
            <span className="mono">{st?.mycall || st?.callsign || '—'}</span>
            {st?.station?.lat != null && <span className="muted mono">{st.station.lat}, {st.station.lon}</span>}
            <Button size="sm" icon={<Radio />} disabled={!ready || busy} onClick={() => post('/api/aprs/tx/beacon')}>
              Send position beacon
            </Button>
          </div>

          <div className="aprs-tx-row">
            <span className="metric-label">Message</span>
            <input value={to} onChange={e => setTo(e.target.value)} placeholder="TO callsign"
              style={{ width: 130 }} maxLength={9} aria-label="Addressee" />
            <input value={text} onChange={e => setText(e.target.value)} placeholder="message text"
              style={{ flex: 1, minWidth: 120 }} maxLength={67} aria-label="Message text" />
            <Button size="sm" icon={<Send />} disabled={!ready || busy || !to.trim() || !text.trim()}
              onClick={() => post('/api/aprs/tx/message', { addressee: to, text })}>Send</Button>
          </div>

          {msg && <div className="aprs-tx-msg mono">{msg}</div>}

          <div className="aprs-tnc-info">
            <Network size={14} />
            <span>{tnc?.hint ?? 'KISS TNC on :8001 while SDR 0 is in APRS mode'}</span>
            {tnc && !tnc.lan_enabled && <span className="muted"> — LAN access off; set <code>aprs.kiss_lan: true</code> + <code>deploy/harden-kiss.sh allow</code>.</span>}
          </div>
        </div>
      )}
    </div>
  )
}
