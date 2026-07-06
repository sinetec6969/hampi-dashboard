import { wsUrl } from '../ws'
import { useEffect, useRef, useState } from 'react'

interface Contact {
  src_id:    number
  callsign:  string   // talker alias or RadioID lookup
  name:      string
  city:      string
  state:     string
  dst_id:    number
  timeslot:  number
  lastSeen:  number   // Date.now()
}

const MAX_CONTACTS = 50

export default function ContactsPanel() {
  const [contacts, setContacts] = useState<Contact[]>([])
  const wsRef   = useRef<WebSocket | null>(null)
  // Track which src_ids we've already kicked off a lookup for
  const lookedUp = useRef<Set<number>>(new Set())

  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/dmr'))
      wsRef.current = ws

      ws.onmessage = e => {
        const f = JSON.parse(e.data)
        if (f.frame_type !== 'VOICE' || !f.src_id) return

        const now = Date.now()

        setContacts(prev => {
          const idx = prev.findIndex(c => c.src_id === f.src_id)
          const existing = idx >= 0 ? prev[idx] : null

          const updated: Contact = {
            src_id:   f.src_id,
            callsign: f.alias || existing?.callsign || '',
            name:     existing?.name  || '',
            city:     existing?.city  || '',
            state:    existing?.state || '',
            dst_id:   f.dst_id   || existing?.dst_id   || 0,
            timeslot: f.timeslot,
            lastSeen: now,
          }

          let next = idx >= 0
            ? [...prev.slice(0, idx), updated, ...prev.slice(idx + 1)]
            : [updated, ...prev]

          next = next
            .sort((a, b) => b.lastSeen - a.lastSeen)
            .slice(0, MAX_CONTACTS)

          return next
        })

        // Kick off RadioID lookup once per src_id if we don't have a callsign
        if (!f.alias && !lookedUp.current.has(f.src_id)) {
          lookedUp.current.add(f.src_id)
          fetch(`/api/lookup/${f.src_id}`)
            .then(r => r.json())
            .then(d => {
              if (!d.callsign) return
              setContacts(prev => prev.map(c =>
                c.src_id === f.src_id
                  ? { ...c, callsign: d.callsign, name: d.name, city: d.city, state: d.state }
                  : c
              ))
            })
            .catch(() => {})
        }
      }

      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('Contacts WS error')
    }
    connect()
    return () => {
      alive = false
      if (retry) clearTimeout(retry)
      wsRef.current?.close()
    }
  }, [])

  function qrzLink(callsign: string) {
    return `https://www.qrz.com/db/${encodeURIComponent(callsign)}`
  }

  function fmt(ts: number) {
    return new Date(ts).toLocaleTimeString()
  }

  return (
    <div className="panel" style={{ flex: '2', display: 'flex', flexDirection: 'column', overflowY: 'hidden' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
        <span className="panel-title">Contacts</span>
        <span style={{ marginLeft: 'auto', fontSize: '0.65rem', color: '#444' }}>{contacts.length}</span>
      </div>

      <div style={{ overflowY: 'auto', flex: 1 }}>
        {contacts.length === 0 && (
          <div style={{ color: '#444', fontSize: '0.7rem' }}>Nobody heard yet — callers stack up here as voice frames decode.</div>
        )}
        {contacts.map(c => (
          <div key={c.src_id} style={{
            borderBottom: '1px solid #1a1a1a',
            padding: '3px 0',
            fontSize: '0.7rem',
          }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 4, flexWrap: 'wrap' }}>
              <span className="badge badge-blue">TS{c.timeslot + 1}</span>
              {c.dst_id > 0 && (
                <span style={{ color: '#555', fontSize: '0.65rem' }}>TG{c.dst_id}</span>
              )}
              {c.callsign ? (
                <a
                  href={qrzLink(c.callsign)}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: '#00ff88', fontWeight: 'bold', textDecoration: 'none', fontSize: '0.78rem' }}
                >
                  {c.callsign}
                </a>
              ) : (
                <span style={{ color: '#888' }}>{c.src_id}</span>
              )}
              <span style={{ color: '#444', fontSize: '0.62rem', marginLeft: 'auto' }}>{fmt(c.lastSeen)}</span>
            </div>
            {(c.name || c.city) && (
              <div style={{ color: '#666', fontSize: '0.65rem', paddingLeft: 4, marginTop: 1 }}>
                {c.name}{c.city ? `  ${c.city}${c.state ? ', ' + c.state : ''}` : ''}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}
