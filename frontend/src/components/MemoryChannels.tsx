import { useState } from 'react'

interface Channel { id: string; name: string; freq: number; gain: number }
interface Props { currentFreq: number; currentGain: number; onRecall: (freq: number, gain: number) => void }

const STORAGE_KEY = 'hampi-memory-channels'

function load(): Channel[] {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]') }
  catch { return [] }
}

function persist(chs: Channel[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(chs))
}

export default function MemoryChannels({ currentFreq, currentGain, onRecall }: Props) {
  const [channels, setChannels] = useState<Channel[]>(load)

  function save(chs: Channel[]) { setChannels(chs); persist(chs) }

  function addChannel() {
    const name = prompt('Channel name:')
    if (!name?.trim()) return
    const ch: Channel = { id: crypto.randomUUID(), name: name.trim(), freq: currentFreq, gain: currentGain }
    save([...channels, ch])
  }

  function deleteChannel(id: string, e: React.MouseEvent) {
    e.stopPropagation()
    save(channels.filter(c => c.id !== id))
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 6,
      padding: '4px 12px', background: '#050a07',
      borderBottom: '1px solid #0d2418', overflowX: 'auto',
      flexShrink: 0, minHeight: 32,
    }}>
      <span style={{ color: '#3d6b52', whiteSpace: 'nowrap', fontSize: '0.7rem', letterSpacing: 1 }}>MEM</span>
      {channels.length === 0 && (
        <span style={{ color: '#1d4030', fontSize: '0.7rem' }}>no channels saved</span>
      )}
      {channels.map(ch => (
        <div key={ch.id}
          onClick={() => onRecall(ch.freq, ch.gain)}
          style={{
            display: 'flex', alignItems: 'center', gap: 4,
            background: '#07120c', border: '1px solid #123322',
            padding: '2px 6px',
            whiteSpace: 'nowrap', cursor: 'pointer',
            userSelect: 'none',
          }}
          onMouseEnter={e => (e.currentTarget.style.borderColor = '#00ff88')}
          onMouseLeave={e => (e.currentTarget.style.borderColor = '#123322')}
        >
          <span style={{ color: '#00ff88', fontSize: '0.72rem' }}>{ch.name}</span>
          <span style={{ color: '#4d7a62', fontSize: '0.68rem', marginLeft: 2 }}>{(ch.freq / 1e6).toFixed(4)}</span>
          <button
            onClick={e => deleteChannel(ch.id, e)}
            style={{
              background: 'none', border: 'none', color: '#3d6b52',
              cursor: 'pointer', padding: '0 0 0 2px', lineHeight: 1,
              fontSize: '0.85rem',
            }}
            onMouseEnter={e => (e.currentTarget.style.color = '#ff3355')}
            onMouseLeave={e => (e.currentTarget.style.color = '#3d6b52')}
          >×</button>
        </div>
      ))}
      <button className="btn" onClick={addChannel}
        style={{ padding: '2px 8px', fontSize: '0.7rem', marginLeft: 4, flexShrink: 0 }}>
        + Save
      </button>
    </div>
  )
}
