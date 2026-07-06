import { useEffect, useRef, useState } from "react"

interface CallRecord {
  id: string
  started_at: string
  ended_at: string
  duration_s: number
  src_id: number
  dst_id: number
  tg_name?: string
  group: boolean
  alias: string
  callsign: string
  name: string
  city: string
  state: string
}

function fmtTime(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

function fmtDur(s: number): string {
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m${String(Math.round(s % 60)).padStart(2, "0")}s`
}

export default function CallHistory() {
  const [calls, setCalls] = useState<CallRecord[]>([])
  const wsRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    fetch("/api/calls")
      .then(r => r.json())
      .then((data: CallRecord[]) => setCalls(data))
      .catch(() => {})

    const proto = location.protocol === "https:" ? "wss:" : "ws:"
    const ws = new WebSocket(`${proto}//${location.host}/ws/dmr`)
    wsRef.current = ws
    ws.onmessage = (e) => {
      const data = JSON.parse(e.data)
      if (data.type === "call_record") {
        const { type: _type, ...record } = data
        setCalls(prev => [record as CallRecord, ...prev].slice(0, 200))
      }
    }
    return () => ws.close()
  }, [])

  return (
    <div style={{
      background: "#040805",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      padding: "10px 14px",
    }}>
      <div style={{ color: "#58a67a", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, flexShrink: 0 }}>
        Call History — {calls.length} calls
      </div>

      {calls.length === 0 ? (
        <div style={{ color: "#3d6b52", fontSize: 12 }}>No calls logged yet. Finished calls land here and survive restarts.</div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#a8e8c4", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "20%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "auto" }} />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: "1px solid #123322", color: "#4d7a62", position: "sticky", top: 0, background: "#040805" }}>
                <th style={{ textAlign: "left", padding: "3px 8px", fontWeight: 400 }}>Time</th>
                <th style={{ textAlign: "left", padding: "3px 8px", fontWeight: 400 }}>Dur</th>
                <th style={{ textAlign: "left", padding: "3px 8px", fontWeight: 400 }}>TG</th>
                <th style={{ textAlign: "left", padding: "3px 8px", fontWeight: 400 }}>Caller</th>
              </tr>
            </thead>
            <tbody>
              {calls.map((c) => {
                const displayName = c.name || c.callsign || c.alias || String(c.src_id)
                const location = [c.city, c.state].filter(Boolean).join(", ")
                return (
                  <tr key={c.id} style={{ borderBottom: "1px solid #0d2418" }}>
                    <td style={{ padding: "4px 8px", color: "#4d7a62" }}>{fmtTime(c.started_at)}</td>
                    <td style={{ padding: "4px 8px", color: "#4d7a62" }}>{fmtDur(c.duration_s)}</td>
                    <td style={{ padding: "4px 8px", color: "#4af" }}>
                      {c.dst_id || "—"}{c.tg_name ? <span style={{ color: "#777" }}> {c.tg_name}</span> : null}
                    </td>
                    <td style={{ padding: "4px 8px", overflow: "hidden" }}>
                      <div style={{ color: "#c8ffe0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.callsign && <span style={{ color: "#fa0", marginRight: 5 }}>{c.callsign}</span>}
                        {displayName !== c.callsign && <span>{displayName}</span>}
                      </div>
                      {location && (
                        <div style={{ color: "#4d7a62", fontSize: 10, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                          {location}
                        </div>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
