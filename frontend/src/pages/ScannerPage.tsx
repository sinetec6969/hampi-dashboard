import { wsUrl } from '../ws'
import { useState, useEffect, useRef, useCallback } from 'react'
import AudioPlayer from '../components/AudioPlayer'
import Waterfall from '../components/Waterfall'

interface Channel {
  freq:  number
  label: string
  mode:  'AM' | 'FM'
}

interface ScannerStatus {
  enabled:      boolean
  active_idx:   number
  channel:      Channel | null
  squelch_open: boolean
  scanner_on:   boolean
  squelch_am:   number
  squelch_fm:   number
  dwell_ms:     number
  hold_s:       number
  level:        number
  channels:     Channel[]
}

const DEFAULT_STATUS: ScannerStatus = {
  enabled:      false,
  active_idx:   0,
  channel:      null,
  squelch_open: false,
  scanner_on:   true,
  squelch_am:   0.01,
  squelch_fm:   0.05,
  dwell_ms:     2000,
  hold_s:       1.0,
  level:        0,
  channels:     [],
}

function fmtFreq(hz: number): string {
  return (hz / 1e6).toFixed(4) + ' MHz'
}

export default function ScannerPage() {
  const [status, setStatus]   = useState<ScannerStatus>(DEFAULT_STATUS)
  const [sqAm, setSqAm]       = useState(0.01)
  const [sqFm, setSqFm]       = useState(0.05)
  const [dwell, setDwell]     = useState(2000)
  const [hold, setHold]       = useState(1.0)
  const [ini, setIni]         = useState('')
  const [iniOpen, setIniOpen] = useState(false)
  const [iniMsg, setIniMsg]   = useState<{ ok: boolean; text: string } | null>(null)
  const wsRef                 = useRef<WebSocket | null>(null)
  const fileRef               = useRef<HTMLInputElement | null>(null)

  // -----------------------------------------------------------------------
  // WebSocket for status updates
  // -----------------------------------------------------------------------
  const aliveRef = useRef(true)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const applyStatus = useCallback((s: Partial<ScannerStatus>) => {
    setStatus(prev => ({ ...prev, ...s }))
    if (s.squelch_am !== undefined) setSqAm(s.squelch_am)
    if (s.squelch_fm !== undefined) setSqFm(s.squelch_fm)
    if (s.dwell_ms   !== undefined) setDwell(s.dwell_ms)
    if (s.hold_s     !== undefined) setHold(s.hold_s)
  }, [])

  const connectWs = useCallback(() => {
    const ws = new WebSocket(wsUrl('/ws/scanner'))
    wsRef.current = ws

    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'status') applyStatus(msg)
        } catch { /* binary frames: ignore */ }
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      if (aliveRef.current) retryRef.current = setTimeout(connectWs, 3000)
    }
  }, [applyStatus])

  useEffect(() => {
    aliveRef.current = true
    connectWs()
    // Also poll REST on mount in case WS missed the initial status
    fetch('/api/scanner/status').then(r => r.json()).then(applyStatus).catch(() => {})
    fetch('/api/scanner/favorites')
      .then(r => r.json())
      .then(d => setIni(d.ini))
      .catch(() => {})

    return () => {
      aliveRef.current = false
      if (retryRef.current) clearTimeout(retryRef.current)
      wsRef.current?.close()
    }
  }, [connectWs, applyStatus])

  // -----------------------------------------------------------------------
  // Controls
  // -----------------------------------------------------------------------
  async function toggleScanner() {
    const next = !status.scanner_on
    await fetch(`/api/scanner/scan?enabled=${next}`, { method: 'POST' })
    setStatus(prev => ({ ...prev, scanner_on: next }))
  }

  async function applySquelch(val: number, mode: 'AM' | 'FM') {
    if (mode === 'FM') setSqFm(val); else setSqAm(val)
    await fetch(`/api/scanner/squelch?level=${val}&mode=${mode}`, { method: 'POST' })
  }

  async function applyDwell(ms: number) {
    setDwell(ms)
    await fetch(`/api/scanner/dwell?ms=${ms}`, { method: 'POST' })
  }

  async function applyHold(s: number) {
    setHold(s)
    await fetch(`/api/scanner/hold?seconds=${s}`, { method: 'POST' })
  }

  async function lockChannel(idx: number) {
    await fetch(`/api/scanner/channel/${idx}`, { method: 'POST' })
  }

  // -----------------------------------------------------------------------
  // Favourites .ini
  // -----------------------------------------------------------------------
  async function saveIni(text: string) {
    const r = await fetch('/api/scanner/favorites', { method: 'POST', body: text })
    if (r.ok) {
      const d = await r.json()
      setStatus(prev => ({ ...prev, channels: d.channels }))
      setIniMsg({ ok: true, text: `Loaded ${d.channels.length} channels — saved to ${d.path}` })
    } else {
      const d = await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))
      setIniMsg({ ok: false, text: `Rejected: ${d.detail} — nothing was overwritten` })
    }
  }

  function uploadIni(file: File) {
    file.text().then(text => { setIni(text); saveIni(text) })
  }

  function downloadIni() {
    const url = URL.createObjectURL(new Blob([ini], { type: 'text/plain' }))
    const a = document.createElement('a')
    a.href = url
    a.download = 'scanner_favorites.ini'
    a.click()
    URL.revokeObjectURL(url)
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  const { enabled, active_idx, squelch_open, scanner_on, channels, channel, level } = status
  const curMode = channel?.mode ?? 'AM'
  const curSq   = curMode === 'FM' ? sqFm : sqAm
  const meterPct = Math.min(100, (level / Math.max(curSq * 3, 1e-6)) * 100)

  return (
    <div className="scanner-page">
      {/* Header */}
      <div className="scanner-header">
        <span className="scanner-title">┌─ SCANNER AM/FM</span>
        <div className="scanner-header-right">
          {enabled ? (
            <>
              <span className="scanner-now">
                {channel ? `${channel.label} · ${fmtFreq(channel.freq)} ${channel.mode}` : '—'}
              </span>
              <span className={`scanner-squelch-dot ${squelch_open ? 'open' : ''}`} title={squelch_open ? 'Squelch open' : 'Squelch closed'} />
              <button className="btn" onClick={toggleScanner} style={{ fontSize: '0.75rem', padding: '3px 10px' }}>
                {scanner_on ? '⏸ Scanner ON' : '▶ Scanner OFF'}
              </button>
            </>
          ) : (
            <span className="scanner-disabled-badge">Not running — switch device 0 to Scanner on the home page</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="scanner-body">
        {/* Left — frequency list */}
        <div className="scanner-freqlist">
          <div className="panel-title">
            Favourites <span style={{ color: '#4d7a62' }}>({channels.length})</span>
          </div>
          {channels.length === 0 ? (
            <div className="scanner-no-channels">
              No channels yet — load a favourites .ini below
            </div>
          ) : (
            channels.map((ch, i) => (
              <div
                key={i}
                className={`scanner-ch-row ${i === active_idx ? 'active' : ''} ${i === active_idx && squelch_open ? 'rx' : ''}`}
                onClick={() => lockChannel(i)}
                title="Click to lock"
              >
                <span className="scanner-ch-indicator">
                  {i === active_idx && squelch_open ? '●' : i === active_idx ? '○' : ' '}
                </span>
                <span className={`scanner-ch-mode ${ch.mode.toLowerCase()}`}>{ch.mode}</span>
                <span className="scanner-ch-label">{ch.label}</span>
                <span className="scanner-ch-freq">{fmtFreq(ch.freq)}</span>
              </div>
            ))
          )}
        </div>

        {/* Right — waterfall + controls + audio */}
        <div className="scanner-controls">
          <div className="scanner-waterfall">
            <Waterfall
              centerFreqHz={channel?.freq ?? 0}
              wsPath="/ws/scanner/waterfall"
              palette="green"
            />
          </div>
          <div className="scanner-wf-caption">
            2.4 MHz around the channel in view — it jumps on every retune, that's the scan.
          </div>

          <AudioPlayer wsPath="/ws/scanner" inputRate={48000} label="Scanner Audio" auto />

          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-title">Signal — {curMode} channel</div>
            <div className="scanner-meter">
              <div className="scanner-meter-fill" style={{ width: `${meterPct}%` }} />
              <div className="scanner-meter-thresh" style={{ left: `${Math.min(100, 33.3)}%` }} />
            </div>
            <div style={{ fontSize: '0.7rem', color: '#4d7a62', marginTop: 4 }}>
              level {level.toFixed(4)} · opens above {curSq.toFixed(3)} (marker)
            </div>
          </div>

          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-title">AM Squelch</div>
            <div className="scanner-slider-row">
              <input type="range" min={0} max={0.1} step={0.001} value={sqAm}
                     onChange={e => applySquelch(parseFloat(e.target.value), 'AM')} />
              <span className="scanner-slider-val">{sqAm.toFixed(3)}</span>
            </div>
            <div className="panel-title" style={{ marginTop: 10 }}>FM Squelch</div>
            <div className="scanner-slider-row">
              <input type="range" min={0} max={0.3} step={0.005} value={sqFm}
                     onChange={e => applySquelch(parseFloat(e.target.value), 'FM')} />
              <span className="scanner-slider-val">{sqFm.toFixed(3)}</span>
            </div>
            <div style={{ marginTop: 6, fontSize: '0.7rem', color: '#4d7a62' }}>
              Two thresholds because the metrics differ: AM squelches on modulation
              depth, FM on carrier strength.
            </div>
          </div>

          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-title">Dwell — time on a quiet channel</div>
            <div className="scanner-slider-row">
              <input type="range" min={500} max={10000} step={250} value={dwell}
                     onChange={e => applyDwell(parseInt(e.target.value))} />
              <span className="scanner-slider-val">{(dwell / 1000).toFixed(2)} s</span>
            </div>
            <div className="panel-title" style={{ marginTop: 10 }}>Hold — after a signal drops</div>
            <div className="scanner-slider-row">
              <input type="range" min={0} max={15} step={0.5} value={hold}
                     onChange={e => applyHold(parseFloat(e.target.value))} />
              <span className="scanner-slider-val">{hold.toFixed(1)} s</span>
            </div>
            <div style={{ marginTop: 6, fontSize: '0.7rem', color: '#4d7a62' }}>
              Dwell change applies at the next channel rotation.
            </div>
          </div>

          {/* Favourites editor */}
          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-title" style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Favourites .ini</span>
              <button className="btn" style={{ fontSize: '0.7rem', padding: '2px 8px' }}
                      onClick={() => setIniOpen(o => !o)}>
                {iniOpen ? 'Hide' : 'Edit'}
              </button>
            </div>

            <div className="scanner-ini-actions">
              <button className="btn" onClick={() => fileRef.current?.click()}>Upload…</button>
              <button className="btn" onClick={downloadIni}>Download</button>
              <input ref={fileRef} type="file" accept=".ini,text/plain" style={{ display: 'none' }}
                     onChange={e => { const f = e.target.files?.[0]; if (f) uploadIni(f); e.target.value = '' }} />
            </div>

            {iniOpen && (
              <>
                <textarea className="scanner-ini-text" spellCheck={false}
                          value={ini} onChange={e => setIni(e.target.value)} />
                <div className="scanner-ini-actions">
                  <button className="btn" onClick={() => saveIni(ini)}>Save &amp; load</button>
                  <button className="btn" onClick={() => {
                    fetch('/api/scanner/favorites').then(r => r.json())
                      .then(d => { setIni(d.ini); setIniMsg(null) }).catch(() => {})
                  }}>Revert</button>
                </div>
              </>
            )}

            {iniMsg && (
              <div className={`scanner-ini-msg ${iniMsg.ok ? 'ok' : 'err'}`}>{iniMsg.text}</div>
            )}

            <div style={{ marginTop: 6, fontSize: '0.7rem', color: '#4d7a62', lineHeight: 1.6 }}>
              One <code>[Section]</code> per channel — the section name is the label.
              <code>freq</code> in MHz (or Hz), <code>mode</code> is AM or FM and is
              inferred from the band if you leave it out.
            </div>
          </div>

          {!enabled && (
            <div className="scanner-setup-hint">
              <div className="panel-title" style={{ marginBottom: 6 }}>Two ways to run this</div>
              <p>One dongle: flip the SDR switcher on the home page to <b>Scanner</b>. DMR pauses while you listen.</p>
              <p style={{ marginTop: 6 }}>Two dongles: give the scanner its own in <code>config.yaml</code> (<code>scanner.rtl_device: 1</code>) and it runs alongside DMR all the time.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
