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
}

interface MeshStatus {
  available:  boolean
  connected:  boolean
  device:     string | null
  node_count: number
  local_id:   string | null
}

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

// Fly to first node with GPS once
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
  const [selected, setSelected] = useState<string | null>(null)
  const wsRef     = useRef<WebSocket | null>(null)
  const msgEndRef = useRef<HTMLDivElement | null>(null)

  // ── WebSocket ─────────────────────────────────────────────────────────

  const connectWs = useCallback(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/meshtastic`)
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
                const next = [...prev]
                next[idx] = { ...next[idx], ...msg.node }
                return next
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
      } catch { /* ignore malformed */ }
    }

    ws.onclose = () => {
      wsRef.current = null
      setStatus(s => ({ ...s, connected: false }))
      setTimeout(connectWs, 4000)
    }
  }, [])

  useEffect(() => {
    connectWs()
    return () => { wsRef.current?.close() }
  }, [connectWs])

  // Auto-scroll message log to bottom
  useEffect(() => {
    msgEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // ── Derived ───────────────────────────────────────────────────────────

  const sorted   = [...nodes].sort((a, b) => (b.last_heard ?? 0) - (a.last_heard ?? 0))
  const onlineN  = nodes.filter(isOnline).length
  const withPos  = nodes.filter(n => n.lat != null && n.lon != null)

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
              : status.available
              ? 'Searching for device…'
              : 'Install: pip install meshtastic'}
          </span>
          {status.local_id && (
            <span className="mesh-local-id">{status.local_id}</span>
          )}
        </div>
      </div>

      {/* Body: node list + map */}
      <div className="mesh-body">

        {/* Node list */}
        <div className="mesh-nodelist">
          <div className="mesh-section-title">
            Nodes
            {nodes.length > 0 && <span className="mesh-count">{nodes.length}</span>}
          </div>

          {sorted.length === 0 ? (
            <div className="mesh-empty">
              {status.connected ? 'No nodes heard yet' : 'Waiting for device…'}
            </div>
          ) : sorted.map(node => (
            <div
              key={node.node_id}
              className={`mesh-node-row${isOnline(node) ? ' online' : ''}${selected === node.node_id ? ' selected' : ''}`}
              onClick={() => setSelected(selected === node.node_id ? null : node.node_id)}
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
                  <span style={{ color: battColor(node.battery_level) }}>
                    🔋 {node.battery_level}%
                  </span>
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
          <MapContainer
            center={[30, -20]}
            zoom={2}
            style={{ height: '100%', width: '100%' }}
            zoomControl
            scrollWheelZoom
          >
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
                    <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#0ea5e9' }}>
                      {node.short_name}
                    </div>
                    {node.long_name && (
                      <div style={{ fontSize: '0.82rem', marginTop: 2 }}>{node.long_name}</div>
                    )}
                    <div style={{ fontSize: '0.7rem', color: '#888', marginTop: 4 }}>
                      {node.node_id}
                    </div>
                    {node.hw_model && (
                      <div style={{ fontSize: '0.7rem', color: '#666', marginTop: 2 }}>
                        {node.hw_model}
                      </div>
                    )}
                    <div style={{
                      fontSize: '0.7rem', marginTop: 6,
                      borderTop: '1px solid #eee', paddingTop: 4,
                      display: 'flex', gap: 8, flexWrap: 'wrap',
                    }}>
                      {node.battery_level != null && <span>🔋 {node.battery_level}%</span>}
                      {node.snr  != null && <span>SNR {node.snr?.toFixed(1)}</span>}
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

      {/* Message log */}
      <div className="mesh-msgpanel">
        <div className="mesh-section-title">
          Messages
          {messages.length > 0 && <span className="mesh-count">{messages.length}</span>}
        </div>
        <div className="mesh-msg-log">
          {messages.length === 0 ? (
            <div className="mesh-empty" style={{ padding: '6px 12px' }}>No messages yet</div>
          ) : messages.map(m => (
            <div key={m.id} className="mesh-msg-row">
              <span className="mesh-msg-time">{fmtTs(m.timestamp)}</span>
              <span className="mesh-msg-from">{m.from_short}</span>
              <span className="mesh-msg-text">{m.text}</span>
              {m.snr != null && (
                <span className="mesh-msg-snr">
                  SNR {m.snr >= 0 ? '+' : ''}{m.snr.toFixed(1)}
                </span>
              )}
            </div>
          ))}
          <div ref={msgEndRef} />
        </div>
      </div>

    </div>
  )
}
