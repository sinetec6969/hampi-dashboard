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
  if (pct == null) return '#555'
  if (pct > 50)   return '#00ff88'
  if (pct > 20)   return '#ffaa00'
  return '#ff4444'
}

function byteLen(s: string): number {
  return new TextEncoder().encode(s).length
}

// ── Map helpers ───────────────────────────────────────────────────────────

function nodeIcon(node: MeshNode) {
  const online = isOnline(node)
  const color  = node.is_local ? '#ff88ff' : online ? '#44ccff' : '#444'
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

  const wsRef      = useRef<WebSocket | null>(null)
  const msgEndRef  = useRef<HTMLDivElement | null>(null)
  const inputRef   = useRef<HTMLInputElement | null>(null)
  const aliveRef   = useRef(true)
  const retryRef   = useRef<ReturnType<typeof setTimeout> | null>(null)

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

  // ── Derived ───────────────────────────────────────────────────────────

  const sorted  = [...nodes].sort((a, b) => (b.last_heard ?? 0) - (a.last_heard ?? 0))
  const onlineN = nodes.filter(isOnline).length
  const withPos = nodes.filter(n => n.lat != null && n.lon != null)

  // ── Render ────────────────────────────────────────────────────────────

  return (
    <div className="mesh-page">

      {/* Header */}
      <div className="mesh-header">
        <span className="mesh-title">🕸 Meshtastic</span>
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
            </div>
          ))}
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
                  <div style={{ fontFamily: 'monospace', minWidth: 160 }}>
                    <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#0ea5e9' }}>{node.short_name}</div>
                    {node.long_name && <div style={{ fontSize: '0.82rem', marginTop: 2 }}>{node.long_name}</div>}
                    <div style={{ fontSize: '0.7rem', color: '#888', marginTop: 4 }}>{node.node_id}</div>
                    {node.hw_model && <div style={{ fontSize: '0.7rem', color: '#666', marginTop: 2 }}>{node.hw_model}</div>}
                    <div style={{ fontSize: '0.7rem', marginTop: 6, borderTop: '1px solid #eee', paddingTop: 4, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
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
