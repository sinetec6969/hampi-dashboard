import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'

type Status = 'stopped' | 'connecting' | 'streaming'
type Mode   = 'worklet' | 'scheduled'

interface Props {
  wsPath?:       string   // default: '/ws/audio'
  inputRate?:    number   // default: 8000  (Hz of incoming PCM)
  label?:        string   // default: 'Audio'
  auto?:         boolean  // connect on mount, no start/stop buttons
}

export default function AudioPlayer({ wsPath = '/ws/audio', inputRate = 8000, label = 'Audio',
                                      auto = false }: Props) {
  const [status, setStatus] = useState<Status>('stopped')
  const [mode,   setMode]   = useState<Mode>('worklet')
  const [err,    setErr]    = useState('')
  const [stats,  setStats]  = useState<{depth_ms: number, target_ms: number, underruns: number} | null>(null)

  const ctxRef     = useRef<AudioContext | null>(null)
  const wsRef      = useRef<WebSocket | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const nextTimeRef = useRef(0)

  // -----------------------------------------------------------------------
  // Worklet path (secure context: HTTPS or localhost)
  // -----------------------------------------------------------------------
  async function startWorklet(ctx: AudioContext) {
    await ctx.audioWorklet.addModule('/audio-processor.js')

    const targetSamples = Math.round(ctx.sampleRate * 0.15)
    const worklet = new AudioWorkletNode(ctx, 'pcm-processor', {
      processorOptions: { targetSamples },
    })
    worklet.connect(ctx.destination)
    worklet.port.onmessage = ({ data }) => {
      if (data && typeof data.depth_ms === 'number') setStats(data)
    }
    workletRef.current = worklet

    const ratio = ctx.sampleRate / inputRate

    const ws = new WebSocket(wsUrl(wsPath))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen  = () => { setStatus('streaming'); setMode('worklet') }
    ws.onclose = () => setStatus('stopped')
    ws.onerror = () => setStatus('stopped')

    ws.onmessage = e => {
      if (!(e.data instanceof ArrayBuffer)) return  // skip JSON status frames
      const i16 = new Int16Array(e.data)
      const out = new Float32Array(Math.round(i16.length * ratio))
      for (let i = 0; i < out.length; i++) {
        const src = i / ratio
        const lo  = src | 0
        const hi  = lo + 1 < i16.length ? lo + 1 : lo
        out[i]    = (i16[lo] + (src - lo) * (i16[hi] - i16[lo])) / 32768
      }
      worklet.port.postMessage(out, [out.buffer])
    }
  }

  // -----------------------------------------------------------------------
  // Scheduled-buffer fallback (HTTP non-localhost)
  // -----------------------------------------------------------------------
  function startScheduled(ctx: AudioContext) {
    // 200 ms margin: dsd-fme emits audio in bursts with gaps up to ~106 ms
    // (measured), plus browser-side network jitter on top.
    nextTimeRef.current = ctx.currentTime + 0.2

    // Resample manually to ctx.sampleRate — don't rely on browser resampling
    // of AudioBuffer, which is inconsistent across Chromium/mobile builds and
    // causes the buffer to play at the wrong duty cycle (sounds like slomo).
    const ratio = ctx.sampleRate / inputRate

    const ws = new WebSocket(wsUrl(wsPath))
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen  = () => { setStatus('streaming'); setMode('scheduled') }
    ws.onclose = () => setStatus('stopped')
    ws.onerror = () => setStatus('stopped')

    ws.onmessage = e => {
      if (!(e.data instanceof ArrayBuffer)) return  // skip JSON status frames
      const i16 = new Int16Array(e.data)
      const out = new Float32Array(Math.round(i16.length * ratio))
      for (let i = 0; i < out.length; i++) {
        const src = i / ratio
        const lo  = src | 0
        const hi  = lo + 1 < i16.length ? lo + 1 : lo
        out[i]    = (i16[lo] + (src - lo) * (i16[hi] - i16[lo])) / 32768
      }

      const buf = ctx.createBuffer(1, out.length, ctx.sampleRate)
      buf.getChannelData(0).set(out)

      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)

      const now = ctx.currentTime
      if (nextTimeRef.current < now) nextTimeRef.current = now + 0.1
      src.start(nextTimeRef.current)
      nextTimeRef.current += buf.duration
    }
  }

  // -----------------------------------------------------------------------
  // Entry point
  // -----------------------------------------------------------------------
  async function start() {
    setErr('')
    setStatus('connecting')

    let ctx: AudioContext
    try {
      ctx = new AudioContext()
      ctxRef.current = ctx
      await ctx.resume()
    } catch (e) {
      setErr('AudioContext failed')
      setStatus('stopped')
      return
    }

    // Use AudioWorklet on secure contexts; scheduled buffers everywhere else.
    // AudioWorklet.addModule() is blocked on plain HTTP from non-localhost.
    const secure = window.isSecureContext
    if (secure && ctx.audioWorklet) {
      try {
        await startWorklet(ctx)
        return
      } catch (e) {
        // Worklet failed — fall through to scheduled path
        workletRef.current = null
      }
    }

    // Fallback: scheduled AudioBufferSource (works on plain HTTP)
    try {
      startScheduled(ctx)
    } catch (e) {
      setErr('Audio start failed')
      setStatus('stopped')
    }
  }

  function stop() {
    wsRef.current?.close()
    workletRef.current?.port.postMessage('reset')
    ctxRef.current?.close()
    ctxRef.current  = null
    workletRef.current = null
    setStatus('stopped')
  }

  // Auto mode: connect on mount. A fresh AudioContext is suspended until a user
  // gesture, so the next click anywhere on the page — locking a channel, usually
  // — is what actually starts the sound.
  useEffect(() => {
    if (!auto) return
    start()
    const resume = () => { void ctxRef.current?.resume() }
    document.addEventListener('click', resume)
    document.addEventListener('keydown', resume)
    return () => {
      document.removeEventListener('click', resume)
      document.removeEventListener('keydown', resume)
      stop()
    }
  }, [auto])

  const dot: Record<Status, string> = {
    stopped: '#7fbf9a', connecting: '#ffaa00', streaming: '#00ff88',
  }

  return (
    <div className="panel" style={{ flex: '1' }}>
      <div className="panel-title">{label}</div>
      <div style={{ marginTop: 8 }}>
        <span style={{ color: dot[status], fontSize: '0.8rem', marginRight: 12 }}>
          ● {status}
        </span>
      </div>
      {!auto && (
        <div style={{ marginTop: 8 }}>
          {status === 'stopped'
            ? <button className="btn" onClick={start}>▶ Start</button>
            : <button className="btn stop" onClick={stop}>■ Stop</button>}
        </div>
      )}
      {status === 'streaming' && (
        <div className="status-line" style={{ marginTop: 8 }}>
          {mode === 'worklet' ? 'AudioWorklet' : 'scheduled'}
          {mode === 'worklet' && stats &&
            ` — buf ${stats.depth_ms}/${stats.target_ms}ms, underruns ${stats.underruns}`}
        </div>
      )}
      {err && (
        <div className="status-line" style={{ color: '#ff3355', marginTop: 4 }}>{err}</div>
      )}
    </div>
  )
}
