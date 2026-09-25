import { wsUrl } from '../ws'
import { useCallback, useEffect, useRef, useState } from 'react'
import AudioPlayer from '../components/AudioPlayer'

interface State {
  running: boolean; center: number; gain: number; sample_rate?: number
  rx_freq?: number; view_center?: number; span?: number; min_span?: number
  mode?: string; bw?: number; modes: string[]; default_bw: Record<string, number>
}
interface Tag { id: string; freq: number; label: string; mode: string; bw: number; notes: string }

const N_BINS = 1024
const STEPS = [10, 100, 500, 1_000, 5_000, 6_250, 12_500, 25_000, 100_000]
const CW_PITCH = 700

function palette(t: number): [number, number, number] {
  t = Math.max(0, Math.min(1, t))
  if (t < 0.25) { const s = t / 0.25; return [0, 0, Math.round(40 + 120 * s)] }
  if (t < 0.5)  { const s = (t - 0.25) / 0.25; return [0, Math.round(200 * s), 160] }
  if (t < 0.75) { const s = (t - 0.5) / 0.25; return [Math.round(255 * s), 220, Math.round(160 * (1 - s))] }
  const s = (t - 0.75) / 0.25; return [255, Math.round(220 * (1 - s) + 35), Math.round(255 * s)]
}

function fmtMHz(f: number, digits = 5) { return (f / 1e6).toFixed(digits) }

function tickStep(span: number): number {
  const raw = span / 8
  const p = 10 ** Math.floor(Math.log10(raw))
  for (const m of [1, 2, 5, 10]) if (m * p >= raw) return m * p
  return 10 * p
}

// Passband edges (absolute Hz) for the current mode — matches websdr.py's filters
function passband(rx: number, mode: string, bw: number): [number, number] {
  if (mode === 'USB') return [rx + 150, rx + bw]
  if (mode === 'LSB') return [rx - bw, rx - 150]
  if (mode === 'CW')  return [rx + CW_PITCH - bw / 2, rx + CW_PITCH + bw / 2]
  return [rx - bw / 2, rx + bw / 2]
}

