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
      background: "#111",
      display: "flex",
      flexDirection: "column",
      height: "100%",
      padding: "10px 14px",
    }}>
      <div style={{ color: "#666", fontSize: 11, marginBottom: 8, textTransform: "uppercase", letterSpacing: 1, flexShrink: 0 }}>
        Call History — {calls.length} calls
      </div>

      {calls.length === 0 ? (
        <div style={{ color: "#444", fontSize: 12 }}>No calls recorded yet.</div>
      ) : (
        <div style={{ flex: 1, overflowY: "auto", overflowX: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12, color: "#ccc", tableLayout: "fixed" }}>
            <colgroup>
              <col style={{ width: "20%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "11%" }} />
              <col style={{ width: "auto" }} />
            </colgroup>
            <thead>
              <tr style={{ borderBottom: "1px solid #2a2a2a", color: "#555", position: "sticky", top: 0, background: "#111" }}>
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
                  <tr key={c.id} style={{ borderBottom: "1px solid #1a1a1a" }}>
                    <td style={{ padding: "4px 8px", color: "#555" }}>{fmtTime(c.started_at)}</td>
                    <td style={{ padding: "4px 8px", color: "#555" }}>{fmtDur(c.duration_s)}</td>
                    <td style={{ padding: "4px 8px", color: "#4af" }}>
                      {c.dst_id || "—"}{c.tg_name ? <span style={{ color: "#777" }}> {c.tg_name}</span> : null}
                    </td>
                    <td style={{ padding: "4px 8px", overflow: "hidden" }}>
                      <div style={{ color: "#eee", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {c.callsign && <span style={{ color: "#fa0", marginRight: 5 }}>{c.callsign}</span>}
                        {displayName !== c.callsign && <span>{displayName}</span>}
                      </div>
                      {location && (
                        <div style={{ color: "#555", fontSize: 10, marginTop: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
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
