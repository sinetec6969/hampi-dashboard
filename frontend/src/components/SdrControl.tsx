import { Cpu, TriangleAlert, CircleAlert, RotateCcw } from 'lucide-react'
import { useMode, SDR_MODES, MODE_LABEL, type SdrMode } from '../mode'
import { Panel, StatusBadge, Button } from './ui'

/**
 * Device 0 ownership. "Current" is what the backend reports; "Requested" is the
 * operator's intent (persisted per browser) — a mismatch means something else
 * moved the dongle, and is surfaced rather than silently accepted.
 */
export default function SdrControl() {
  const { actualMode, intendedMode, setIntendedMode, switching, switchErr, switchMode, caps } = useMode()
  const mismatch = actualMode !== null && actualMode !== intendedMode

  let badge = <StatusBadge tone="green">Ready</StatusBadge>
  if (switching) badge = <StatusBadge tone="amber" pulse>Switching</StatusBadge>
  else if (switchErr) badge = <StatusBadge tone="red">Switch failed</StatusBadge>
  else if (actualMode === null) badge = <StatusBadge tone="gray">Unknown</StatusBadge>
  else if (mismatch) badge = <StatusBadge tone="amber">Not as requested</StatusBadge>

  function select(m: SdrMode) {
    setIntendedMode(m)
    switchMode(m)
  }

  const unavailable = SDR_MODES.filter(({ mode }) => caps[mode]?.ok === false)

  return (
    <Panel title="SDR device 0" icon={<Cpu />} actions={badge} bordered className="sdr-panel">
      <div className="sdr-rows">
        <div className="sdr-row">
          <span className="metric-label">Current</span>
          <span className="sdr-val">{actualMode ? MODE_LABEL[actualMode] : '—'}</span>
        </div>
        <div className="sdr-row">
          <span className="metric-label">Requested</span>
          <select value={intendedMode} onChange={e => setIntendedMode(e.target.value as SdrMode)}
            aria-label="Requested mode (does not switch)" title="Record what this device should be doing without switching">
            {SDR_MODES.map(({ mode, label }) => <option key={mode} value={mode}>{label}</option>)}
          </select>
          {mismatch && !switching && (
            <Button size="sm" icon={<RotateCcw />} onClick={() => switchMode(intendedMode)}
              disabled={caps[intendedMode]?.ok === false}>Switch to {MODE_LABEL[intendedMode]}</Button>
          )}
        </div>
      </div>

      <div className="section-label sdr-seg-label">Switch mode</div>
      <div className="seg" role="group" aria-label="SDR device 0 mode">
        {SDR_MODES.map(({ mode, label }) => {
          const cap = caps[mode]
          const absent = cap?.ok === false
          const cls = ['seg-btn',
            actualMode === mode && 'active',
            switching === mode && 'pending',
            actualMode !== mode && intendedMode === mode && 'requested',
            absent && 'unavailable'].filter(Boolean).join(' ')
          return (
            <button key={mode} className={cls} disabled={switching !== null || absent}
              aria-pressed={actualMode === mode}
              title={absent ? `Not installed — missing ${cap.missing.join(', ')}. ${cap.hint}` : `Give device 0 to ${label}`}
              onClick={() => select(mode)}>
              {label}{switching === mode && '…'}
            </button>
          )
        })}
      </div>

      {switching && (
        <div className="notice amber sdr-notice">
          <TriangleAlert />
          <span>Stopping {actualMode ? MODE_LABEL[actualMode] : 'current mode'}, starting {MODE_LABEL[switching]}. A failed start rolls back to DMR.</span>
        </div>
      )}
      {switchErr && (
        <div className="notice red sdr-notice" role="alert"><CircleAlert /><span>{switchErr}</span></div>
      )}
      {unavailable.length > 0 && (
        <div className="sdr-unavail">
          Not installed: {unavailable.map(({ mode, label }) => (
            <span key={mode} title={caps[mode]?.hint}>{label} <span className="muted">({caps[mode]?.hint})</span></span>
          ))}
        </div>
      )}
    </Panel>
  )
}
