import { useRef, useState } from 'react'

type Status = 'stopped' | 'connecting' | 'streaming'

export default function AudioPlayer() {
  const [status,  setStatus]  = useState<Status>('stopped')
  const [buffered, setBuffered] = useState(0)   // ms currently queued
  const ctxRef    = useRef<AudioContext | null>(null)
  const wsRef     = useRef<WebSocket | null>(null)
  const workletRef = useRef<AudioWorkletNode | null>(null)
  const ratioRef  = useRef(6)   // resample ratio: ctx.sampleRate / 8000

  async function start() {
    setStatus('connecting')

    const ctx = new AudioContext()
    ctxRef.current = ctx
    ratioRef.current = ctx.sampleRate / 8000

    // Load worklet module
    try {
      await ctx.audioWorklet.addModule('/audio-processor.js')
    } catch (err) {
      console.error('AudioWorklet load failed:', err)
      ctx.close()
      setStatus('stopped')
      return
    }

    // ~150 ms of audio at context rate before starting playback
    const targetSamples = Math.round(ctx.sampleRate * 0.15)

    const worklet = new AudioWorkletNode(ctx, 'pcm-processor', {
      processorOptions: { targetSamples },
    })
    worklet.connect(ctx.destination)
    workletRef.current = worklet

    // Open WebSocket for raw PCM
    const ws = new WebSocket(`ws://${location.host}/ws/audio`)
    ws.binaryType = 'arraybuffer'
    wsRef.current  = ws

    ws.onopen  = () => setStatus('streaming')
    ws.onclose = () => setStatus('stopped')
    ws.onerror = () => setStatus('stopped')

    ws.onmessage = e => {
      const i16   = new Int16Array(e.data)
      const ratio = ratioRef.current
      const out   = new Float32Array(Math.round(i16.length * ratio))

      // Linear-interpolation resample: 8 kHz → ctx.sampleRate
      for (let i = 0; i < out.length; i++) {
        const src = i / ratio
        const lo  = src | 0
        const hi  = lo + 1 < i16.length ? lo + 1 : lo
        const t   = src - lo
        out[i]    = (i16[lo] + t * (i16[hi] - i16[lo])) / 32768
      }

      // Transfer buffer ownership to worklet (zero-copy)
      worklet.port.postMessage(out, [out.buffer])

      // Approximate buffer depth for display only
      setBuffered(Math.round(i16.length / 8))   // ms at 8 kHz
    }
  }

  function stop() {
    wsRef.current?.close()
    workletRef.current?.port.postMessage('reset')
    ctxRef.current?.close()
    ctxRef.current  = null
    workletRef.current = null
    setStatus('stopped')
    setBuffered(0)
  }

  const dot: Record<Status, string> = {
    stopped:    '#888',
    connecting: '#ffaa00',
    streaming:  '#00ff88',
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
      <div className="status-line" style={{ marginTop: 8 }}>
        AudioWorklet · {Math.round((ctxRef.current?.sampleRate ?? 48000) / 1000)} kHz
      </div>
      {status === 'streaming' && buffered > 0 && (
        <div className="status-line">{buffered} ms/chunk</div>
      )}
    </div>
  )
}
