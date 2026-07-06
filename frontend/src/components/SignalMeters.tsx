interface Props { sig: number; snr: number }

const N = 24

function segColor(i: number, top: string): string {
  if (i < 15) return '#00b95f'
  if (i < 20) return '#7dffb8'
  return top
}

function Meter({ label, value, unit, lit, top }: {
  label: string; value: number; unit: string; lit: number; top: string
}) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <span style={{ fontSize: 9, letterSpacing: 2, color: '#3d6b52', width: 28 }}>{label}</span>
      <div style={{ display: 'flex', gap: 2, flex: 1 }}>
        {Array.from({ length: N }, (_, i) => {
          const on = i < lit
          const c = on ? segColor(i, top) : '#0d2418'
          return <span key={i} style={{ flex: 1, height: 9, background: c, boxShadow: on ? `0 0 5px ${c}` : 'none' }} />
        })}
      </div>
      <span style={{ fontFamily: "'VT323', monospace", fontSize: 17, color: '#7dffb8', width: 76, textAlign: 'right' }}>
        {value.toFixed(1)} {unit}
      </span>
    </div>
  )
}

export default function SignalMeters({ sig, snr }: Props) {
  const sigLit = Math.round(Math.max(0, Math.min(1, (sig + 100) / 80)) * N)
  const snrLit = Math.round(Math.max(0, Math.min(1, snr / 40)) * N)
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', gap: 7,
      padding: '9px 14px', background: '#050a07', borderBottom: '1px solid #123322',
    }}>
      <Meter label="SIG" value={sig} unit="dBFS" lit={sigLit} top="#ff3355" />
      <Meter label="SNR" value={snr} unit="dB" lit={snrLit} top="#ffb000" />
    </div>
  )
}
