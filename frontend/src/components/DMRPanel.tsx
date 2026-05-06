import { useEffect, useRef, useState } from 'react'

interface DMRFrame {
  sync: boolean; timeslot: number; frame_type: string; errors: number; raw_line: string
}

export default function DMRPanel() {
  const [frames, setFrames] = useState<DMRFrame[]>([])
  const [synced, setSynced] = useState(false)
  const wsRef = useRef<WebSocket|null>(null)
  const syncTimer = useRef<ReturnType<typeof setTimeout>|null>(null)

  useEffect(() => {
    function connect() {
      const ws = new WebSocket('/ws/dmr')
      wsRef.current = ws
      ws.onmessage = e => {
        const f: DMRFrame = JSON.parse(e.data)
        if (f.sync) {
          setSynced(true)
          if (syncTimer.current) clearTimeout(syncTimer.current)
          syncTimer.current = setTimeout(() => setSynced(false), 2000)
        }
        setFrames(prev => [f, ...prev].slice(0, 20))
      }
      ws.onclose = () => setTimeout(connect, 3000)
      ws.onerror = () => console.error('DMR WebSocket error')
    }
    connect()
    return () => { wsRef.current?.close() }
  }, [])

  return (
    <div className="panel" style={{flex:'2',overflowY:'hidden'}}>
      <div style={{display:'flex',alignItems:'center',gap:8,marginBottom:6}}>
        <div className={`sync-dot ${synced?'active':''}`}/>
        <span className="panel-title">DMR Decode</span>
      </div>
      <div style={{overflowY:'auto',height:'calc(100% - 28px)'}}>
        {frames.map((f,i) => (
          <div className="dmr-row" key={i} style={{opacity: 1 - i*0.04}}>
            <span className="badge badge-blue">TS{f.timeslot}</span>
            <span className={`badge ${f.frame_type==='VOICE'?'badge-green':'badge-grey'}`}>{f.frame_type}</span>
            {f.errors > 0 && <span className="badge badge-red">E:{f.errors}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
