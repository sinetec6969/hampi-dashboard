import { useEffect, useRef, useState } from 'react'

interface DMRFrame {
  sync: boolean
  timeslot: number
  frame_type: string
  errors: number
  src_id: number
  dst_id: number
  tg_name?: string
  group: boolean
  alias: string
  color_code: number
  raw_line: string
}

interface LookupResult {
  callsign: string
  name: string
  city: string
  state: string
}

export default function DMRPanel() {
  const [frames, setFrames]         = useState<DMRFrame[]>([])
  const [synced, setSynced]         = useState(false)
  const [lookup, setLookup]         = useState<LookupResult | null>(null)
  const [activeSrc, setActiveSrc]   = useState(0)
  const [activeDst, setActiveDst]   = useState(0)
  const [activeTs,  setActiveTs]    = useState(0)
  const [activeAlias, setActiveAlias] = useState('')
  const [activeCC, setActiveCC]     = useState(0)

  const wsRef      = useRef<WebSocket | null>(null)
  const syncTimer  = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSrcRef = useRef(0)

  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(`ws://${location.host}/ws/dmr`)
      wsRef.current = ws

      ws.onmessage = e => {
        const f: DMRFrame = JSON.parse(e.data)

        if (f.sync) {
          setSynced(true)
          if (syncTimer.current) clearTimeout(syncTimer.current)
          syncTimer.current = setTimeout(() => setSynced(false), 2000)
        }

        if (f.frame_type === 'VOICE') {
          setActiveTs(f.timeslot)
          if (f.color_code) setActiveCC(f.color_code)

          if (f.src_id === 0) {
            // VLC header — backend just called _clear_call for a new transmission.
            // Reset lastSrcRef so the next VC* frame (even from the same caller)
            // is treated as a new call and updates the display.
            lastSrcRef.current = 0
            setActiveAlias('')   // don't bleed previous caller's alias
          } else {
            if (f.dst_id) setActiveDst(f.dst_id)
            if (f.alias)  setActiveAlias(f.alias)
            if (f.src_id !== lastSrcRef.current) {
              lastSrcRef.current = f.src_id
              setActiveSrc(f.src_id)
              setLookup(null)
              if (!f.alias) {
                fetch(`/api/lookup/${f.src_id}`)
                  .then(r => r.json())
                  .then((d: LookupResult) => setLookup(d))
                  .catch(() => {})
              }
            }
          }
        }

        setFrames(prev => [f, ...prev].slice(0, 20))
      }

      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('DMR WebSocket error')
    }
    connect()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  const callsignLine = activeAlias
    ? activeAlias
    : lookup
      ? `${lookup.callsign || '—'}  ${lookup.name || ''}${lookup.city ? '  ' + lookup.city : ''}${lookup.state ? ', ' + lookup.state : ''}`
      : activeSrc ? 'Looking up…' : ''

  return (
    <div className="panel" style={{ flex: '2', overflowY: 'hidden', display: 'flex', flexDirection: 'column' }}>

      {/* Header row */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <div className={`sync-dot ${synced ? 'active' : ''}`} />
        <span className="panel-title">DMR Decode</span>
        {activeCC > 0 && <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#444' }}>CC{activeCC}</span>}
      </div>

      {/* Active call info */}
      <div style={{ marginBottom: 6, paddingBottom: 6, borderBottom: '1px solid #222', fontSize: '0.72rem', minHeight: 38 }}>
        {activeSrc ? (
          <>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span className="badge badge-blue">TS{activeTs + 1}</span>
              {activeDst > 0 && (
                <span style={{ color: '#888' }}>
                  TG&nbsp;<span style={{ color: '#fff' }}>{activeDst}</span>
                </span>
              )}
              <span style={{ color: '#aaa' }}>ID&nbsp;<span style={{ color: '#fff' }}>{activeSrc}</span></span>
            </div>
            <div style={{ marginTop: 3, color: '#00ff88', fontWeight: 'bold', fontSize: '0.78rem', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {callsignLine}
            </div>
          </>
        ) : (
          <span style={{ color: '#444', fontSize: '0.7rem' }}>No active call</span>
        )}
      </div>

      {/* Frame list */}
      <div style={{ overflowY: 'auto', flex: 1 }}>
        {frames.map((f, i) => (
          <div className="dmr-row" key={i} style={{ opacity: 1 - i * 0.04 }}>
            <span className="badge badge-blue">TS{f.timeslot + 1}</span>
            <span className={`badge ${f.frame_type === 'VOICE' ? 'badge-green' : 'badge-grey'}`}>{f.frame_type}</span>
            {f.src_id > 0 && (
              <span style={{ fontSize: '0.65rem', color: '#aaa' }}>
                {f.alias || f.src_id}
                {f.dst_id > 0 && <span style={{ color: '#555' }}>→TG{f.dst_id}{f.tg_name ? ` ${f.tg_name}` : ''}</span>}
              </span>
            )}
            {f.errors > 0 && <span className="badge badge-red">E:{f.errors}</span>}
          </div>
        ))}
      </div>
    </div>
  )
}
