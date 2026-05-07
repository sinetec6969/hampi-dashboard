import { useEffect, useRef, useState } from 'react'

interface Transcript {
  id: number
  timeslot: number
  text: string
  ts: number
}

const MAX_ENTRIES = 50

export default function STTPanel() {
  const [entries, setEntries] = useState<Transcript[]>([])
  const [status, setStatus] = useState<'connecting' | 'live' | 'stopped'>('stopped')
  const wsRef    = useRef<WebSocket | null>(null)
  const counter  = useRef(0)
  const bottomRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let ws: WebSocket
    let retry: ReturnType<typeof setTimeout>

    const connect = () => {
      setStatus('connecting')
      ws = new WebSocket(`ws://${location.host}/ws/stt`)
      wsRef.current = ws

      ws.onopen = () => setStatus('live')

      ws.onmessage = (ev) => {
        try {
          const { timeslot, text, ts } = JSON.parse(ev.data as string)
          if (!text) return
          setEntries(prev => [...prev, { id: counter.current++, timeslot, text, ts }].slice(-MAX_ENTRIES))
        } catch { /* ignore malformed frames */ }
      }

      ws.onclose = () => {
        setStatus('stopped')
        retry = setTimeout(connect, 3000)
      }
    }

    connect()
    return () => { clearTimeout(retry); ws?.close() }
  }, [])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [entries])

  const statusColor = status === 'live' ? '#00ff88' : status === 'connecting' ? '#ffaa00' : '#555'

  return (
    <div className="panel stt-panel">
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <div style={{ width: 8, height: 8, borderRadius: '50%', background: statusColor, flexShrink: 0,
          boxShadow: status === 'live' ? `0 0 6px ${statusColor}` : 'none' }} />
        <span className="panel-title">Speech-to-Text</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#555' }}>{status}</span>
      </div>
      <div className="stt-body">
        {entries.length === 0 && (
          <div style={{ color: '#444', fontSize: '0.72rem', padding: '6px 0' }}>
            Waiting for voice traffic…
          </div>
        )}
        {entries.map(e => (
          <div key={e.id} className="stt-entry">
            <span className="badge badge-blue">TS{e.timeslot + 1}</span>
            <span className="stt-time">{new Date(e.ts * 1000).toLocaleTimeString()}</span>
            <span className="stt-text">{e.text}</span>
          </div>
        ))}
        <div ref={bottomRef} />
      </div>
    </div>
  )
}
