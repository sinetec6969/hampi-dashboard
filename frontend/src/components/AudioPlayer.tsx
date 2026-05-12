import { useRef, useState } from 'react'

type Status = 'stopped' | 'connecting' | 'streaming'
type Mode   = 'worklet' | 'scheduled'

export default function AudioPlayer() {
  const [status, setStatus] = useState<Status>('stopped')
  const [mode,   setMode]   = useState<Mode>('worklet')
  const [err,    setErr]    = useState('')

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
    workletRef.current = worklet

    const ratio = ctx.sampleRate / 8000

    const ws = new WebSocket(`ws://${location.host}/ws/audio`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen  = () => { setStatus('streaming'); setMode('worklet') }
    ws.onclose = () => setStatus('stopped')
    ws.onerror = () => setStatus('stopped')

    ws.onmessage = e => {
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
    nextTimeRef.current = ctx.currentTime + 0.5

    const ws = new WebSocket(`ws://${location.host}/ws/audio`)
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen  = () => { setStatus('streaming'); setMode('scheduled') }
    ws.onclose = () => setStatus('stopped')
    ws.onerror = () => setStatus('stopped')

    ws.onmessage = e => {
      const i16 = new Int16Array(e.data)
      const f32 = new Float32Array(i16.length)
      for (let i = 0; i < i16.length; i++) f32[i] = i16[i] / 32768

      const buf = ctx.createBuffer(1, f32.length, 8000)
      buf.getChannelData(0).set(f32)

      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)

      const now = ctx.currentTime
      if (nextTimeRef.current < now) nextTimeRef.current = now + 0.5
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

  const dot: Record<Status, string> = {
    stopped: '#888', connecting: '#ffaa00', streaming: '#00ff88',
  }

  return (
    <div className="panel" style={{ flex: '1' }}>
      <div className="panel-title">Audio</div>
      <div style={{ marginTop: 8 }}>
        <span style={{ color: dot[status], fontSize: '0.8rem', marginRight: 12 }}>
          ● {status}
        </span>
      </div>
      <div style={{ marginTop: 8 }}>
        {status === 'stopped'
          ? <button className="btn" onClick={start}>▶ Start</button>
          : <button className="btn stop" onClick={stop}>■ Stop</button>}
      </div>
      {status === 'streaming' && (
        <div className="status-line" style={{ marginTop: 8 }}>
          {mode === 'worklet' ? 'AudioWorklet' : 'scheduled'}
        </div>
      )}
      {err && (
        <div className="status-line" style={{ color: '#ff4444', marginTop: 4 }}>{err}</div>
      )}
    </div>
  )
}
