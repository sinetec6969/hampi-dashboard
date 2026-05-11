import { useState, useCallback } from 'react'
import './App.css'
import Waterfall from './components/Waterfall'
import DMRPanel from './components/DMRPanel'
import AudioPlayer from './components/AudioPlayer'
import Controls from './components/Controls'
import ContactsPanel from './components/ContactsPanel'
import MapPanel from './components/MapPanel'

export default function App() {
  const [freq, setFreq] = useState(438800000)

  const handleTune = useCallback((f: number, _g: number) => { setFreq(f) }, [])

  return (
    <>
      <div className="header">
        <span className="header-title">🛰 HamPi SDR</span>
        <span className="header-freq">{(freq/1e6).toFixed(4)} MHz</span>
        <Controls onTune={handleTune}/>
      </div>
      <div className="main">
        <div className="waterfall-wrap">
          <Waterfall centerFreqHz={freq}/>
        </div>
        <div className="bottom-row">
          <DMRPanel/>
          <ContactsPanel/>
          <AudioPlayer/>
        </div>
        <div className="map-wrap">
          <MapPanel/>
        </div>
      </div>
    </>
  )
}
