import { Routes, Route, NavLink } from 'react-router-dom'
import './App.css'
import Home from './pages/Home'
import DMRPage from './pages/DMRPage'
import ADSBPage from './pages/ADSBPage'
import APRSPage from './pages/APRSPage'
import MeshtasticPage from './pages/MeshtasticPage'
import AirbandPage from './pages/AirbandPage'

const NAV_LINKS = [
  { to: '/dmr',         label: 'DMR' },
  { to: '/adsb',        label: 'ADS-B' },
  { to: '/aprs',        label: 'APRS' },
  { to: '/meshtastic',  label: 'Meshtastic' },
  { to: '/airband',     label: 'Airband' },
]

export default function App() {
  return (
    <div className="app-shell">
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
          <Route path="/meshtastic" element={<MeshtasticPage />} />
          <Route path="/airband"    element={<AirbandPage />} />
        </Routes>
      </div>
    </div>
  )
}
