import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'
import Waterfall from '../components/Waterfall'
import Controls from '../components/Controls'

interface Frame {
  ts:   number
  src:  string
  dst:  string
  via:  string[]
  type: string
  pid:  string | null
  info: string
  hex:  string
  len:  number
}

function hhmmss(ts: number): string {
  return new Date(ts * 1000).toTimeString().slice(0, 8)
}

function frameLine(f: Frame): string {
  const via = f.via.length ? ',' + f.via.join(',') : ''
  const pid = f.pid ? ` pid=${f.pid}` : ''
  return `${hhmmss(f.ts)}  ${f.src}>${f.dst}${via} <${f.type}${pid}> ${f.info}`
}

export default function AX25Page() {
  const [freq, setFreq]         = useState(144390000)
  const [gain, setGain]         = useState(49.6)
  const [tuneMsg, setTuneMsg]   = useState('')
  const [frames, setFrames]     = useState<Frame[]>([])
  const [sdrMode, setSdrMode]   = useState('')
  const [kissUp, setKissUp]     = useState(false)
  const [switching, setSwitching] = useState(false)
  const wsRef  = useRef<WebSocket | null>(null)
  const endRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(d => { setFreq(d.freq); setGain(d.gain) }).catch(() => {})
    fetch('/api/sdr/mode').then(r => r.json()).then(d => setSdrMode(d.mode)).catch(() => {})
    fetch('/api/ax25/frames').then(r => r.json())
      .then((list: Frame[]) => setFrames(list.reverse()))
      .catch(() => {})

    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/ax25'))
      wsRef.current = ws
      ws.onclose = () => { setKissUp(false); if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('AX25 WS error')
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'frame') setFrames(prev => [...prev, msg.frame].slice(-500))
          else if (msg.type === 'status') setKissUp(msg.connected)
        } catch {}
      }
    }
    connect()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  useEffect(() => { endRef.current?.scrollIntoView({ behavior: 'auto' }) }, [frames])

  async function tuneTo(f: number, g: number) {
    const r = await fetch(`/api/tune?freq=${f}&gain=${g}`, { method: 'POST' })
    if (r.ok) {
      setFreq(f)
      setGain(g)
      setTuneMsg('Tuned ✓')
      setTimeout(() => setTuneMsg(''), 2000)
    } else {
      setTuneMsg('Error')
    }
  }

  async function enableAprsMode() {
    setSwitching(true)
    try {
      const r = await fetch('/api/sdr/mode?mode=aprs', { method: 'POST' })
      const d = await r.json()
      setSdrMode(d.mode)
    } catch {}
    setSwitching(false)
  }

  const active = sdrMode === 'aprs'

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 8 }}>
      <div className="header">
        <span className="header-title">📟 AX.25 Terminal</span>
        <span className="header-freq">{(freq / 1e6).toFixed(4)} MHz</span>
        <Controls
          freq={freq} gain={gain}
          onFreqChange={setFreq} onGainChange={setGain}
          onTune={tuneTo} msg={tuneMsg}
        />
        <span className={'badge ' + (active && kissUp ? 'badge-green' : 'badge-red')}>
          {active && kissUp ? '● KISS' : '○ KISS'}
        </span>
        <span className="badge" style={{ color: '#ff8844', borderColor: '#ff8844' }}>
          RX only — TX lands with Phase A (Digirig)
        </span>
      </div>

      {!active && (
        <div style={{ padding: 8, background: '#221a10', border: '1px solid #ff8844', color: '#ff8844' }}>
          AX.25 rides the APRS-mode direwolf — SDR is in "{sdrMode || '…'}" mode.{' '}
          <button className="btn" onClick={enableAprsMode} disabled={switching}>
            {switching ? 'switching…' : 'Switch to APRS mode'}
          </button>
        </div>
      )}

      <div style={{ height: 200, flexShrink: 0 }}>
        <Waterfall centerFreqHz={freq} onClickTune={f => tuneTo(f, gain)} />
      </div>

      <div style={{
        flex: 1, minHeight: 120, overflowY: 'auto', background: '#000',
        border: '1px solid #333', padding: 8, fontSize: 12,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all', color: '#33ff66',
      }}>
        {frames.length === 0 ? (
          <span style={{ color: '#555' }}>
            {active
              ? 'Monitoring. Frames print here as direwolf decodes them — click the waterfall or type a frequency to retune the whole chain. Zero frames on a 70cm whip is normal; 2m antenna pending.'
              : 'The terminal wakes up in APRS mode — one direwolf feeds both pages.'}
          </span>
        ) : (
          frames.map((f, i) => <div key={i}>{frameLine(f)}</div>)
        )}
        <div ref={endRef} />
      </div>
    </div>
  )
}
