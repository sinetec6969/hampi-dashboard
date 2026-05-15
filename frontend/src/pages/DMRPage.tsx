import { useState, useEffect } from 'react'
import Waterfall from '../components/Waterfall'
import DMRPanel from '../components/DMRPanel'
import AudioPlayer from '../components/AudioPlayer'
import Controls from '../components/Controls'
import ContactsPanel from '../components/ContactsPanel'
import MapPanel from '../components/MapPanel'
import MemoryChannels from '../components/MemoryChannels'
import CallHistory from '../components/CallHistory'

export default function DMRPage() {
  const [freq, setFreq] = useState(438800000)
  const [gain, setGain] = useState(49.6)
  const [tuneMsg, setTuneMsg] = useState('')

  useEffect(() => {
    fetch('/api/status').then(r => r.json()).then(d => {
      setFreq(d.freq)
      setGain(d.gain)
    })
  }, [])

  async function tuneTo(f: number, g: number) {
    const r = await fetch(`/api/tune?freq=${f}&gain=${g}`, { method: 'POST' })
    if (r.ok) {
      setFreq(f)
      setGain(g)
      setTuneMsg('Tuned ✓')
      setTimeout(() => setTuneMsg(''), 2000)
    } else {
      setTuneMsg('Error')
    }
  }

  return (
    <>
      <div className="header">
        <span className="header-title">🛰 HamPi SDR</span>
        <span className="header-freq">{(freq / 1e6).toFixed(4)} MHz</span>
        <Controls
          freq={freq} gain={gain}
          onFreqChange={setFreq} onGainChange={setGain}
          onTune={tuneTo} msg={tuneMsg}
        />
      </div>
      <MemoryChannels currentFreq={freq} currentGain={gain} onRecall={tuneTo} />
      <div className="main">
        <div className="left-col">
          <div className="waterfall-wrap">
            <Waterfall centerFreqHz={freq} onClickTune={f => tuneTo(f, gain)} />
          </div>
          <div className="bottom-row">
            <DMRPanel />
            <ContactsPanel />
            <AudioPlayer />
          </div>
          <div className="map-wrap">
            <MapPanel />
          </div>
        </div>
        <div className="right-col">
          <CallHistory />
        </div>
      </div>
    </>
  )
}
