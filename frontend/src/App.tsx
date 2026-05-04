import { useState } from 'react'
import './App.css'
import Waterfall from './components/Waterfall'
import DMRPanel from './components/DMRPanel'
import AudioPlayer from './components/AudioPlayer'
import Controls from './components/Controls'

export default function App() {
  const [freq, setFreq] = useState(438800000)
  const [_gain, setGain] = useState(49.6)

  return (
    <>
      <div className="header">
        <span className="header-title">🛰 HamPi SDR</span>
        <span className="header-freq">{(freq/1e6).toFixed(4)} MHz</span>
        <Controls onTune={(f,g)=>{setFreq(f);setGain(g)}}/>
      </div>
      <div className="main">
        <div className="waterfall-wrap">
          <Waterfall centerFreqHz={freq}/>
        </div>
        <div className="bottom-row">
          <DMRPanel/>
          <AudioPlayer/>
        </div>
      </div>
    </>
  )
}
