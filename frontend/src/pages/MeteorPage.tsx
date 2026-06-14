import { useEffect, useRef, useState, useCallback } from 'react'

interface Status {
  running: boolean
  freq: number
  pipeline: string
  snr: number
  images: number
  last_log: string
}
interface Img { path: string; url: string }
interface Pass { aos_ts: number; max_ts?: number; los_ts?: number; max_el?: number }
interface MeteorSat {
  norad: number; name: string; freq: number; mode: string; desc: string
  el?: number; visible?: boolean; has_tle: boolean; next_pass?: Pass | null
}

function countdown(ts: number): string {
  const s = Math.round(ts - Date.now() / 1000)
  if (s <= 0) return 'now'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m${String(s % 60).padStart(2, '0')}s`
}

export default function MeteorPage() {
  const [st, setSt]         = useState<Status | null>(null)
  const [images, setImages] = useState<Img[]>([])
  const [sats, setSats]     = useState<MeteorSat[]>([])
  const [mode, setMode]     = useState('')
  const [lightbox, setLightbox] = useState<string | null>(null)
  const [switching, setSwitching] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)

  const fetchImages = useCallback(() => {
    fetch('/api/meteor/images').then(r => r.json()).then(setImages).catch(() => {})
  }, [])

  useEffect(() => {
    fetch('/api/meteor/status').then(r => r.json()).then(setSt).catch(() => {})
    fetch('/api/sdr/mode').then(r => r.json()).then(d => setMode(d.mode)).catch(() => {})
    fetchImages()
    const passPoll = () => fetch('/api/sat/meteor').then(r => r.json())
      .then(d => setSats(d.satellites || [])).catch(() => {})
    passPoll()
    const id = setInterval(passPoll, 5000)

    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(`ws://${location.host}/ws/meteor`)
      wsRef.current = ws
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => console.error('METEOR WS error')
      ws.onmessage = e => {
        try {
          const msg = JSON.parse(e.data)
          if (msg.type === 'status') setSt(msg)
          else if (msg.type === 'image') fetchImages()
        } catch { /* */ }
      }
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); wsRef.current?.close(); clearInterval(id) }
  }, [fetchImages])

  async function enableMeteor() {
    setSwitching(true)
    try { const r = await fetch('/api/sdr/mode?mode=meteor', { method: 'POST' }); setMode((await r.json()).mode) } catch { /* */ }
    setSwitching(false)
  }

  const active = mode === 'meteor'
  const snrPct = Math.min(100, Math.max(0, Math.round((st?.snr ?? 0) / 20 * 100)))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 10, padding: 12 }}>
      <div className="header">
        <span className="header-title">🌍 METEOR LRPT</span>
        <span className="header-freq">{((st?.freq ?? 137900000) / 1e6).toFixed(3)} MHz QPSK</span>
        <span className={'badge ' + (active && st?.running ? 'badge-green' : 'badge-red')}>
          {active && st?.running ? '● Decoding' : '○ Idle'}
        </span>
        {active && st && (
          <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#888' }}>
            SNR {st.snr.toFixed(1)} dB
            <span style={{ width: 80, height: 8, background: '#222', display: 'inline-block' }}>
              <span style={{ width: `${snrPct}%`, height: '100%', background: snrPct > 40 ? '#33ff66' : '#ffaa33', display: 'block' }} />
            </span>
          </span>
        )}
      </div>

      {!active && (
        <div style={{ padding: 10, background: '#10181f', border: '1px solid #3a7', color: '#7fd' }}>
          METEOR uses the RTL-SDR exclusively (QPSK, not FM). Start it to retune device 0 to{' '}
          {((st?.freq ?? 137900000) / 1e6).toFixed(3)} MHz and run SatDump.{' '}
          <button className="btn" onClick={enableMeteor} disabled={switching}>
            {switching ? 'switching…' : 'Switch to METEOR mode'}
          </button>
          <div style={{ color: '#789', fontSize: 12, marginTop: 6 }}>
            Catch a pass — LRPT only transmits while the satellite is above the horizon.
          </div>
        </div>
      )}

      {/* Pass prediction */}
      <div style={{ border: '1px solid #333', background: '#0c0c0c', padding: 10, fontSize: 13 }}>
        <div style={{ color: '#3a7', fontWeight: 600, marginBottom: 4 }}>🛰 METEOR passes</div>
        {sats.length === 0 && <div style={{ color: '#888' }}>No TLEs loaded.</div>}
        {sats.map(s => (
          <div key={s.norad} style={{ display: 'grid', gridTemplateColumns: '1fr auto auto', gap: 10, padding: '4px 0', borderTop: '1px solid #1c1c1c', alignItems: 'center' }}>
            <span title={s.desc}>{s.name} <span style={{ color: '#666', fontSize: 11 }}>{(s.freq / 1e6).toFixed(3)} {s.mode}</span></span>
            <span style={{ color: s.visible ? '#33ff66' : '#666', textAlign: 'right' }}>
              {s.el != null ? `${s.visible ? '↑' : '↓'}${s.el}°` : '—'}
            </span>
            <span style={{ color: '#888', minWidth: 110, textAlign: 'right', fontSize: 12 }}>
              {s.visible ? 'OVERHEAD' : (s.next_pass ? `AOS in ${countdown(s.next_pass.aos_ts)}${s.next_pass.max_el ? ` · ${s.next_pass.max_el}°` : ''}` : 'no pass 3d')}
            </span>
          </div>
        ))}
      </div>

      {active && st?.last_log && (
        <div style={{ fontFamily: 'monospace', fontSize: 11, color: '#5a5', background: '#000', border: '1px solid #222', padding: '4px 8px', overflowX: 'auto', whiteSpace: 'nowrap' }}>
          {st.last_log}
        </div>
      )}

      {/* Image gallery */}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        <div style={{ color: '#888', fontSize: 12, marginBottom: 6 }}>
          MSU-MR products <span style={{ color: '#555' }}>({images.length})</span>
        </div>
        {images.length === 0 ? (
          <div style={{ color: '#555', padding: 12 }}>
            No images yet. Decoded MSU-MR composites appear here after a successful pass.
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 8 }}>
            {images.map(img => (
              <div key={img.path} onClick={() => setLightbox(img.url)} title={img.path}
                   style={{ cursor: 'pointer', border: '1px solid #222', background: '#111' }}>
                <img src={img.url} alt={img.path} loading="lazy" style={{ width: '100%', display: 'block' }} />
                <div style={{ fontSize: 10, color: '#888', padding: '2px 4px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {img.path.split('/').pop()}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {lightbox && (
        <div onClick={() => setLightbox(null)}
             style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.9)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <img src={lightbox} alt="METEOR" onClick={e => e.stopPropagation()}
               style={{ maxWidth: '95%', maxHeight: '95%', objectFit: 'contain' }} />
        </div>
      )}
    </div>
  )
}
