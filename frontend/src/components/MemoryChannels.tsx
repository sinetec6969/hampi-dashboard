import { useState } from 'react'
import { Plus, X } from 'lucide-react'

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

  function deleteChannel(ch: Channel, e: React.MouseEvent) {
    e.stopPropagation()
    save(channels.filter(c => c.id !== ch.id))
  }

  return (
    <div className="mem-bar">
      <span className="mem-label">Memories</span>
      {channels.length === 0 && <span className="mem-empty">None saved</span>}
      {channels.map(ch => (
        <span key={ch.id} className="mem-chip" role="button" tabIndex={0} title={`Tune ${ch.name} · gain ${ch.gain} dB`}
          onClick={() => onRecall(ch.freq, ch.gain)}
          onKeyDown={e => { if (e.key === 'Enter') onRecall(ch.freq, ch.gain) }}>
          <span className="mem-name">{ch.name}</span>
          <span className="mem-freq mono">{(ch.freq / 1e6).toFixed(4)}</span>
          <button className="mem-del" aria-label={`Delete ${ch.name}`} onClick={e => deleteChannel(ch, e)}><X size={12} /></button>
        </span>
      ))}
      <button className="btn btn-sm btn-ghost" onClick={addChannel}><Plus />Save current</button>
    </div>
  )
}
