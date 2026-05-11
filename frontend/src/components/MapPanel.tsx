import { useEffect, useRef, useState } from 'react'
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

interface MapContact {
  src_id:   number
  callsign: string
  name:     string
  city:     string
  state:    string
  dst_id:   number
  timeslot: number
  lat:      number
  lon:      number
  lastSeen: number
}

// Glowing green dot — matches dashboard theme, avoids default icon path issues
const pinIcon = L.divIcon({
  html: '<div style="width:11px;height:11px;background:#00ff88;border-radius:50%;border:2px solid #fff;box-shadow:0 0 8px #00ff88,0 0 2px #fff"></div>',
  className: '',
  iconSize:    [11, 11],
  iconAnchor:  [5,  5],
  popupAnchor: [0, -8],
})

export default function MapPanel() {
  const [contacts, setContacts] = useState<MapContact[]>([])
  const wsRef    = useRef<WebSocket | null>(null)
  const lookedUp = useRef<Set<number>>(new Set())

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(`ws://${location.host}/ws/dmr`)
      wsRef.current = ws

      ws.onmessage = e => {
        const f = JSON.parse(e.data)
        if (f.frame_type !== 'VOICE' || !f.src_id) return
        if (lookedUp.current.has(f.src_id)) {
          // Update lastSeen for already-known contacts
          setContacts(prev => prev.map(c =>
            c.src_id === f.src_id ? { ...c, lastSeen: Date.now() } : c
          ))
          return
        }

        lookedUp.current.add(f.src_id)
        fetch(`/api/lookup/${f.src_id}`)
          .then(r => r.json())
          .then(d => {
            if (d.lat == null || d.lon == null) return
            setContacts(prev => {
              if (prev.some(c => c.src_id === f.src_id)) return prev
              return [...prev, {
                src_id:   f.src_id,
                callsign: d.callsign || f.alias || String(f.src_id),
                name:     d.name     || '',
                city:     d.city     || '',
                state:    d.state    || '',
                dst_id:   f.dst_id   || 0,
                timeslot: f.timeslot,
                lat:      d.lat,
                lon:      d.lon,
                lastSeen: Date.now(),
              }]
            })
          })
          .catch(() => {})
      }

      ws.onclose = () => setTimeout(connect, 3000)
      ws.onerror = () => console.error('Map WS error')
    }
    connect()
    return () => { wsRef.current?.close() }
  }, [])

  return (
    <div style={{ position: 'relative', height: '100%', width: '100%' }}>
      {/* contact count badge */}
      <div style={{
        position: 'absolute', top: 6, right: 8, zIndex: 1000,
        fontSize: '0.65rem', color: '#888', pointerEvents: 'none',
      }}>
        {contacts.length > 0 && `${contacts.length} pinned`}
      </div>

      <MapContainer
        center={[30, -20]}
        zoom={2}
        style={{ height: '100%', width: '100%' }}
        zoomControl
        scrollWheelZoom
        attributionControl
      >
        <TileLayer
          url="https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png"
          attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>'
          subdomains="abcd"
          maxZoom={19}
        />
        {contacts.map(c => (
          <Marker key={c.src_id} position={[c.lat, c.lon]} icon={pinIcon}>
            <Popup>
              <div style={{ fontFamily: 'monospace', minWidth: 150 }}>
                <div style={{ fontWeight: 'bold', fontSize: '1rem', color: '#059669' }}>
                  {c.callsign}
                </div>
                {c.name && (
                  <div style={{ fontSize: '0.8rem', marginTop: 2 }}>{c.name}</div>
                )}
                {c.city && (
                  <div style={{ fontSize: '0.75rem', color: '#666', marginTop: 1 }}>
                    {c.city}{c.state ? `, ${c.state}` : ''}
                  </div>
                )}
                <div style={{ fontSize: '0.7rem', color: '#888', marginTop: 4, borderTop: '1px solid #eee', paddingTop: 3 }}>
                  ID {c.src_id} · TS{c.timeslot + 1}{c.dst_id > 0 ? ` · TG${c.dst_id}` : ''}
                </div>
                <div style={{ marginTop: 4 }}>
                  <a
                    href={`https://www.qrz.com/db/${c.callsign}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ fontSize: '0.7rem', color: '#059669' }}
                  >
                    QRZ →
                  </a>
                </div>
              </div>
            </Popup>
          </Marker>
        ))}
      </MapContainer>
    </div>
  )
}
