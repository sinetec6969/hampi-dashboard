import { useRef, useState } from 'react'

type Status = 'stopped'|'streaming'|'connecting'

export default function AudioPlayer() {
  const [status, setStatus] = useState<Status>('stopped')
  const [underruns, setUnderruns] = useState(0)
  const ctxRef = useRef<AudioContext|null>(null)
  const wsRef = useRef<WebSocket|null>(null)
  const nextTimeRef = useRef(0)

  function start() {
    const ctx = new AudioContext({ sampleRate: 48000 })
    ctxRef.current = ctx
    nextTimeRef.current = ctx.currentTime + 0.2

    setStatus('connecting')
    const ws = new WebSocket('/ws/audio')
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws

    ws.onopen = () => setStatus('streaming')
    ws.onclose = () => setStatus('stopped')
    ws.onerror = () => setStatus('stopped')
    ws.onmessage = e => {
      const i16 = new Int16Array(e.data)
      const f32 = new Float32Array(i16.length)
      for (let i=0;i<i16.length;i++) f32[i]=i16[i]/32768
      const buf = ctx.createBuffer(1, f32.length, 8000)
      buf.getChannelData(0).set(f32)
      const src = ctx.createBufferSource()
      src.buffer = buf
      src.connect(ctx.destination)
      const now = ctx.currentTime
      if (nextTimeRef.current < now) {
        setUnderruns(u => u+1)
        nextTimeRef.current = now + 0.1
      }
      src.start(nextTimeRef.current)
      nextTimeRef.current += buf.duration
    }
  }

  function stop() {
    wsRef.current?.close()
    ctxRef.current?.close()
    setStatus('stopped')
  }

  const colors: Record<Status,string> = { stopped:'#888', connecting:'#ffaa00', streaming:'#00ff88' }

  return (
    <div className="panel" style={{flex:'1'}}>
      <div className="panel-title">Audio</div>
      <div style={{marginTop:8}}>
        <span style={{color:colors[status],fontSize:'0.8rem',marginRight:12}}>● {status}</span>
      </div>
      <div style={{marginTop:8}}>
        {status==='stopped'
          ? <button className="btn" onClick={start}>▶ Start</button>
          : <button className="btn stop" onClick={stop}>■ Stop</button>}
      </div>
      {underruns > 0 && <div className="status-line">Underruns: {underruns}</div>}
      <div className="status-line" style={{marginTop:8}}>PCM 8kHz mono int16 (AMBE)</div>
    </div>
  )
}
