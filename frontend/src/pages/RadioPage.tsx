import { useEffect, useState } from 'react'

interface RadioStatus {
  open: boolean
  ready: boolean
  tx_enable: boolean
  callsign: string
  serial: string
  audio?: string
  keyed?: boolean
  station?: { callsign?: string; ssid?: number; comment?: string }
}

export default function RadioPage() {
  const [st, setSt]   = useState<RadioStatus | null>(null)
  const [msg, setMsg] = useState('')
  const [busy, setBusy] = useState(false)

  function refresh() {
    fetch('/api/radio/status').then(r => r.json()).then(setSt).catch(() => {})
  }
  useEffect(() => { refresh(); const id = setInterval(refresh, 3000); return () => clearInterval(id) }, [])

  async function post(path: string) {
    setBusy(true)
    setMsg('')
    try {
      const r = await fetch(path, { method: 'POST' })
      const d = await r.json()
      setMsg(r.ok ? `✓ ${JSON.stringify(d)}` : `✗ ${d.detail || 'error'}`)
    } catch {
      setMsg('✗ request failed')
    }
    setBusy(false)
    refresh()
  }

  const ready = st?.ready
  const dot = (ok: boolean) => <span style={{ color: ok ? '#33ff66' : '#ff5555' }}>{ok ? '●' : '○'}</span>

  return (
    <div style={{ padding: 16, maxWidth: 620 }}>
      <div className="header" style={{ marginBottom: 12 }}>
        <span className="header-title">📻 Radio TX — Digirig</span>
        <span className={'badge ' + (ready ? 'badge-green' : 'badge-red')}>
          {ready ? '● TX READY' : '○ TX DISABLED'}
        </span>
      </div>

      {!ready && (
        <div style={{ padding: 10, background: '#221a10', border: '1px solid #ff8844', color: '#ffb070', marginBottom: 14, fontSize: 13, lineHeight: 1.5 }}>
          <b>Transmit is gated off.</b> To enable, in <code>config.yaml</code>:
          set <code>station.callsign</code> to your callsign and
          <code> radio.tx_enable: true</code>, then restart the service.
          Transmitting without a valid callsign is illegal.
        </div>
      )}

      {st && (
        <table style={{ fontSize: 13, borderSpacing: '12px 4px' }}>
          <tbody>
            <tr><td style={{ color: '#888' }}>Serial port</td><td>{dot(st.open)} {st.serial}</td></tr>
            <tr><td style={{ color: '#888' }}>Audio device</td><td>{st.audio || '—'}</td></tr>
            <tr><td style={{ color: '#888' }}>Callsign</td><td>{st.callsign || <span style={{ color: '#ff5555' }}>not set</span>}</td></tr>
            <tr><td style={{ color: '#888' }}>tx_enable</td><td>{dot(st.tx_enable)} {String(st.tx_enable)}</td></tr>
            <tr><td style={{ color: '#888' }}>PTT keyed</td><td>{dot(!!st.keyed)} {st.keyed ? 'TRANSMITTING' : 'idle'}</td></tr>
          </tbody>
        </table>
      )}

      <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
        <button className="btn" disabled={!ready || busy} onClick={() => post('/api/radio/ptt_test?seconds=1.5')}>
          PTT test (1.5s carrier)
        </button>
        <button className="btn" disabled={!ready || busy} onClick={() => post('/api/radio/tone?freq=1000&seconds=2')}>
          1 kHz tone (2s)
        </button>
      </div>

      <p style={{ color: '#888', fontSize: 12, marginTop: 10, lineHeight: 1.5 }}>
        PTT test keys an unmodulated carrier — watch the radio's TX LED to confirm the Digirig RTS line works.
        The tone keys + plays 1 kHz out the Digirig; set deviation with <code>alsamixer</code> while listening on a second radio.
        RX only on RTL-SDR modes — this page drives the Digirig + radio only.
      </p>

      {msg && <pre style={{ color: msg.startsWith('✓') ? '#33ff66' : '#ff5555', fontSize: 12, marginTop: 8 }}>{msg}</pre>}
    </div>
  )
}
