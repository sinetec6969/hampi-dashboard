interface Props { sig: number; snr: number }

function Meter({ label, value, unit, frac, ticks }: {
  label: string; value: number; unit: string; frac: number; ticks: string[]
}) {
  const pct = Math.round(Math.max(0, Math.min(1, frac)) * 100)
  return (
    <div className="meter">
      <span className="meter-label">{label}</span>
      <div className="meter-track" role="meter" aria-label={label} aria-valuenow={Number(value.toFixed(1))}
        aria-valuemin={0} aria-valuemax={100}>
        <div className="meter-fill" style={{ width: `${pct}%` }} />
        <div className="meter-ticks">{ticks.map(t => <span key={t}>{t}</span>)}</div>
      </div>
      <span className="meter-value mono">{value.toFixed(1)}<small> {unit}</small></span>
    </div>
  )
}

export default function SignalMeters({ sig, snr }: Props) {
  return (
    <div className="meters">
      <Meter label="Signal" value={sig} unit="dBFS" frac={(sig + 100) / 80} ticks={['-100', '-60', '-20']} />
      <Meter label="SNR" value={snr} unit="dB" frac={snr / 40} ticks={['0', '20', '40']} />
    </div>
  )
}
