import { Link } from 'react-router-dom'
import { Cpu } from 'lucide-react'
import { useMode, MODE_LABEL } from '../mode'
import { StatusDot } from './ui'

/** Top-bar summary of device 0: who owns it, and whether that's what was requested. */
export default function ModeStatus() {
  const { actualMode, intendedMode, switching, switchErr } = useMode()
  const actual = actualMode ? MODE_LABEL[actualMode] : '—'

  let tone: 'green' | 'amber' | 'red' | 'gray' = 'green'
  let detail = ''
  if (switching) { tone = 'amber'; detail = `switching to ${MODE_LABEL[switching]}` }
  else if (switchErr) { tone = 'red'; detail = 'last switch failed' }
  else if (!actualMode) { tone = 'gray'; detail = 'unknown' }
  else if (actualMode !== intendedMode) { tone = 'amber'; detail = `requested ${MODE_LABEL[intendedMode]}` }

  const cls = tone === 'amber' ? ' warn' : tone === 'red' ? ' err' : ''
  return (
    <Link to="/" className={`topbar-chip${cls}`} title="SDR device 0 — open the dashboard to change mode">
      <Cpu size={14} aria-hidden />
      <span>SDR 0</span>
      <b>{actual}</b>
      <StatusDot tone={tone} pulse={!!switching} />
      {detail && <span className="hide-xs">{detail}</span>}
    </Link>
  )
}
