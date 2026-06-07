import { useEffect, useRef, useState, useCallback } from 'react'

interface SSTVStatus {
  state:       'idle' | 'vis_decode' | 'sync_hunt' | 'line_decode' | 'disabled'
  mode:        string
  line:        number
  total_lines: number
  signal_rms:  number
  width:       number
  height:      number
}

interface GalleryItem {
  filename: string
  url:      string
}

const DEFAULT_STATUS: SSTVStatus = {
  state: 'disabled', mode: '', line: 0, total_lines: 0,
  signal_rms: 0, width: 320, height: 256,
}

function stateLabel(s: SSTVStatus['state']): string {
  switch (s) {
    case 'idle':        return 'Waiting for signal'
    case 'vis_decode':  return 'VIS header'
    case 'sync_hunt':   return 'Sync'
    case 'line_decode': return 'Decoding'
    case 'disabled':    return 'SDR not in SSTV mode'
    default:            return s
  }
}

function stateColor(s: SSTVStatus['state']): string {
  if (s === 'line_decode') return '#ff8800'
  if (s === 'vis_decode' || s === 'sync_hunt') return '#ffcc44'
  return '#555'
}

export default function SSTVPage() {
  const [status, setStatus]     = useState<SSTVStatus>(DEFAULT_STATUS)
  const [gallery, setGallery]   = useState<GalleryItem[]>([])
  const [lightbox, setLightbox] = useState<string | null>(null)
  const canvasRef               = useRef<HTMLCanvasElement>(null)
  const imgDataRef              = useRef<ImageData | null>(null)
  const wsRef                   = useRef<WebSocket | null>(null)

  // ── Canvas helpers ─────────────────────────────────────────────────

  const initCanvas = useCallback((w: number, h: number) => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.width  = w
    canvas.height = h
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    imgDataRef.current = ctx.createImageData(w, h)
    // fill black
    imgDataRef.current.data.fill(0)
    for (let i = 3; i < imgDataRef.current.data.length; i += 4)
      imgDataRef.current.data[i] = 255
    ctx.putImageData(imgDataRef.current, 0, 0)
  }, [])

  const drawLine = useCallback((y: number, r: number[], g: number[], b: number[]) => {
    const canvas = canvasRef.current
    const imgData = imgDataRef.current
    if (!canvas || !imgData) return
    const w = canvas.width
    for (let x = 0; x < r.length && x < w; x++) {
      const idx = (y * w + x) * 4
      imgData.data[idx]     = r[x]
      imgData.data[idx + 1] = g[x]
      imgData.data[idx + 2] = b[x]
      imgData.data[idx + 3] = 255
    }
    const ctx = canvas.getContext('2d')
    ctx?.putImageData(imgData, 0, 0)
  }, [])

  // ── Gallery fetch ─────────────────────────────────────────────────

  const fetchGallery = useCallback(() => {
    fetch('/api/sstv/images')
      .then(r => r.json())
      .then(setGallery)
      .catch(() => {})
  }, [])

  // ── WebSocket ─────────────────────────────────────────────────────

  const connect = useCallback(() => {
    const ws = new WebSocket(`ws://${location.host}/ws/sstv`)
    wsRef.current = ws

    ws.onmessage = e => {
      if (typeof e.data !== 'string') return
      try {
        const msg = JSON.parse(e.data)
        if (msg.type === 'status') {
          setStatus(s => {
            if (msg.width !== s.width || msg.height !== s.height ||
                (msg.state === 'sync_hunt' && s.state === 'idle')) {
              initCanvas(msg.width ?? 320, msg.height ?? 256)
            }
            return { ...s, ...msg }
          })
        } else if (msg.type === 'line') {
          drawLine(msg.y, msg.r, msg.g, msg.b)
          setStatus(s => ({ ...s, line: msg.y + 1 }))
        } else if (msg.type === 'image_complete') {
          fetchGallery()
          setStatus(s => ({ ...s, state: 'idle', line: 0 }))
        }
      } catch { /* ignore */ }
    }

    ws.onopen = () => {
      fetch('/api/sstv/status').then(r => r.json()).then(s => {
        setStatus(s)
        initCanvas(s.width ?? 320, s.height ?? 256)
      }).catch(() => {})
    }

    ws.onclose = () => { wsRef.current = null }

    return ws
  }, [drawLine, fetchGallery, initCanvas])

  useEffect(() => {
    initCanvas(320, 256)
    fetchGallery()
    const ws = connect()
    return () => { ws.close() }
  }, [connect, fetchGallery, initCanvas])

  // ── Render ────────────────────────────────────────────────────────

  const pct = status.total_lines > 0
    ? Math.round((status.line / status.total_lines) * 100)
    : 0

  const rmsBar = Math.min(100, Math.round(status.signal_rms * 1000))

  return (
    <div className="sstv-page">
      {/* Header */}
      <div className="sstv-header">
        <span className="sstv-title">📺 SSTV</span>
        <div className="sstv-header-center">
          <span className="sstv-state-dot" style={{ background: stateColor(status.state) }} />
          <span className="sstv-state-label" style={{ color: stateColor(status.state) }}>
            {stateLabel(status.state)}
          </span>
          {status.mode && (
            <span className="sstv-mode-badge">{status.mode}</span>
          )}
        </div>
        <div className="sstv-header-right">
          <span className="sstv-rms-label">RMS</span>
          <div className="sstv-rms-bar-wrap">
            <div className="sstv-rms-bar" style={{ width: `${rmsBar}%` }} />
          </div>
        </div>
      </div>

      {/* Body */}
      <div className="sstv-body">
        {/* Live canvas */}
        <div className="sstv-canvas-panel">
          <div className="sstv-canvas-wrap">
            <canvas ref={canvasRef} className="sstv-canvas" />
          </div>
          {status.state === 'line_decode' && status.total_lines > 0 && (
            <div className="sstv-progress-wrap">
              <div className="sstv-progress-bar" style={{ width: `${pct}%` }} />
              <span className="sstv-progress-label">
                {status.line} / {status.total_lines} lines ({pct}%)
              </span>
            </div>
          )}
          {status.state === 'disabled' && (
            <div className="sstv-hint">
              Switch SDR mode to <strong>SSTV</strong> from the home page.<br />
              Default frequency: 145.800 MHz (ISS SSTV / 2m FM).<br />
              Override with <code>SSTV_FREQ=&lt;Hz&gt;</code> env var.
            </div>
          )}
          {status.state === 'idle' && (
            <div className="sstv-hint">
              Listening on {(145800000 / 1e6).toFixed(3)} MHz FM.<br />
              Waiting for SSTV leader tone (1900 Hz).
            </div>
          )}
        </div>

        {/* Gallery */}
        <div className="sstv-gallery-panel">
          <div className="sstv-gallery-title">
            Received Images
            <span className="sstv-gallery-count">{gallery.length}</span>
          </div>
          {gallery.length === 0 ? (
            <div className="sstv-gallery-empty">No images received yet</div>
          ) : (
            <div className="sstv-gallery-grid">
              {gallery.map(item => (
                <div
                  key={item.filename}
                  className="sstv-gallery-item"
                  onClick={() => setLightbox(item.url)}
                  title={item.filename}
                >
                  <img src={item.url} alt={item.filename} loading="lazy" />
                  <div className="sstv-gallery-label">
                    {item.filename.replace('sstv_', '').replace('.png', '')}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Lightbox */}
      {lightbox && (
        <div className="sstv-lightbox" onClick={() => setLightbox(null)}>
          <img src={lightbox} alt="SSTV" onClick={e => e.stopPropagation()} />
          <button className="sstv-lightbox-close" onClick={() => setLightbox(null)}>✕</button>
        </div>
      )}
    </div>
  )
}
