import { useState, useEffect } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import './App.css'
import ModeLock from './components/ModeLock'
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

const SCAN_KEY = 'hampi-scanlines'

export default function App() {
  const isMobile = useIsMobile()
  const [scanlines, setScanlines] = useState(() => localStorage.getItem(SCAN_KEY) !== 'off')
  function toggleScanlines() {
    setScanlines(v => { localStorage.setItem(SCAN_KEY, v ? 'off' : 'on'); return !v })
  }
  return (
    <div className={`app-shell${isMobile ? ' mobile' : ''}`}>
      {scanlines && <div className="rx-scanlines" />}
      <nav className="app-nav">
        <NavLink to="/" end className="app-nav-brand">▚ HAMPI://RX</NavLink>
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
        <button onClick={toggleScanlines} title="CRT scanlines" style={{
          background: 'none', border: '1px solid #1d4030', color: scanlines ? '#00ff88' : '#3d6b52',
          cursor: 'pointer', fontFamily: 'inherit', fontSize: 11, padding: '3px 7px', marginLeft: 'auto', marginRight: 8,
        }}>▦</button>
        <ModeLock />
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
