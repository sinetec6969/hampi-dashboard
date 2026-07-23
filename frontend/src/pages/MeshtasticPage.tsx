import { wsUrl } from '../ws'
import { useState, useEffect, useRef, useCallback } from 'react'
import { MapContainer, TileLayer, Marker, Popup, useMap } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

// ── Types ────────────────────────────────────────────────────────────────

interface MeshNode {
  node_id:       string
  num:           number
  long_name:     string
  short_name:    string
  hw_model:      string
  lat:           number | null
  lon:           number | null
  altitude:      number | null
  battery_level: number | null
  voltage:       number | null
  temperature:   number | null
  humidity:      number | null
  snr:           number | null
  rssi:          number | null
  last_heard:    number | null
  hops_away:     number
  is_local:      boolean
}

interface MeshMessage {
  id:         string
  timestamp:  number
  from_id:    string
  from_short: string
  from_long:  string
  text:       string
  channel:    number
  hop_limit:  number
  snr:        number | null
  sent?:      boolean   // true for optimistic outbound messages
  to_id?:     string    // set for DMs
}

interface MeshChannel {
  index: number
  name:  string
  role:  string
}

interface MeshStatus {
  available:  boolean
  connected:  boolean
  device:     string | null
  node_count: number
  local_id:   string | null
}

interface TraceHop {
  num: number
  id:  string
  snr: number | null
}

interface TraceRoute {
  target:   string
  local:    string
  towards:  TraceHop[]
  back?:    TraceHop[]
  received: number   // client receive time (ms)
}

interface RangeTestConfig {
  available: boolean
  enabled:   boolean
  sender:    number
  save:      boolean
}

interface ProbeSample {
  t:    number          // ms
  snr:  number | null   // SNR at target on the forward path
  hops: number          // intermediate hop count (0 = direct)
}

interface ProbeState {
  target:  string
  running: boolean
  sent:    number
  samples: ProbeSample[]
}

const PROBE_INTERVAL_S = 30   // firmware rate-limits traceroute to ~30 s

const MAX_MSG_BYTES = 228

// ── Helpers ───────────────────────────────────────────────────────────────

const ONLINE_S = 900

function isOnline(node: MeshNode): boolean {
  if (!node.last_heard) return false
  return Date.now() / 1000 - node.last_heard < ONLINE_S
}

