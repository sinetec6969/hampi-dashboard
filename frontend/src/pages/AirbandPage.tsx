import { wsUrl } from '../ws'
import { useState, useEffect, useRef, useCallback } from 'react'
import AudioPlayer from '../components/AudioPlayer'

interface Channel {
  freq:  number
  label: string
}

interface AirbandStatus {
  enabled:      boolean
  active_idx:   number
  channel:      Channel | null
  squelch_open: boolean
  scanner_on:   boolean
  squelch:      number
  dwell_ms:     number
  channels:     Channel[]
}

const DEFAULT_STATUS: AirbandStatus = {
  enabled:      false,
  active_idx:   0,
  channel:      null,
  squelch_open: false,
  scanner_on:   true,
  squelch:      0.01,
  dwell_ms:     2000,
  channels:     [],
}

function fmtFreq(hz: number): string {
  return (hz / 1e6).toFixed(3) + ' MHz'
}

export default function AirbandPage() {
  const [status, setStatus]     = useState<AirbandStatus>(DEFAULT_STATUS)
  const [squelch, setSquelch]   = useState(0.01)
  const [dwell, setDwell]       = useState(2000)
  const wsRef                   = useRef<WebSocket | null>(null)

  // -----------------------------------------------------------------------
  // WebSocket for status updates
  // -----------------------------------------------------------------------
  const aliveRef = useRef(true)
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const connectWs = useCallback(() => {
    const ws = new WebSocket(wsUrl('/ws/airband'))
    wsRef.current = ws

    ws.onmessage = e => {
      if (typeof e.data === 'string') {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'status') {
            setStatus(prev => ({ ...prev, ...msg }))
            if (msg.squelch  !== undefined) setSquelch(msg.squelch)
            if (msg.dwell_ms !== undefined) setDwell(msg.dwell_ms)
          }
        } catch { /* binary frames: ignore */ }
      }
    }

    ws.onclose = () => {
      wsRef.current = null
      if (aliveRef.current) retryRef.current = setTimeout(connectWs, 3000)
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    connectWs()
    // Also poll REST on mount in case WS missed the initial status
    fetch('/api/airband/status')
      .then(r => r.json())
      .then((s: AirbandStatus) => {
        setStatus(s)
        setSquelch(s.squelch)
        setDwell(s.dwell_ms)
      })
      .catch(() => {})

    return () => {
      aliveRef.current = false
      if (retryRef.current) clearTimeout(retryRef.current)
      wsRef.current?.close()
    }
  }, [connectWs])

  // -----------------------------------------------------------------------
  // Controls
  // -----------------------------------------------------------------------
  async function toggleScanner() {
    const next = !status.scanner_on
    await fetch(`/api/airband/scan?enabled=${next}`, { method: 'POST' })
    setStatus(prev => ({ ...prev, scanner_on: next }))
  }

  async function applySquelch(val: number) {
    setSquelch(val)
    await fetch(`/api/airband/squelch?level=${val}`, { method: 'POST' })
  }

  async function lockChannel(idx: number) {
    await fetch(`/api/airband/channel/${idx}`, { method: 'POST' })
  }

  // -----------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------
  const { enabled, active_idx, squelch_open, scanner_on, channels } = status

  return (
    <div className="airband-page">
      {/* Header */}
      <div className="airband-header">
        <span className="airband-title">🛩 Airband AM</span>
        <div className="airband-header-right">
          {enabled ? (
            <>
              <span className={`airband-squelch-dot ${squelch_open ? 'open' : ''}`} title={squelch_open ? 'Squelch open' : 'Squelch closed'} />
              <button className="btn" onClick={toggleScanner} style={{ fontSize: '0.75rem', padding: '3px 10px' }}>
                {scanner_on ? '⏸ Scanner ON' : '▶ Scanner OFF'}
              </button>
            </>
          ) : (
            <span className="airband-disabled-badge">No SDR device — set AIRBAND_RTL_DEV</span>
          )}
        </div>
      </div>

      {/* Body */}
      <div className="airband-body">
        {/* Left — frequency list */}
        <div className="airband-freqlist">
          <div className="panel-title">Frequencies</div>
          {channels.length === 0 ? (
            <div className="airband-no-channels">No channels configured</div>
          ) : (
            channels.map((ch, i) => (
              <div
                key={i}
                className={`airband-ch-row ${i === active_idx ? 'active' : ''} ${i === active_idx && squelch_open ? 'rx' : ''}`}
                onClick={() => lockChannel(i)}
                title="Click to lock"
              >
                <span className="airband-ch-indicator">
                  {i === active_idx && squelch_open ? '●' : i === active_idx ? '○' : ' '}
                </span>
                <span className="airband-ch-label">{ch.label}</span>
                <span className="airband-ch-freq">{fmtFreq(ch.freq)}</span>
              </div>
            ))
          )}
        </div>

        {/* Right — controls + audio */}
        <div className="airband-controls">
          <AudioPlayer wsPath="/ws/airband" inputRate={48000} label="Airband Audio" />

          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-title">Squelch</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <input
                type="range"
                min={0} max={0.1} step={0.001}
                value={squelch}
                onChange={e => applySquelch(parseFloat(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: '0.72rem', color: '#888', minWidth: 36 }}>
                {squelch.toFixed(3)}
              </span>
            </div>
          </div>

          <div className="panel" style={{ marginTop: 8 }}>
            <div className="panel-title">Scanner Dwell</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
              <input
                type="range"
                min={500} max={10000} step={500}
                value={dwell}
                onChange={e => setDwell(parseInt(e.target.value))}
                style={{ flex: 1 }}
              />
              <span style={{ fontSize: '0.72rem', color: '#888', minWidth: 42 }}>
                {(dwell / 1000).toFixed(1)} s
              </span>
            </div>
            <div style={{ marginTop: 6, fontSize: '0.7rem', color: '#555' }}>
              Dwell changes apply after next channel rotation
            </div>
          </div>

          {!enabled && (
            <div className="airband-setup-hint">
              <div className="panel-title" style={{ marginBottom: 6 }}>Setup</div>
              <p>Airband scanner needs a second RTL-SDR dongle.</p>
              <p>Restart the server with:</p>
              <code>AIRBAND_RTL_DEV=1 AIRBAND_ENABLE=1</code>
              <p style={{ marginTop: 6 }}>Single-dongle: use <code>AIRBAND_RTL_DEV=0</code> but DMR and airband cannot run simultaneously.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
