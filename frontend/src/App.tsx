import { useState, useEffect } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import './App.css'
import Home from './pages/Home'
import DMRPage from './pages/DMRPage'
import TrunkPage from './pages/TrunkPage'
import ADSBPage from './pages/ADSBPage'
import APRSPage from './pages/APRSPage'
import MeshtasticPage from './pages/MeshtasticPage'
import AirbandPage from './pages/AirbandPage'
import SSTVPage from './pages/SSTVPage'
import AX25Page from './pages/AX25Page'
import RadioPage from './pages/RadioPage'
import MeteorPage from './pages/MeteorPage'
import SatellitePage from './pages/SatellitePage'

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 768px)')
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mq.addEventListener('change', handler)
    return () => mq.removeEventListener('change', handler)
  }, [])
  return isMobile
}

const MODE_LABEL: Record<string, string> = {
  dmr: 'DMR', airband: 'AIRBAND', adsb: 'ADS-B', sstv: 'SSTV',
  aprs: 'APRS', meteor: 'METEOR', trunk: 'TRUNK',
}

// Which mode device 0 is in, visible from every page — it's the #1 answer
// to "why is this page empty".
function SdrModeBadge() {
  const [mode, setMode] = useState('')
  useEffect(() => {
    let alive = true
    const poll = () => fetch('/api/sdr/mode').then(r => r.json())
      .then(d => { if (alive) setMode(d.mode) }).catch(() => { if (alive) setMode('') })
    poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])
  return (
    <NavLink to="/" end className="sdr-pill" title="Device 0's current mode — change it on the home page">
      <span className="sdr-pill-label">SDR</span>
      <span className={'sdr-pill-mode' + (mode ? '' : ' off')}>{mode ? MODE_LABEL[mode] ?? mode : '—'}</span>
    </NavLink>
  )
}

const NAV_LINKS = [
  { to: '/dmr',         label: 'DMR' },
  { to: '/trunk',       label: 'Trunk' },
  { to: '/adsb',        label: 'ADS-B' },
  { to: '/aprs',        label: 'APRS' },
  { to: '/ax25',        label: 'AX.25' },
  { to: '/radio',       label: 'Radio TX' },
  { to: '/meshtastic',  label: 'Meshtastic' },
  { to: '/airband',     label: 'Airband' },
  { to: '/sstv',        label: 'SSTV' },
  { to: '/meteor',      label: 'METEOR' },
  { to: '/satellite',   label: 'Satellite' },
]

export default function App() {
  const isMobile = useIsMobile()
  return (
    <div className={`app-shell${isMobile ? ' mobile' : ''}`}>
      <nav className="app-nav">
        <NavLink to="/" end className="app-nav-brand">🛰 HamPi</NavLink>
        <div className="app-nav-links">
          {NAV_LINKS.map(l => (
            <NavLink
              key={l.to}
              to={l.to}
              className={({ isActive }) => 'app-nav-link' + (isActive ? ' active' : '')}
            >
              {l.label}
            </NavLink>
          ))}
        </div>
        <SdrModeBadge />
      </nav>
      <div className="app-content">
        <Routes>
          <Route path="/"           element={<Home />} />
          <Route path="/dmr"        element={<DMRPage />} />
          <Route path="/trunk"      element={<TrunkPage />} />
          <Route path="/adsb"       element={<ADSBPage />} />
          <Route path="/aprs"       element={<APRSPage />} />
          <Route path="/ax25"       element={<AX25Page />} />
          <Route path="/radio"      element={<RadioPage />} />
          <Route path="/meshtastic" element={<MeshtasticPage />} />
          <Route path="/airband"    element={<AirbandPage />} />
          <Route path="/sstv"       element={<SSTVPage />} />
          <Route path="/meteor"     element={<MeteorPage />} />
          <Route path="/satellite"  element={<SatellitePage />} />
        </Routes>
      </div>
    </div>
  )
}
