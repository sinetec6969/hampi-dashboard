import { Link } from 'react-router-dom'
import { useMode, MODE_LABEL } from '../mode'

export default function ModeLock() {
  const { actualMode, intendedMode } = useMode()
  const actualLabel = actualMode ? MODE_LABEL[actualMode] : '—'
  const intendedLabel = MODE_LABEL[intendedMode]
  const match = actualMode !== null && actualMode === intendedMode

  return (
    <Link to="/" className="rx-modelock" title="device 0 mode vs your intended mode — set INTENT on the home page"
      style={{
        display: 'flex', alignItems: 'center', gap: 8,
        border: `1px solid ${match ? '#1d4030' : '#5a1622'}`,
        padding: '5px 10px', background: match ? '#07120c' : '#160709',
        fontFamily: "'IBM Plex Mono', monospace",
      }}>
      <span style={{ fontSize: 10, letterSpacing: 2, color: match ? '#00ff88' : '#ff3355' }}>
        {match ? `MODE LOCK · ${actualLabel}` : `MISMATCH · DEV0=${actualLabel} INTENT=${intendedLabel}`}
      </span>
      <span className={match ? undefined : 'rx-blink-fast'} style={{
        width: 14, height: 14, borderRadius: '50%',
        background: match ? '#00ff88' : '#ff3355',
        boxShadow: `0 0 16px ${match ? '#00ff88' : '#ff3355'}`,
      }} />
    </Link>
  )
}
