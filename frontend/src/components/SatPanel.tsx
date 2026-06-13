import { useEffect, useState, useCallback } from 'react'

interface Pass { aos_ts: number; max_ts?: number; los_ts?: number; max_el?: number }
interface Sat {
  norad: number; name: string; freq: number; mode: string; desc: string
  tracked: boolean; has_tle: boolean
  el?: number; az?: number; range_km?: number
  doppler_hz?: number; rx_freq?: number; visible?: boolean
  next_pass?: Pass | null
}
interface SatResp {
  qth: { grid?: string; lat?: number; lon?: number }
  tracked: number | null
  sstv_active?: boolean
  satellites: Sat[]
}

function countdown(ts: number): string {
  const s = Math.round(ts - Date.now() / 1000)
  if (s <= 0) return 'now'
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60)
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  return `${m}m${String(s % 60).padStart(2, '0')}s`
}
const mhz = (hz?: number) => hz ? (hz / 1e6).toFixed(4) : '—'

export default function SatPanel() {
  const [data, setData]   = useState<SatResp | null>(null)
  const [open, setOpen]   = useState<number | null>(null)
  const [busy, setBusy]   = useState(false)

  const refresh = useCallback(() => {
    fetch('/api/sat/sstv').then(r => r.json()).then(setData).catch(() => {})
  }, [])
  useEffect(() => { refresh(); const id = setInterval(refresh, 4000); return () => clearInterval(id) }, [refresh])

  async function track(norad: number) {
    setBusy(true)
    try { await fetch(`/api/sat/track?norad=${norad}`, { method: 'POST' }) } catch { /* */ }
    setBusy(false)
    refresh()
  }

  if (!data) return null
  const sats = data.satellites

  return (
    <div style={{ border: '1px solid #333', background: '#0c0c0c', padding: 10, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
        <span style={{ color: '#ff8800', fontWeight: 600 }}>🛰 SSTV Satellites</span>
        <span style={{ color: '#666', fontSize: 11 }}>
          QTH {data.qth.grid} · {data.qth.lat?.toFixed(2)},{data.qth.lon?.toFixed(2)}
          {!data.sstv_active && ' · (tracking auto-tunes in SSTV mode)'}
        </span>
      </div>

      {sats.length === 0 && (
        <div style={{ color: '#888', padding: 8 }}>No TLEs loaded — AMSAT unreachable?</div>
      )}

      {sats.map(s => {
        const up = s.visible
        return (
          <div key={s.norad} style={{ borderTop: '1px solid #1d1d1d', padding: '6px 0' }}>
            <div
              onClick={() => setOpen(open === s.norad ? null : s.norad)}
              style={{ display: 'grid', gridTemplateColumns: '1fr auto auto auto', gap: 8, cursor: 'pointer', alignItems: 'center' }}
            >
              <span style={{ color: s.tracked ? '#33ff66' : '#ddd' }}>
                {s.tracked ? '▶ ' : ''}{s.name}
              </span>
              <span style={{ color: up ? '#33ff66' : '#666', minWidth: 64, textAlign: 'right' }}>
                {s.el != null ? `${up ? '↑' : '↓'}${s.el}°` : '—'}
              </span>
              <span style={{ color: '#888', minWidth: 96, textAlign: 'right', fontSize: 12 }}>
                {up ? 'OVERHEAD' : (s.next_pass ? `in ${countdown(s.next_pass.aos_ts)}` : 'no pass 3d')}
              </span>
              <span style={{ color: '#555', fontSize: 11 }}>{open === s.norad ? '▲' : '▼'}</span>
            </div>

            {open === s.norad && (
              <div style={{ marginTop: 6, paddingLeft: 4, color: '#aaa', fontSize: 12, lineHeight: 1.5 }}>
                <div style={{ marginBottom: 4 }}>{s.desc}</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, color: '#888' }}>
                  <span>downlink <b style={{ color: '#ccc' }}>{mhz(s.freq)}</b> MHz</span>
                  <span>{s.mode}</span>
                  {s.doppler_hz != null && <span>Doppler <b style={{ color: s.doppler_hz >= 0 ? '#33ff66' : '#ff8844' }}>{s.doppler_hz >= 0 ? '+' : ''}{s.doppler_hz}</b> Hz</span>}
                  {s.rx_freq != null && <span>RX <b style={{ color: '#ccc' }}>{mhz(s.rx_freq)}</b> MHz</span>}
                  {s.az != null && <span>az {s.az}°</span>}
                  {s.range_km != null && <span>{s.range_km} km</span>}
                </div>
                {s.next_pass && (
                  <div style={{ color: '#777', marginTop: 4 }}>
                    next pass: AOS {new Date(s.next_pass.aos_ts * 1000).toLocaleTimeString()} ·
                    max {s.next_pass.max_el}° · LOS {s.next_pass.los_ts ? new Date(s.next_pass.los_ts * 1000).toLocaleTimeString() : '—'}
                  </div>
                )}
                <button
                  className="btn"
                  disabled={busy || !s.has_tle}
                  onClick={(e) => { e.stopPropagation(); track(s.tracked ? 0 : s.norad) }}
                  style={{ marginTop: 8 }}
                >
                  {s.tracked ? 'Stop tracking' : 'Track (Doppler-tune)'}
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
