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
  const displayRef = useRef<HTMLCanvasElement>(null)
  const offscreenRef = useRef<HTMLCanvasElement | null>(null)
  const wsRef = useRef<WebSocket | null>(null)
  const rowBuf = useRef<Float32Array[]>([])
  const rafRef = useRef<number>(0)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const display = displayRef.current
    const container = containerRef.current
    if (!display || !container) return

    const offscreen = document.createElement('canvas')
    offscreen.width = N_FFT
    offscreenRef.current = offscreen

    const ro = new ResizeObserver(entries => {
      for (const e of entries) {
        const h = Math.floor(e.contentRect.height)
        display.width = N_FFT
        display.height = h
        offscreen.height = h
      }
    })
    ro.observe(container)

    const ws = new WebSocket('/ws/waterfall')
    ws.binaryType = 'arraybuffer'
    wsRef.current = ws
    ws.onmessage = e => { rowBuf.current.push(new Float32Array(e.data)) }

    function frame() {
      if (!display) return
      const ctx = display.getContext('2d')
      const off = offscreenRef.current
      if (!ctx || !off || off.height === 0) { rafRef.current = requestAnimationFrame(frame); return }
      const octx = off.getContext('2d')!

      while (rowBuf.current.length > 0) {
        const row = rowBuf.current.shift()!
        octx.drawImage(off, 0, 0, N_FFT, off.height-1, 0, 1, N_FFT, off.height-1)
        const img = octx.createImageData(N_FFT, 1)
        for (let i = 0; i < N_FFT; i++) {
          const [r,g,b] = dbToRgb(row[i])
          img.data[i*4]=r; img.data[i*4+1]=g; img.data[i*4+2]=b; img.data[i*4+3]=255
        }
        octx.putImageData(img, 0, 0)
      }

      ctx.drawImage(off, 0, 0, display.width, display.height)

      // Freq axis
      ctx.fillStyle='rgba(0,0,0,0.6)'
      ctx.fillRect(0, display.height-18, display.width, 18)
      ctx.fillStyle='#aaa'; ctx.font='10px monospace'; ctx.textAlign='center'
      const bw = 2.4e6
      const ticks = [-1.0, -0.5, 0, 0.5, 1.0]
      for (const t of ticks) {
        const x = ((t+1)/2) * display.width
        const f = (centerFreqHz + t*bw/2)/1e6
        ctx.fillText(f.toFixed(3)+'M', x, display.height-4)
      }

      rafRef.current = requestAnimationFrame(frame)
    }
    rafRef.current = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(rafRef.current)
      ws.close()
      ro.disconnect()
    }
  }, [centerFreqHz])

  return (
    <div ref={containerRef} style={{width:'100%',height:'100%',background:'#000',position:'relative'}}>
      <canvas ref={displayRef} style={{width:'100%',height:'100%',display:'block'}}/>
    </div>
  )
}
