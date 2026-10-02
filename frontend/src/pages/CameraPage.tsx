import { useEffect, useRef, useState } from 'react'
import { Camera, Play, Square, Maximize, Download } from 'lucide-react'
import { Panel, StatusBadge, Metric, EmptyState } from '../components/ui'

interface CamStatus {
  present: boolean; streaming: boolean; viewers: number; enabled: boolean
  width?: number; height?: number; fps?: number; frames?: number
  last_frame_age?: number | null; error?: string; device?: string
}

export default function CameraPage() {
  const [st, setSt] = useState<CamStatus | null>(null)
  const [live, setLive] = useState(false)
  const [src, setSrc] = useState('')
  const imgRef = useRef<HTMLImageElement>(null)

  function refresh() {
    fetch('/api/camera/status').then(r => r.json()).then(setSt).catch(() => {})
  }
  useEffect(() => {
    refresh()
    const t = setInterval(refresh, 5000)
    return () => { clearInterval(t) }
  }, [])

  // clearing the <img> src drops the HTTP connection → backend stops the camera
  useEffect(() => () => setSrc(''), [])

  function start() {
    setSrc(`/api/camera/stream?t=${Date.now()}`)
    setLive(true)
  }
  function stop() {
    setSrc('')
    setLive(false)
    setTimeout(refresh, 500)
  }
  function fullscreen() {
    imgRef.current?.requestFullscreen?.()
  }

  const present = st?.present
  const badge = !st?.enabled ? <StatusBadge tone="gray">Disabled</StatusBadge>
    : !present ? <StatusBadge tone="red">No camera</StatusBadge>
    : live ? <StatusBadge tone="green" pulse>Live</StatusBadge>
    : <StatusBadge tone="gray">Idle</StatusBadge>

  return (
    <div className="page">
      <div className="header">
        <span className="header-title">Shack Camera</span>
        <span className="muted">{st?.width && st?.height ? `${st.width}×${st.height} · ${st.fps}fps · MJPEG` : 'USB webcam'}</span>
        {badge}
      </div>

      <Panel flush className="cam-panel">
        <div className="cam-stage">
          {live && src ? (
            <img ref={imgRef} className="cam-img" src={src} alt="Shack camera live view"
              onError={() => { setLive(false); setSrc(''); refresh() }} />
          ) : (
            <div className="cam-placeholder">
              {st && !st.enabled ? <EmptyState icon={<Camera />} title="Camera disabled">Set <code>camera.enable: true</code> in config.yaml.</EmptyState>
                : st && !present ? <EmptyState icon={<Camera />} title="No camera detected">{st.error || `Nothing at ${st.device}.`}</EmptyState>
                : <EmptyState icon={<Camera />} title="Camera idle">Click Start to view the shack — the camera only runs while you're watching.</EmptyState>}
            </div>
          )}
        </div>
        <div className="cam-controls">
          {live
            ? <button className="btn btn-danger" onClick={stop}><Square size={15} />Stop</button>
            : <button className="btn btn-primary" onClick={start} disabled={!present}><Play size={15} />Start</button>}
          <a className="btn" href="/api/camera/snapshot" target="_blank" rel="noreferrer" download="shack.jpg">
            <Download size={15} />Snapshot
          </a>
          <button className="btn" onClick={fullscreen} disabled={!live}><Maximize size={15} />Fullscreen</button>
          <div className="cam-stats">
            {st?.streaming && <Metric label="Viewers" value={st.viewers ?? 0} />}
            {st?.last_frame_age != null && <Metric label="Frame age" value={`${st.last_frame_age}s`} />}
          </div>
        </div>
      </Panel>

      {st?.error && live && <div className="notice red"><span>{st.error}</span></div>}
      <p className="muted" style={{ fontSize: 'var(--fs-sm)' }}>
        On-demand MJPEG straight off the webcam (no re-encode). The stream is served over your LAN and
        tailnet without authentication — anyone who can reach the dashboard can view it while it's live.
      </p>
    </div>
  )
}
