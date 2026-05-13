import { useEffect, useState } from 'react'

interface Props {
  freq: number
  gain: number
  onFreqChange: (f: number) => void
  onGainChange: (g: number) => void
  onTune: (freq: number, gain: number) => void
  msg: string
}

export default function Controls({ freq, gain, onFreqChange, onGainChange, onTune, msg }: Props) {
  const [clients, setClients] = useState<Record<string, number>>({})

  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(d => setClients(d.clients || {}))
  }, [])

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: '0.8rem' }}>
      <label>Freq (Hz):
        <input type="number" value={freq} onChange={e => onFreqChange(Number(e.target.value))}
          style={{ width: 120, marginLeft: 6 }} />
      </label>
      <label>Gain: {gain.toFixed(1)}dB
        <input type="range" min={0} max={50} step={0.1} value={gain}
          onChange={e => onGainChange(Number(e.target.value))} style={{ marginLeft: 6, width: 80 }} />
      </label>
      <button className="btn" onClick={() => onTune(freq, gain)}>Tune</button>
      {msg && <span style={{ color: '#00ff88' }}>{msg}</span>}
      <span style={{ color: '#555', fontSize: '0.7rem' }}>
        WF:{clients.waterfall || 0} DMR:{clients.dmr || 0} AUD:{clients.audio || 0}
      </span>
    </div>
  )
}