export default function WebSDRPage() {
  const [st, setSt]       = useState<State | null>(null)
  const [mode, setMode]   = useState('')
  const [tags, setTags]   = useState<Tag[]>([])
  const [step, setStep]   = useState(1_000)
  const [floorDb, setFloorDb] = useState(-95)
  const [rangeDb, setRangeDb] = useState(50)
  const [freqEdit, setFreqEdit] = useState<string | null>(null)
  const [centerEdit, setCenterEdit] = useState<string | null>(null)
  const [err, setErr]     = useState('')
  const [busy, setBusy]   = useState(false)

  const stRef = useRef<State | null>(null)
  const colorRef = useRef({ floorDb, rangeDb })
  useEffect(() => { stRef.current = st; colorRef.current = { floorDb, rangeDb } }, [st, floorDb, rangeDb])
  const wfRef   = useRef<HTMLCanvasElement>(null)
  const specRef = useRef<HTMLCanvasElement>(null)
  const boxRef  = useRef<HTMLDivElement>(null)
  const lastView = useRef<{ voff: number; span: number } | null>(null)
  const lastFrame = useRef<Float32Array | null>(null)
  const dragRef = useRef<{ x0: number; vc0: number; moved: boolean; edge?: 'lo' | 'hi' } | null>(null)
  const postT = useRef(0)

  // ── server state ─────────────────────────────────────────────────────────
  const post = useCallback(async (patch: Partial<State> & { rx_freq?: number }, throttle = false) => {
    const now = Date.now()
    if (throttle && now - postT.current < 80) return
    postT.current = now
    setErr('')
    try {
      const r = await fetch('/api/websdr/state', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch),
      })
      const d = await r.json()
      if (r.ok) setSt(d)
      else setErr(d.detail ?? `HTTP ${r.status}`)
    } catch { setErr('lost the server') }
  }, [])

  const loadTags = useCallback(() => {
    fetch('/api/websdr/tags').then(r => r.json()).then(setTags).catch(() => {})
  }, [])

  useEffect(() => {
    const poll = () => {
      if (dragRef.current) return
      fetch('/api/websdr/state').then(r => r.json()).then(setSt).catch(() => {})
      fetch('/api/sdr/mode').then(r => r.json()).then(d => setMode(d.mode)).catch(() => {})
    }
    poll(); loadTags()
    const id = setInterval(poll, 3000)
    return () => clearInterval(id)
  }, [loadTags])

  // ── spectrum + waterfall stream ──────────────────────────────────────────
  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null

    function drawSpectrum(bins: Float32Array) {
      const c = specRef.current; if (!c) return
      const g = c.getContext('2d')!; const W = c.width, H = c.height
      const { floorDb: lo, rangeDb: rg } = colorRef.current
      g.fillStyle = '#080a0b'; g.fillRect(0, 0, W, H)
      g.strokeStyle = '#252b2c'; g.lineWidth = 1; g.fillStyle = '#66716c'; g.font = '10px monospace'
      for (let db = Math.ceil(lo / 10) * 10; db <= lo + rg; db += 10) {
        const y = H - ((db - lo) / rg) * H
        g.beginPath(); g.moveTo(0, y); g.lineTo(W, y); g.stroke(); g.fillText(`${db}`, 2, y - 2)
      }
      g.beginPath()
      for (let i = 0; i < bins.length; i++) {
        const y = H - ((bins[i] - lo) / rg) * H
        if (i === 0) g.moveTo(0, y); else g.lineTo((i / bins.length) * W, y)
      }
      g.strokeStyle = '#35d07f'; g.stroke()
    }

    function onFrame(buf: ArrayBuffer) {
      const hdr = new Float64Array(buf, 0, 2)
      const voff = hdr[0], span = hdr[1]
      const bins = new Float32Array(buf, 16, N_BINS)
      const c = wfRef.current; if (!c) return
      const g = c.getContext('2d')!; const W = c.width, H = c.height
      const prev = lastView.current
      if (prev && (prev.voff !== voff || prev.span !== span)) {
        // zoom/pan: stretch the history so old lines stay under their frequencies
        const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H
        tmp.getContext('2d')!.drawImage(c, 0, 0)
        g.fillStyle = '#000'; g.fillRect(0, 0, W, H)
        const oldStart = prev.voff - prev.span / 2, newStart = voff - span / 2
        g.drawImage(tmp, ((oldStart - newStart) / span) * W, 0, (prev.span / span) * W, H)
      }
      lastView.current = { voff, span }
      g.drawImage(c, 0, 0, W, H - 1, 0, 1, W, H - 1)
      const line = g.createImageData(W, 1)
      const { floorDb: lo, rangeDb: rg } = colorRef.current
      for (let i = 0; i < W; i++) {
        const [r, gg, b] = palette((bins[i] - lo) / rg)
        line.data.set([r, gg, b, 255], i * 4)
      }
      g.putImageData(line, 0, 0)
      lastFrame.current = bins.slice()
      drawSpectrum(bins)
    }

    function connect() {
      ws = new WebSocket(wsUrl('/ws/websdr'))
      ws.binaryType = 'arraybuffer'
      ws.onmessage = e => onFrame(e.data as ArrayBuffer)
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
    }
    connect()

    const fit = () => {
      const box = boxRef.current, c = wfRef.current; if (!box || !c) return
      const h = Math.max(100, Math.floor(box.clientHeight))
      if (c.height !== h) { c.width = N_BINS; c.height = h; lastView.current = null }
    }
    fit()
    const ro = new ResizeObserver(fit)
    if (boxRef.current) ro.observe(boxRef.current)
    return () => { alive = false; if (retry) clearTimeout(retry); ws?.close(); ro.disconnect() }
  }, [])

  // ── geometry helpers ─────────────────────────────────────────────────────
  const active = mode === 'websdr' && !!st?.running
  const span = st?.span ?? 2.4e6
  const vc = st?.view_center ?? st?.center ?? 0
  const viewStart = vc - span / 2
  const xToHz = (clientX: number, el: HTMLElement) => {
    const r = el.getBoundingClientRect()
    return viewStart + ((clientX - r.left) / r.width) * span
  }
  const pct = (f: number) => ((f - viewStart) / span) * 100
  const snap = (f: number) => Math.round(f / step) * step

  // ── interactions ─────────────────────────────────────────────────────────
  function onWheel(e: React.WheelEvent<HTMLDivElement>) {
    if (!st?.running) return
    const f = xToHz(e.clientX, e.currentTarget)
    const r = e.currentTarget.getBoundingClientRect()
    const ratio = (e.clientX - r.left) / r.width
    const newSpan = Math.min(st.sample_rate ?? 2.4e6, Math.max(st.min_span ?? 2e4, span * (e.deltaY < 0 ? 0.8 : 1.25)))
    post({ span: newSpan, view_center: f - (ratio - 0.5) * newSpan }, true)
  }

  function onDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x0: e.clientX, vc0: vc, moved: false }
  }
  function onMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current; if (!d || d.edge) return
    const dx = e.clientX - d.x0
    if (Math.abs(dx) > 4) d.moved = true
    if (d.moved) post({ view_center: d.vc0 - (dx / e.currentTarget.clientWidth) * span }, true)
  }
  function onUp(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current; dragRef.current = null
    if (d && !d.moved && st?.running) post({ rx_freq: snap(xToHz(e.clientX, e.currentTarget)) })
  }

  // passband edge drag on the scale
  function edgeDown(e: React.PointerEvent<HTMLDivElement>, edge: 'lo' | 'hi') {
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    dragRef.current = { x0: e.clientX, vc0: vc, moved: true, edge }
  }
  function edgeMove(e: React.PointerEvent<HTMLDivElement>) {
    const d = dragRef.current; if (!d?.edge || !st?.rx_freq || !st.mode) return
    const scale = e.currentTarget.parentElement!
    const f = xToHz(e.clientX, scale)
    const rx = st.rx_freq, m = st.mode
    let bw: number
    if (m === 'USB') bw = f - rx
    else if (m === 'LSB') bw = rx - f
    else if (m === 'CW') bw = 2 * Math.abs(f - (rx + CW_PITCH))
    else bw = 2 * Math.abs(f - rx)
    bw = Math.round(Math.max(m === 'CW' ? 50 : 300, Math.min(m === 'WFM' ? 220_000 : 40_000, bw)))
    post({ bw }, true)
  }
  function edgeUp() { dragRef.current = null }

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const s = stRef.current
      if (!s?.running || !s.rx_freq || (e.target as HTMLElement).tagName === 'INPUT') return
      if (e.key === 'ArrowRight') { post({ rx_freq: snap(s.rx_freq) + step }); e.preventDefault() }
      if (e.key === 'ArrowLeft')  { post({ rx_freq: snap(s.rx_freq) - step }); e.preventDefault() }
      if (e.key === '+' || e.key === '=') post({ span: (s.span ?? 2.4e6) * 0.5, view_center: s.rx_freq })
      if (e.key === '-') post({ span: (s.span ?? 2.4e6) * 2 })
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  function commitFreq(v: string | null, field: 'rx_freq' | 'center') {
    if (v === null) return
    const mhz = parseFloat(v)
    if (!isFinite(mhz) || mhz <= 0) return
    const hz = Math.round(mhz * 1e6)
    if (field === 'center') { post({ center: hz }); return }
    // outside the capture → recentre the dongle there first
    const sr = st?.sample_rate ?? 2.4e6
    if (st && Math.abs(hz - st.center) > sr / 2 - 50_000) post({ center: hz, rx_freq: hz })
    else post({ rx_freq: hz, view_center: hz })
  }

  function autoContrast() {
    const b = lastFrame.current; if (!b) return
    const s = Array.from(b).sort((x, y) => x - y)
    const lo = s[Math.floor(s.length * 0.2)] - 3, hi = s[Math.floor(s.length * 0.995)] + 5
    setFloorDb(Math.round(lo)); setRangeDb(Math.max(20, Math.round(hi - lo)))
  }

  async function addTag() {
    if (!st?.rx_freq || !st.mode || st.bw == null) return
    const label = prompt(`Tag ${fmtMHz(st.rx_freq)} MHz ${st.mode} — label:`)
    if (!label?.trim()) return
    await fetch('/api/websdr/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ freq: st.rx_freq, label, mode: st.mode, bw: st.bw }),
    })
    loadTags()
  }
  async function delTag(t: Tag) {
    if (!confirm(`Delete tag "${t.label}" @ ${fmtMHz(t.freq)}?`)) return
    await fetch(`/api/websdr/tags/${t.id}`, { method: 'DELETE' })
    loadTags()
  }
  function gotoTag(t: Tag) {
    const sr = st?.sample_rate ?? 2.4e6
    if (st && Math.abs(t.freq - st.center) > sr / 2 - 50_000) post({ center: t.freq, rx_freq: t.freq, mode: t.mode, bw: t.bw })
    else post({ rx_freq: t.freq, mode: t.mode, bw: t.bw })
  }

  async function enable() {
    setBusy(true)
    try { const r = await fetch('/api/sdr/mode?mode=websdr', { method: 'POST' }); setMode((await r.json()).mode) } catch { /* */ }
    setBusy(false)
    fetch('/api/websdr/state').then(r => r.json()).then(setSt).catch(() => {})
  }

  // ── render ───────────────────────────────────────────────────────────────
  const ts = tickStep(span)
  const ticks: number[] = []
  for (let f = Math.ceil(viewStart / ts) * ts; f <= viewStart + span; f += ts) ticks.push(f)
  const tickDigits = ts >= 1e6 ? 1 : ts >= 1e5 ? 2 : ts >= 1e4 ? 3 : ts >= 1e3 ? 4 : 5
  const pb = st?.rx_freq != null && st.mode && st.bw != null ? passband(st.rx_freq, st.mode, st.bw) : null
  const visibleTags = tags.filter(t => t.freq >= viewStart && t.freq <= viewStart + span)

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', gap: 6, padding: 10 }}>
      <div className="header">
        <span className="header-title">WebSDR</span>
        <span className="header-freq">centre {fmtMHz(st?.center ?? 0, 4)} MHz · span {(span / 1e3).toFixed(span < 1e5 ? 1 : 0)} kHz</span>
        <span className={'badge ' + (active ? 'badge-green' : 'badge-red')}>{active ? '● Live' : '○ Idle'}</span>
        {err && <span style={{ color: '#e05858', fontSize: 11 }}>{err}</span>}
      </div>

      {!active && (
        <div className="mode-banner">
          The WebSDR receiver needs device 0 (rtl_tcp, 2.4 MHz capture). Switching stops the current mode.{' '}
          <button className="btn" onClick={enable} disabled={busy}>{busy ? 'switching…' : 'Switch to WEBSDR mode'}</button>
        </div>
      )}

      {/* controls */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', fontSize: 11, color: '#9aa5a0' }}>
        {freqEdit !== null ? (
          <input autoFocus value={freqEdit} onChange={e => setFreqEdit(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { commitFreq(freqEdit, 'rx_freq'); setFreqEdit(null) } if (e.key === 'Escape') setFreqEdit(null) }}
            onBlur={() => setFreqEdit(null)}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 30, width: 190, background: '#000', color: '#35d07f', border: '1px solid #35d07f' }} />
        ) : (
          <span title="click to type a frequency (MHz)" onClick={() => active && setFreqEdit(fmtMHz(st?.rx_freq ?? 0))}
            style={{ fontFamily: 'var(--font-mono)', fontSize: 34, color: 'var(--text)', cursor: 'text', minWidth: 190 }}>
            {fmtMHz(st?.rx_freq ?? st?.center ?? 0)}
          </span>
        )}
        <span style={{ display: 'flex', gap: 3 }}>
          {(st?.modes ?? ['NFM', 'AM', 'WFM', 'USB', 'LSB', 'CW']).map(m =>
            <button key={m} className={'seg-btn' + ((st?.mode === m) ? ' active' : '')} disabled={!active} onClick={() => post({ mode: m })}>{m}</button>)}
        </span>
        <span>BW <span style={{ color: '#e7ece9' }}>{st?.bw != null ? (st.bw >= 1000 ? `${(st.bw / 1000).toFixed(st.bw % 1000 ? 1 : 0)}k` : st.bw) : '—'}</span></span>
        <span>Step{' '}
          <select value={step} onChange={e => setStep(Number(e.target.value))}>
            {STEPS.map(s => <option key={s} value={s}>{s >= 1000 ? `${s / 1000}k` : s}</option>)}
          </select>
        </span>
        <span style={{ display: 'flex', gap: 3 }}>
          <button className="seg-btn" disabled={!active} onClick={() => post({ span: span * 2 })}>−</button>
          <button className="seg-btn" disabled={!active} onClick={() => post({ span: span / 2, view_center: st?.rx_freq })}>+</button>
          <button className="seg-btn" disabled={!active} onClick={() => post({ span: st?.sample_rate ?? 2.4e6, view_center: st?.center })}>Full</button>
        </span>
        <button className="seg-btn" disabled={!active || !st?.rx_freq} title="retune the dongle so the receiver sits mid-capture"
          onClick={() => st?.rx_freq && post({ center: Math.round(st.rx_freq) })}>Recentre</button>
        {centerEdit !== null ? (
          <input autoFocus value={centerEdit} onChange={e => setCenterEdit(e.target.value)} style={{ width: 90 }}
            onKeyDown={e => { if (e.key === 'Enter') { commitFreq(centerEdit, 'center'); setCenterEdit(null) } if (e.key === 'Escape') setCenterEdit(null) }}
            onBlur={() => setCenterEdit(null)} />
        ) : (
          <button className="seg-btn" disabled={!active} onClick={() => setCenterEdit(fmtMHz(st?.center ?? 0, 4))}>Centre…</button>
        )}
        <span>Gain <input type="range" min={0} max={49.6} step={0.1} value={st?.gain ?? 40} disabled={!active}
          onChange={e => post({ gain: Number(e.target.value) }, true)} style={{ width: 80, verticalAlign: 'middle' }} /> {st?.gain?.toFixed(1)}</span>
        <span>Floor <input type="range" min={-130} max={-40} value={floorDb} onChange={e => setFloorDb(Number(e.target.value))} style={{ width: 70, verticalAlign: 'middle' }} /></span>
        <span>Range <input type="range" min={10} max={90} value={rangeDb} onChange={e => setRangeDb(Number(e.target.value))} style={{ width: 70, verticalAlign: 'middle' }} /></span>
        <button className="seg-btn" onClick={autoContrast}>Auto</button>
        <button className="btn btn-sm" disabled={!active} onClick={addTag}>+ Tag signal</button>
      </div>

      {/* scale: ticks, passband, tags */}
      <div style={{ position: 'relative', height: 44, background: '#0d1011', border: '1px solid #252b2c', overflow: 'hidden', userSelect: 'none', flexShrink: 0 }}
        onPointerMove={edgeMove} onPointerUp={edgeUp}>
        {ticks.map(f => (
          <div key={f} style={{ position: 'absolute', left: `${pct(f)}%`, bottom: 0, height: 8, borderLeft: '1px solid #66716c' }}>
            <span style={{ position: 'absolute', bottom: 8, left: 3, fontSize: 10, color: '#8a9590', whiteSpace: 'nowrap' }}>{fmtMHz(f, tickDigits)}</span>
          </div>
        ))}
        {pb && (
          <div style={{ position: 'absolute', left: `${pct(pb[0])}%`, width: `${Math.max(0.2, pct(pb[1]) - pct(pb[0]))}%`, top: 22, bottom: 0,
                        background: '#35d07f33', borderLeft: '2px solid #35d07f', borderRight: '2px solid #35d07f' }}>
            <div onPointerDown={e => edgeDown(e, 'lo')} style={{ position: 'absolute', left: -6, top: 0, bottom: 0, width: 10, cursor: 'ew-resize' }} />
            <div onPointerDown={e => edgeDown(e, 'hi')} style={{ position: 'absolute', right: -6, top: 0, bottom: 0, width: 10, cursor: 'ew-resize' }} />
          </div>
        )}
        {st?.rx_freq != null && <div style={{ position: 'absolute', left: `${pct(st.rx_freq)}%`, top: 18, bottom: 0, borderLeft: '1px solid #e05858' }} />}
        {visibleTags.map(t => (
          <div key={t.id} title={`${t.label} · ${fmtMHz(t.freq)} ${t.mode} ${t.bw} Hz${t.notes ? ' · ' + t.notes : ''}`}
            style={{ position: 'absolute', left: `${pct(t.freq)}%`, top: 1, transform: 'translateX(-50%)', display: 'flex', alignItems: 'center',
                     gap: 3, fontSize: 10, background: '#2a2112', border: '1px solid #e5a93d', color: '#e5a93d', padding: '0 4px', whiteSpace: 'nowrap', cursor: 'pointer', zIndex: 2 }}>
            <span onClick={() => gotoTag(t)}>▼ {t.label}</span>
            <span onClick={() => delTag(t)} style={{ color: '#8a6a2a' }}>×</span>
          </div>
        ))}
      </div>

      {/* spectrum + waterfall share the click/drag/wheel surface */}
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0, cursor: active ? 'crosshair' : 'default', touchAction: 'none' }}
        onWheel={onWheel} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp}>
        <canvas ref={specRef} width={N_BINS} height={140} style={{ width: '100%', height: 140, display: 'block', background: '#080a0b' }} />
        <div ref={boxRef} style={{ flex: 1, minHeight: 0, background: '#000' }}>
          <canvas ref={wfRef} width={N_BINS} height={300} style={{ width: '100%', height: '100%', display: 'block', imageRendering: 'pixelated' }} />
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 10, color: '#66716c', flexShrink: 0 }}>
        <AudioPlayer wsPath="/ws/websdr/audio" inputRate={48000} label="WebSDR Audio" />
        <span>click = tune · drag = pan · wheel = zoom · ←/→ = step · +/− = zoom · drag passband edges = bandwidth · click a tag to tune it</span>
      </div>
    </div>
  )
}
