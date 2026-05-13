import { useEffect, useRef } from 'react'

interface Props {
  centerFreqHz: number
  onClickTune?: (freq: number) => void
}

const MIN_DB = -100, MAX_DB = -20, N_FFT = 1024, BW = 2.4e6

function dbToRgb(db: number): [number, number, number] {
  const t = Math.max(0, Math.min(1, (db - MIN_DB) / (MAX_DB - MIN_DB)))
  if (t < 0.2) { const s = t / 0.2;         return [0, 0, Math.round(s * 200)] }
  if (t < 0.4) { const s = (t - 0.2) / 0.2; return [0, Math.round(s * 255), 200] }
  if (t < 0.6) { const s = (t - 0.4) / 0.2; return [0, 255, Math.round(200 * (1 - s))] }
  if (t < 0.8) { const s = (t - 0.6) / 0.2; return [Math.round(s * 255), 255, 0] }
  const s = (t - 0.8) / 0.2; return [255, Math.round(255 * (1 - s)), 0]
}

export default function Waterfall({ centerFreqHz, onClickTune }: Props) {
  const displayRef   = useRef<HTMLCanvasElement>(null)
  const pingRef      = useRef<HTMLCanvasElement | null>(null)
  const pongRef      = useRef<HTMLCanvasElement | null>(null)
  const wsRef        = useRef<WebSocket | null>(null)
  const rowBuf       = useRef<Float32Array[]>([])
  const rafRef       = useRef<number>(0)
  const containerRef = useRef<HTMLDivElement>(null)
  const heightRef    = useRef<number>(0)
  const hoverXRef    = useRef<number | null>(null)

  // Keep a ref to onClickTune so the rAF loop can read it without stale closure
  const onClickTuneRef = useRef(onClickTune)
  onClickTuneRef.current = onClickTune

  const centerFreqRef = useRef(centerFreqHz)
  centerFreqRef.current = centerFreqHz

  useEffect(() => {
    const display   = displayRef.current
    const container = containerRef.current
    if (!display || !container) return

    const ping = document.createElement('canvas')
    const pong = document.createElement('canvas')
    ping.width = pong.width = N_FFT
    pingRef.current = ping
    pongRef.current = pong

    let pendingH = 0
    const ro = new ResizeObserver(entries => {
      for (const e of entries) pendingH = Math.floor(e.contentRect.height)
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

      while (rowBuf.current.length > 0) {
        const row  = rowBuf.current.shift()!
        const src  = pingRef.current!
        const dst  = pongRef.current!
        const dctx = dst.getContext('2d')!

        dctx.drawImage(src, 0, 0, N_FFT, h - 1, 0, 1, N_FFT, h - 1)

        const img = dctx.createImageData(N_FFT, 1)
        for (let i = 0; i < N_FFT; i++) {
          const [r, g, b] = dbToRgb(row[i])
          img.data[i * 4] = r; img.data[i * 4 + 1] = g; img.data[i * 4 + 2] = b; img.data[i * 4 + 3] = 255
        }
        dctx.putImageData(img, 0, 0)

        pingRef.current = dst
        pongRef.current = src
      }

      ctx.drawImage(pingRef.current!, 0, 0, display.width, display.height)

      // Frequency axis
      ctx.fillStyle = 'rgba(0,0,0,0.6)'
      ctx.fillRect(0, h - 18, display.width, 18)
      ctx.fillStyle = '#aaa'; ctx.font = '10px monospace'; ctx.textAlign = 'center'
      const cf = centerFreqRef.current
      for (const t of [-1.0, -0.5, 0, 0.5, 1.0]) {
        const x = ((t + 1) / 2) * display.width
        ctx.fillText(((cf + t * BW / 2) / 1e6).toFixed(3) + 'M', x, h - 4)
      }

      // Hover crosshair
      const hx = hoverXRef.current
      if (hx !== null && onClickTuneRef.current) {
        ctx.strokeStyle = 'rgba(0,255,136,0.75)'
        ctx.lineWidth = 1
        ctx.beginPath(); ctx.moveTo(hx, 0); ctx.lineTo(hx, h - 20); ctx.stroke()

        const hFreqMHz = (cf + (hx / N_FFT - 0.5) * BW) / 1e6
        const label = hFreqMHz.toFixed(4) + ' MHz'
        ctx.font = '10px monospace'
        ctx.textAlign = hx > N_FFT / 2 ? 'right' : 'left'
        ctx.fillStyle = '#00ff88'
        ctx.fillText(label, hx + (hx > N_FFT / 2 ? -6 : 6), 14)
      }

      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafRef.current)
      wsRef.current?.close()
      ro.disconnect()
    }
  }, [])  // no deps — uses refs for centerFreq and onClickTune

  function freqFromX(clientX: number, rect: DOMRect): number {
    const ratio = (clientX - rect.left) / rect.width
    return Math.round(centerFreqRef.current + (ratio - 0.5) * BW)
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (!onClickTuneRef.current) return
    const rect = e.currentTarget.getBoundingClientRect()
    hoverXRef.current = ((e.clientX - rect.left) / rect.width) * N_FFT
  }

  function handleMouseLeave() {
    hoverXRef.current = null
  }

  function handleClick(e: React.MouseEvent<HTMLDivElement>) {
    if (!onClickTuneRef.current) return
    onClickTuneRef.current(freqFromX(e.clientX, e.currentTarget.getBoundingClientRect()))
  }

  function handleTouchStart(e: React.TouchEvent<HTMLDivElement>) {
    if (!onClickTuneRef.current) return
    e.preventDefault()
    const touch = e.touches[0]
    onClickTuneRef.current(freqFromX(touch.clientX, e.currentTarget.getBoundingClientRect()))
  }

  return (
    <div
      ref={containerRef}
      style={{ width: '100%', height: '100%', background: '#000', cursor: onClickTune ? 'crosshair' : 'default' }}
      onClick={handleClick}
      onMouseMove={handleMouseMove}
      onMouseLeave={handleMouseLeave}
      onTouchStart={handleTouchStart}
    >
      <canvas ref={displayRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </div>
  )
}
