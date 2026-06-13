import { useState, useEffect } from 'react'
import { Routes, Route, NavLink } from 'react-router-dom'
import './App.css'
import Home from './pages/Home'
import DMRPage from './pages/DMRPage'
import ADSBPage from './pages/ADSBPage'
import APRSPage from './pages/APRSPage'
import MeshtasticPage from './pages/MeshtasticPage'
import AirbandPage from './pages/AirbandPage'
import SSTVPage from './pages/SSTVPage'
import AX25Page from './pages/AX25Page'
import RadioPage from './pages/RadioPage'
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
  { to: '/adsb',        label: 'ADS-B' },
  { to: '/aprs',        label: 'APRS' },
  { to: '/ax25',        label: 'AX.25' },
  { to: '/radio',       label: 'Radio TX' },
  { to: '/meshtastic',  label: 'Meshtastic' },
  { to: '/airband',     label: 'Airband' },
  { to: '/sstv',        label: 'SSTV' },
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
      </nav>
      <div className="app-content">
        <Routes>
          <Route path="/"           element={<Home />} />
          <Route path="/dmr"        element={<DMRPage />} />
          <Route path="/adsb"       element={<ADSBPage />} />
          <Route path="/aprs"       element={<APRSPage />} />
          <Route path="/ax25"       element={<AX25Page />} />
          <Route path="/radio"      element={<RadioPage />} />
          <Route path="/meshtastic" element={<MeshtasticPage />} />
          <Route path="/airband"    element={<AirbandPage />} />
          <Route path="/sstv"       element={<SSTVPage />} />
          <Route path="/satellite"  element={<SatellitePage />} />
        </Routes>
      </div>
    </div>
  )
}
