import { useEffect, useRef } from 'react'

interface Props { centerFreqHz: number }

const MIN_DB = -100, MAX_DB = -20, N_FFT = 1024

function dbToRgb(db: number): [number,number,number] {
  const t = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)))
  if (t < 0.2)  { const s=t/0.2;       return [0, 0, Math.round(s*200)] }
  if (t < 0.4)  { const s=(t-0.2)/0.2; return [0, Math.round(s*255), 200] }
  if (t < 0.6)  { const s=(t-0.4)/0.2; return [0, 255, Math.round(200*(1-s))] }
  if (t < 0.8)  { const s=(t-0.6)/0.2; return [Math.round(s*255), 255, 0] }
  const s=(t-0.8)/0.2; return [255, Math.round(255*(1-s)), 0]
}

export default function Waterfall({ centerFreqHz }: Props) {
  const displayRef   = useRef<HTMLCanvasElement>(null)
  // Two off-screen canvases: ping and pong — avoids drawing a canvas onto itself
  const pingRef      = useRef<HTMLCanvasElement | null>(null)
  const pongRef      = useRef<HTMLCanvasElement | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)
  const rowBuf       = useRef<Float32Array[]>([])
  const rafRef       = useRef<number>(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const heightRef    = useRef<number>(0)

  useEffect(() => {
    const display   = displayRef.current
    const container = containerRef.current
    if (!display || !container) return

    const ping = document.createElement('canvas')
    const pong = document.createElement('canvas')
    ping.width = pong.width = N_FFT
    pingRef.current = ping
    pongRef.current = pong

    // Debounce resize: defer canvas dimension updates to rAF so the
    // ResizeObserver callback never synchronously mutates the canvas,
    // which would re-trigger the observer and create an infinite loop.
    let pendingH = 0
    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        pendingH = Math.floor(e.contentRect.height)
      }
    })
    ro.observe(container)

    function connect() {
      const ws = new WebSocket(`ws://${location.host}/ws/waterfall`)
      ws.binaryType = 'arraybuffer'
      wsRef.current = ws
      ws.onmessage = e => { rowBuf.current.push(new Float32Array(e.data)) }
      ws.onerror   = () => console.error('Waterfall WebSocket error')
      ws.onclose   = () => setTimeout(connect, 3000)
    }
    connect()

    function frame() {
      if (!display) { rafRef.current = requestAnimationFrame(frame); return }

      // Apply any pending resize (safe: outside ResizeObserver callback)
      if (pendingH > 1 && pendingH !== heightRef.current) {
        heightRef.current = pendingH
        display.width  = N_FFT
        display.height = pendingH
        ping.height    = pendingH
        pong.height    = pendingH
      }

      const h = heightRef.current
      if (h < 2) { rafRef.current = requestAnimationFrame(frame); return }

      const ctx = display.getContext('2d')
      if (!ctx) { rafRef.current = requestAnimationFrame(frame); return }

      // Drain the row buffer — one new FFT row scrolls the waterfall down by 1px.
      // We ping-pong between two canvases to avoid self-copy (which can fail on
      // low-memory GPU drivers like the Pi's VideoCore IV).
      while (rowBuf.current.length > 0) {
        const row  = rowBuf.current.shift()!
        const src  = pingRef.current!
        const dst  = pongRef.current!
        const dctx = dst.getContext('2d')!

        // Copy src rows 0..h-2 into dst starting at row 1 (scroll down 1px)
        dctx.drawImage(src, 0, 0, N_FFT, h - 1, 0, 1, N_FFT, h - 1)

        // Paint new FFT row at top of dst
        const img = dctx.createImageData(N_FFT, 1)
        for (let i = 0; i < N_FFT; i++) {
          const [r,g,b] = dbToRgb(row[i])
          img.data[i*4]=r; img.data[i*4+1]=g; img.data[i*4+2]=b; img.data[i*4+3]=255
        }
        dctx.putImageData(img, 0, 0)

        // Swap ping/pong
        pingRef.current = dst
        pongRef.current = src
      }

      // Blit current ping to the visible display canvas
      ctx.drawImage(pingRef.current!, 0, 0, display.width, display.height)

      // Frequency axis overlay
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(0, h - 18, display.width, 18)
      ctx.fillStyle = '#aaa'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
      const bw = 2.4e6
      for (const t of [-1.0, -0.5, 0, 0.5, 1.0]) {
        const x = ((t + 1) / 2) * display.width
        const f = (centerFreqHz + t * bw / 2) / 1e6
        ctx.fillText(f.toFixed(3) + 'M', x, h - 4)
      }

      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafRef.current)
      wsRef.current?.close()
      ro.disconnect()
    }
  }, [centerFreqHz])

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: '#000' }}>
      <canvas ref={displayRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
}