function fmtAge(ts: number | null): string {
  if (!ts) return '—'
  const s = Math.floor(Date.now() / 1000 - ts)
  if (s < 60)   return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ago`
}

function fmtTs(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString([], {
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
}

function battColor(pct: number | null): string {
  if (pct == null) return '#4d7a62'
  if (pct > 50)   return '#00ff88'
  if (pct > 20)   return '#ffaa00'
  return '#ff3355'
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length
}

function fmtSnr(v: number | null): string {
  if (v == null) return '?'
  return `${v >= 0 ? '+' : ''}${v.toFixed(1)}`
}

function Sparkline({ samples }: { samples: ProbeSample[] }) {
  const withSnr = samples.filter(s => s.snr != null)
  if (withSnr.length < 2) return null
  const W = 180, H = 34
  const vals = withSnr.map(s => s.snr as number)
  const min  = Math.min(...vals, -18)
  const max  = Math.max(...vals, 6)
  const span = max - min || 1
  const pts  = withSnr.map((s, i) => {
    const x = (i / (withSnr.length - 1)) * (W - 2) + 1
    const y = H - 1 - ((s.snr as number - min) / span) * (H - 2)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  }).join(' ')
  return (
    <svg width={W} height={H} style={{ display: 'block', marginTop: 4 }}>
      <polyline points={pts} fill="none" stroke="#00ff88" strokeWidth="1.5" />
    </svg>
  )
}

// ── Map helpers ───────────────────────────────────────────────────────────

function nodeIcon(node: MeshNode) {
  const online = isOnline(node)
  const color  = node.is_local ? '#ff88ff' : online ? '#44ccff' : '#3d6b52'
  const glow   = node.is_local ? '#ff88ff' : online ? '#44ccff' : 'transparent'
  return L.divIcon({
    html: `<div style="width:11px;height:11px;background:${color};border-radius:50%;border:2px solid #fff;box-shadow:0 0 8px ${glow},0 0 2px #fff"></div>`,
    className:   '',
    iconSize:    [11, 11],
    iconAnchor:  [5,  5],
    popupAnchor: [0, -8],
  })
}

function MapAutoCenter({ nodes }: { nodes: MeshNode[] }) {
  const map  = useMap()
  const done = useRef(false)
  useEffect(() => {
    if (done.current) return
    const first = nodes.find(n => n.lat != null && n.lon != null)
    if (first) {
      map.flyTo([first.lat!, first.lon!], 10, { duration: 1.5 })
      done.current = true
    }
  }, [nodes, map])
  return null
}

// ── Main component ────────────────────────────────────────────────────────

export default function MeshtasticPage() {
  const [status,   setStatus]   = useState<MeshStatus>({
    available: false, connected: false, device: null, node_count: 0, local_id: null,
  })
  const [nodes,    setNodes]    = useState<MeshNode[]>([])
  const [messages, setMessages] = useState<MeshMessage[]>([])
  const [channels, setChannels] = useState<MeshChannel[]>([])
  const [selected, setSelected] = useState<string | null>(null)

  // compose state
  const [draft,     setDraft]     = useState('')
  const [channel,   setChannel]   = useState(0)
  const [sending,   setSending]   = useState(false)
  const [sendError, setSendError] = useState('')

  // tools state
  const [traces,  setTraces]  = useState<Record<string, TraceRoute>>({})
  const [tracing, setTracing] = useState<string | null>(null)   // target id awaiting reply
  const [probe,   setProbe]   = useState<ProbeState | null>(null)
  const [rt,      setRt]      = useState<RangeTestConfig>({ available: false, enabled: false, sender: 0, save: false })
  const [rtSaving, setRtSaving] = useState(false)
  const [rtSamples, setRtSamples] = useState<Array<{ seq: string; from: string; snr: number | null; rssi: number | null; t: number }>>([])

  const wsRef      = useRef<WebSocket | null>(null)
  const msgEndRef  = useRef<HTMLDivElement | null>(null)
  const inputRef   = useRef<HTMLInputElement | null>(null)
  const aliveRef   = useRef(true)
  const retryRef   = useRef<ReturnType<typeof setTimeout> | null>(null)
  const probeTargetRef = useRef<string | null>(null)   // mirror for the stable WS closure
  const probeTimerRef  = useRef<ReturnType<typeof setInterval> | null>(null)
  const traceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ── WebSocket ─────────────────────────────────────────────────────────

  const connectWs = useCallback(() => {
    const ws = new WebSocket(wsUrl('/ws/meshtastic'))
    wsRef.current = ws

    ws.onmessage = e => {
      if (typeof e.data !== 'string') return
      try {
        const msg = JSON.parse(e.data)
        switch (msg.type) {
          case 'status':
            setStatus(s => ({ ...s, ...msg }))
            break
          case 'node_list':
            setNodes(msg.nodes ?? [])
            break
          case 'node_update':
            setNodes(prev => {
              const idx = prev.findIndex(n => n.node_id === msg.node.node_id)
              if (idx >= 0) {
                const next = [...prev]; next[idx] = { ...next[idx], ...msg.node }; return next
              }
              return [...prev, msg.node]
            })
            break
          case 'message':
            setMessages(prev =>
              prev.some(m => m.id === msg.message.id) ? prev : [...prev, msg.message]
            )
            break
          case 'traceroute': {
            const tr: TraceRoute = { ...msg.traceroute, received: Date.now() }
            setTraces(prev => ({ ...prev, [tr.target]: tr }))
            setTracing(t => (t === tr.target ? null : t))
            if (probeTargetRef.current === tr.target) {
              const dest = tr.towards[tr.towards.length - 1]
              setProbe(p => p && p.target === tr.target ? {
                ...p,
                samples: [...p.samples, {
                  t:    tr.received,
                  snr:  dest?.snr ?? null,
                  hops: Math.max(0, tr.towards.length - 2),
                }],
              } : p)
            }
            break
          }
          case 'range_test': {
            const s = msg.sample
            setRtSamples(prev => [{
              seq: s.seq, from: s.from_short || s.from_id, snr: s.snr, rssi: s.rssi, t: s.timestamp * 1000,
            }, ...prev].slice(0, 12))
            break
          }
        }
      } catch { /* ignore */ }
    }

    ws.onclose = () => {
      wsRef.current = null
      if (!aliveRef.current) return
      setStatus(s => ({ ...s, connected: false }))
      retryRef.current = setTimeout(connectWs, 4000)
    }
  }, [])

  useEffect(() => {
    aliveRef.current = true
    connectWs()
    return () => {
      aliveRef.current = false
      if (retryRef.current) clearTimeout(retryRef.current)
      wsRef.current?.close()
    }
  }, [connectWs])

  // Fetch channels once on connect
  useEffect(() => {
    if (!status.connected) return
    fetch('/api/meshtastic/channels')
      .then(r => r.json())
      .then((chs: MeshChannel[]) => {
        setChannels(chs)
        // Default to primary channel index
        const primary = chs.find(c => c.role === 'PRIMARY')
        if (primary) setChannel(primary.index)
      })
      .catch(() => {})
  }, [status.connected])

  // Auto-scroll message log
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Send ──────────────────────────────────────────────────────────────

  const selectedNode = selected ? nodes.find(n => n.node_id === selected) ?? null : null
  const destination  = selectedNode && !selectedNode.is_local ? selectedNode.node_id : '^all'
  const isDM         = destination !== '^all'
  const remaining    = MAX_MSG_BYTES - byteLen(draft)

  async function sendMessage() {
    const text = draft.trim()
    if (!text || !status.connected || sending) return
    setSending(true)
    setSendError('')
    try {
      const r = await fetch('/api/meshtastic/send', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ text, destination, channel }),
      })
      if (!r.ok) {
        const err = await r.json().catch(() => ({ detail: r.statusText }))
        throw new Error(err.detail ?? r.statusText)
      }
      // Optimistic echo
      setMessages(prev => [...prev, {
        id:         `sent-${Date.now()}`,
        timestamp:  Date.now() / 1000,
        from_id:    status.local_id ?? 'local',
        from_short: 'You',
        from_long:  '',
        text,
        channel,
        hop_limit:  0,
        snr:        null,
        sent:       true,
        to_id:      isDM ? destination : undefined,
      }])
      setDraft('')
      inputRef.current?.focus()
    } catch (e: unknown) {
      setSendError(e instanceof Error ? e.message : String(e))
      setTimeout(() => setSendError(''), 4000)
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage() }
    if (e.key === 'Escape') setSelected(null)
  }

  // ── Traceroute / probe / range test ─────────────────────────────────────

  const fireTraceroute = useCallback(async (target: string): Promise<boolean> => {
    try {
      const r = await fetch('/api/meshtastic/traceroute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ destination: target }),
      })
      return r.ok
    } catch { return false }
  }, [])

  async function runTraceroute(target: string) {
    if (tracing) return
    setTracing(target)
    if (traceTimeoutRef.current) clearTimeout(traceTimeoutRef.current)
    traceTimeoutRef.current = setTimeout(() => setTracing(t => (t === target ? null : t)), 40000)
    const ok = await fireTraceroute(target)
    if (!ok) setTracing(t => (t === target ? null : t))
  }

  function stopProbe() {
    if (probeTimerRef.current) { clearInterval(probeTimerRef.current); probeTimerRef.current = null }
    probeTargetRef.current = null
    setProbe(p => (p ? { ...p, running: false } : p))
  }

  function startProbe(target: string) {
    stopProbe()
    probeTargetRef.current = target
    setProbe({ target, running: true, sent: 0, samples: [] })
    const tick = () => {
      setProbe(p => (p ? { ...p, sent: p.sent + 1 } : p))
      fireTraceroute(target)
    }
    tick()
    probeTimerRef.current = setInterval(tick, PROBE_INTERVAL_S * 1000)
  }

  // Fetch RangeTest module config on connect
  useEffect(() => {
    if (!status.connected) return
    fetch('/api/meshtastic/rangetest').then(r => r.json()).then(setRt).catch(() => {})
  }, [status.connected])

  async function applyRangeTest(next: Partial<RangeTestConfig>) {
    const body = { enabled: rt.enabled, sender: rt.sender, save: rt.save, ...next }
    setRtSaving(true)
    try {
      const r = await fetch('/api/meshtastic/rangetest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (r.ok) setRt(c => ({ ...c, ...body }))
    } catch { /* ignore */ } finally {
      setRtSaving(false)
    }
  }

  // Stop probe timer on unmount
  useEffect(() => () => {
    if (probeTimerRef.current) clearInterval(probeTimerRef.current)
    if (traceTimeoutRef.current) clearTimeout(traceTimeoutRef.current)
  }, [])

  // ── Derived ───────────────────────────────────────────────────────────

  const sorted  = [...nodes].sort((a, b) => (b.last_heard ?? 0) - (a.last_heard ?? 0))
  const onlineN = nodes.filter(isOnline).length
  const withPos = nodes.filter(n => n.lat != null && n.lon != null)

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="mesh-page">

      {/* Header */}
      <div className="mesh-header">
        <span className="mesh-title">┌─ MESHTASTIC</span>
        <div className="mesh-header-right">
          <span className={`mesh-conn-dot ${status.connected ? 'connected' : ''}`} />
          <span className="mesh-conn-text">
            {status.connected
              ? `${status.device ?? 'connected'} · ${onlineN}/${nodes.length} online`
              : status.available ? 'Searching for a radio on USB — check the cable and that ModemManager isn’t squatting the port' : 'meshtastic package missing — pip install meshtastic in backend/venv, restart the service'}
          </span>
          {status.local_id && <span className="mesh-local-id">{status.local_id}</span>}
        </div>
      </div>

      {/* Body: node list + map */}
      <div className="mesh-body">

        {/* Node list */}
        <div className="mesh-nodelist">
          <div className="mesh-section-title">
            Nodes {nodes.length > 0 && <span className="mesh-count">{nodes.length}</span>}
          </div>

          {sorted.length === 0 ? (
            <div className="mesh-empty">
              {status.connected ? 'Radio connected, no nodes heard yet — give the mesh a minute' : 'No radio yet — nodes appear once one connects'}
            </div>
          ) : sorted.map(node => (
            <div
              key={node.node_id}
              className={`mesh-node-row${isOnline(node) ? ' online' : ''}${selected === node.node_id ? ' selected' : ''}`}
              onClick={() => setSelected(selected === node.node_id ? null : node.node_id)}
              title={node.is_local ? 'Your node' : 'Click to select for DM'}
            >
              <div className="mesh-node-top">
                <span className={`mesh-node-dot${isOnline(node) ? ' online' : ''}`} />
                <span className="mesh-node-short">{node.short_name}</span>
                {node.is_local && <span className="mesh-local-badge">local</span>}
                <span className="mesh-node-age">{fmtAge(node.last_heard)}</span>
              </div>
              <div className="mesh-node-long">{node.long_name || node.node_id}</div>
              <div className="mesh-node-meta">
                {node.hw_model && <span>{node.hw_model}</span>}
                {node.battery_level != null && (
                  <span style={{ color: battColor(node.battery_level) }}>🔋 {node.battery_level}%</span>
                )}
                {node.snr != null && (
                  <span>SNR {node.snr >= 0 ? '+' : ''}{node.snr.toFixed(1)}</span>
                )}
                {node.hops_away > 0 && (
                  <span>{node.hops_away} hop{node.hops_away !== 1 ? 's' : ''}</span>
                )}
              </div>
              {node.temperature != null && (
                <div className="mesh-node-meta">
                  🌡 {node.temperature.toFixed(1)}°C
                  {node.humidity != null && ` · 💧${node.humidity.toFixed(0)}%`}
                </div>
              )}

              {selected === node.node_id && !node.is_local && (
                <div className="mesh-node-tools" onClick={e => e.stopPropagation()}>
                  <div className="mesh-tool-btns">
                    <button
                      className="btn mesh-tool-btn"
                      disabled={!status.connected || tracing === node.node_id}
                      onClick={() => runTraceroute(node.node_id)}
                    >
                      {tracing === node.node_id ? 'tracing…' : '⇄ traceroute'}
                    </button>
                    {probe?.target === node.node_id && probe.running ? (
                      <button className="btn mesh-tool-btn stop" onClick={stopProbe}>■ stop probe</button>
                    ) : (
                      <button
                        className="btn mesh-tool-btn"
                        disabled={!status.connected || (probe?.running ?? false)}
                        onClick={() => startProbe(node.node_id)}
                      >
                        ▶ probe ({PROBE_INTERVAL_S}s)
                      </button>
                    )}
                  </div>

                  {traces[node.node_id] && (
                    <div className="mesh-trace">
                      <div className="mesh-trace-line">
                        {traces[node.node_id].towards.map((h, i) => (
                          <span key={i}>
                            {i > 0 && <span className="mesh-trace-arrow"> → </span>}
                            <span className="mesh-trace-hop">
                              {h.id === status.local_id ? 'you' : (nodes.find(n => n.num === h.num)?.short_name ?? h.id.slice(-4))}
                            </span>
                            {i > 0 && <span className="mesh-trace-snr"> {fmtSnr(h.snr)}dB</span>}
                          </span>
                        ))}
                      </div>
                      <div className="mesh-trace-meta">
                        {Math.max(0, traces[node.node_id].towards.length - 2)} hop{traces[node.node_id].towards.length - 2 === 1 ? '' : 's'} · {fmtAge(traces[node.node_id].received / 1000)}
                      </div>
                    </div>
                  )}

                  {probe?.target === node.node_id && (
                    <div className="mesh-probe">
                      {(() => {
                        const snrs = probe.samples.map(s => s.snr).filter((v): v is number => v != null)
                        const recv = probe.samples.length
                        const loss = probe.sent > 0 ? Math.round((1 - recv / probe.sent) * 100) : 0
                        const last = snrs.length ? snrs[snrs.length - 1] : null
                        const avg  = snrs.length ? snrs.reduce((a, b) => a + b, 0) / snrs.length : null
                        const mn   = snrs.length ? Math.min(...snrs) : null
                        return (
                          <>
                            <div className="mesh-probe-stats">
                              <span>{recv}/{probe.sent} replies</span>
                              <span className={loss > 30 ? 'warn' : ''}>{loss}% loss</span>
                              {last != null && <span>last {fmtSnr(last)}</span>}
                              {avg  != null && <span>avg {fmtSnr(avg)}</span>}
                              {mn   != null && <span>min {fmtSnr(mn)}</span>}
                            </div>
                            <Sparkline samples={probe.samples} />
                          </>
                        )
                      })()}
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}

          {/* Range Test module (local node) */}
          <div className="mesh-rangetest">
            <div className="mesh-section-title" style={{ padding: '8px 0 4px' }}>
              Range Test module
              <span className={`mesh-rt-badge ${rt.enabled ? 'on' : ''}`}>
                {!rt.available ? 'n/a' : rt.enabled ? (rt.sender > 0 ? `sender ${rt.sender}s` : 'receiver') : 'off'}
              </span>
            </div>
            {rt.available ? (
              <>
                <div className="mesh-rt-row">
                  <label>
                    <input
                      type="checkbox"
                      checked={rt.enabled}
                      disabled={rtSaving || !status.connected}
                      onChange={e => applyRangeTest({ enabled: e.target.checked })}
                    /> enabled
                  </label>
                  <select
                    className="mesh-rt-sel"
                    value={rt.sender}
                    disabled={rtSaving || !status.connected}
                    onChange={e => applyRangeTest({ sender: Number(e.target.value) })}
                    title="0 = receiver-only; >0 = broadcast interval"
                  >
                    <option value={0}>receiver</option>
                    <option value={15}>send 15s</option>
                    <option value={30}>send 30s</option>
                    <option value={60}>send 60s</option>
                    <option value={300}>send 5m</option>
                  </select>
                  <label title="Log received range-test packets to the device">
                    <input
                      type="checkbox"
                      checked={rt.save}
                      disabled={rtSaving || !status.connected}
                      onChange={e => applyRangeTest({ save: e.target.checked })}
                    /> save
                  </label>
                </div>
                <div className="mesh-rt-warn">Applying reboots the radio.</div>
                {rtSamples.length > 0 && (
                  <div className="mesh-rt-feed">
                    {rtSamples.map((s, i) => (
                      <div key={i} className="mesh-rt-sample">
                        <span className="mesh-msg-time">{fmtTs(s.t / 1000)}</span>
                        <span className="mesh-rt-from">{s.from}</span>
                        <span className="mesh-rt-seq">#{s.seq}</span>
                        {s.snr != null && <span>SNR {fmtSnr(s.snr)}</span>}
                        {s.rssi != null && <span>{s.rssi}dBm</span>}
                      </div>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="mesh-empty" style={{ padding: '4px 0' }}>
                {status.connected ? 'Module config unavailable' : 'Connect a radio to configure'}
              </div>
            )}
          </div>
        </div>

        {/* Map */}
        <div className="mesh-map">
          <MapContainer center={[30, -20]} zoom={2} style={{ height: '100%', width: '100%' }} zoomControl scrollWheelZoom>
            <TileLayer
              url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
              attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
              subdomains="abcd"
              maxZoom={19}
            />
            <MapAutoCenter nodes={withPos} />
            {withPos.map(node => (
              <Marker
                key={node.node_id}
                position={[node.lat!, node.lon!]}
                icon={nodeIcon(node)}
                eventHandlers={{ click: () => setSelected(node.node_id) }}
              >
                <Popup>
                  <div style={{ fontFamily: 'inherit', minWidth: 160 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#0ea5e9' }}>{node.short_name}</div>
                    {node.long_name && <div style={{ fontSize: '0.82rem', marginTop: 2 }}>{node.long_name}</div>}
                    <div style={{ fontSize: '0.7rem', color: '#7fbf9a', marginTop: 4 }}>{node.node_id}</div>
                    {node.hw_model && <div style={{ fontSize: '0.7rem', color: '#58a67a', marginTop: 2 }}>{node.hw_model}</div>}
                    <div style={{ fontSize: '0.7rem', marginTop: 6, borderTop: '1px solid #c8ffe0', paddingTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                      {node.battery_level != null && <span>🔋 {node.battery_level}%</span>}
                      {node.snr != null && <span>SNR {node.snr?.toFixed(1)}</span>}
                      {node.altitude != null && <span>Alt {node.altitude} m</span>}
                      {node.temperature != null && <span>🌡 {node.temperature.toFixed(1)}°C</span>}
                    </div>
                    <div style={{ fontSize: '0.68rem', color: '#999', marginTop: 4 }}>
                      {fmtAge(node.last_heard)}
                      {node.hops_away > 0 && ` · ${node.hops_away} hop${node.hops_away !== 1 ? 's' : ''}`}
                    </div>
                  </div>
                </Popup>
              </Marker>
            ))}
          </MapContainer>
        </div>
      </div>

      {/* Message panel */}
      <div className="mesh-msgpanel">

        {/* Log header */}
        <div className="mesh-section-title" style={{ flexShrink: 0 }}>
          Messages {messages.length > 0 && <span className="mesh-count">{messages.length}</span>}
        </div>

        {/* Scrollable log */}
        <div className="mesh-msg-log">
          {messages.length === 0 ? (
            <div className="mesh-empty" style={{ padding: '6px 12px' }}>No messages yet</div>
          ) : messages.map(m => (
            <div key={m.id} className={`mesh-msg-row${m.sent ? ' sent' : ''}`}>
              <span className="mesh-msg-time">{fmtTs(m.timestamp)}</span>
              {m.sent
                ? <span className="mesh-msg-from sent">You{m.to_id ? ` → ${nodes.find(n => n.node_id === m.to_id)?.short_name ?? m.to_id}` : ''}</span>
                : <span className="mesh-msg-from">{m.from_short}</span>}
              {m.channel > 0 && <span className="mesh-msg-ch">ch{m.channel}</span>}
              <span className="mesh-msg-text">{m.text}</span>
              {m.snr != null && <span className="mesh-msg-snr">SNR {m.snr >= 0 ? '+' : ''}{m.snr.toFixed(1)}</span>}
            </div>
          ))}
          <div ref={msgEndRef} />
        </div>

        {/* Compose bar */}
        <div className="mesh-compose">
          {/* DM target pill */}
          {isDM && selectedNode && (
            <div className="mesh-compose-to">
              <span>→ {selectedNode.short_name}</span>
              <button className="mesh-compose-clear" onClick={() => setSelected(null)} title="Cancel DM">×</button>
            </div>
          )}

          {/* Channel selector */}
          {channels.length > 1 && (
            <select
              className="mesh-compose-ch"
              value={channel}
              onChange={e => setChannel(Number(e.target.value))}
              disabled={!status.connected}
            >
              {channels.map(ch => (
                <option key={ch.index} value={ch.index}>{ch.name}</option>
              ))}
            </select>
          )}

          {/* Text input */}
          <input
            ref={inputRef}
            className="mesh-compose-input"
            type="text"
            value={draft}
            onChange={e => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={isDM ? `DM ${selectedNode?.short_name}…` : 'Broadcast message…'}
            disabled={!status.connected || sending}
            maxLength={500}
          />

          {/* Char counter */}
          <span className={`mesh-compose-count${remaining < 20 ? ' warn' : ''}`}>
            {remaining}
          </span>

          {/* Send button */}
          <button
            className="btn mesh-compose-send"
            onClick={sendMessage}
            disabled={!status.connected || !draft.trim() || sending || remaining < 0}
          >
            {sending ? '…' : '▶'}
          </button>
        </div>

        {/* Send error */}
        {sendError && (
          <div className="mesh-send-error">{sendError}</div>
        )}

      </div>
    </div>
  )
}
