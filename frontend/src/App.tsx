import { useState, useEffect, type ComponentType } from 'react'
import { Routes, Route, NavLink, Link, useLocation } from 'react-router-dom'
import {
  LayoutDashboard, RadioTower, AudioWaveform, Mic, Network, Radar, MessageSquareText,
  MapPin, SquareTerminal, Waypoints, Plane, Image, CloudSun, Satellite, Antenna,
  Bluetooth, Siren, Clock, Menu, X, Activity,
} from 'lucide-react'
import './App.css'
import { useMode, type SdrMode } from './mode'
import ModeStatus from './components/ModeStatus'
import { StatusDot } from './components/ui'
import Home from './pages/Home'
import DMRPage from './pages/DMRPage'
import TrunkPage from './pages/TrunkPage'
import ADSBPage from './pages/ADSBPage'
import APRSPage from './pages/APRSPage'
import MeshtasticPage from './pages/MeshtasticPage'
import ScannerPage from './pages/ScannerPage'
import SSTVPage from './pages/SSTVPage'
import AX25Page from './pages/AX25Page'
import RadioPage from './pages/RadioPage'
import MeteorPage from './pages/MeteorPage'
import SubGHzPage from './pages/SubGHzPage'
import BLEPage from './pages/BLEPage'
import PagerPage from './pages/PagerPage'
import WebSDRPage from './pages/WebSDRPage'
import SatellitePage from './pages/SatellitePage'
import HamClockPage from './pages/HamClockPage'
import AllScanPage from './pages/AllScanPage'

interface NavDef { to: string; label: string; icon: ComponentType; sdr?: SdrMode }
const NAV: { group: string; items: NavDef[] }[] = [
  { group: 'Monitoring', items: [
    { to: '/',        label: 'Dashboard', icon: LayoutDashboard },
    { to: '/websdr',  label: 'WebSDR',    icon: AudioWaveform, sdr: 'websdr' },
    { to: '/allscan', label: 'AllScan',   icon: RadioTower },
  ] },
  { group: 'Voice & scanning', items: [
    { to: '/dmr',     label: 'DMR',     icon: Mic,               sdr: 'dmr' },
    { to: '/trunk',   label: 'Trunk',   icon: Network,           sdr: 'trunk' },
    { to: '/scanner', label: 'Scanner', icon: Radar,             sdr: 'scanner' },
    { to: '/pager',   label: 'Pager',   icon: MessageSquareText, sdr: 'pager' },
  ] },
  { group: 'Packet & data', items: [
    { to: '/aprs',       label: 'APRS',       icon: MapPin,         sdr: 'aprs' },
    { to: '/ax25',       label: 'AX.25',      icon: SquareTerminal, sdr: 'aprs' },
    { to: '/meshtastic', label: 'Meshtastic', icon: Waypoints },
  ] },
  { group: 'Air & satellite', items: [
    { to: '/adsb',      label: 'ADS-B',     icon: Plane,     sdr: 'adsb' },
    { to: '/sstv',      label: 'SSTV',      icon: Image,     sdr: 'sstv' },
    { to: '/meteor',    label: 'METEOR',    icon: CloudSun,  sdr: 'meteor' },
    { to: '/satellite', label: 'Satellite', icon: Satellite },
  ] },
  { group: 'Spectrum & devices', items: [
    { to: '/subghz', label: 'Sub-GHz',  icon: Antenna, sdr: 'subghz' },
    { to: '/ble',    label: 'BLE',      icon: Bluetooth },
    { to: '/radio',  label: 'Radio TX', icon: Siren },
  ] },
  { group: 'Tools', items: [
    { to: '/hamclock', label: 'HamClock', icon: Clock },
  ] },
]
const pad = (n: number) => String(n).padStart(2, '0')

function Clock24() {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 1000); return () => clearInterval(t) }, [])
  return (
    <div className="topbar-clock" title="local · UTC">
      <span>{pad(now.getHours())}:{pad(now.getMinutes())}:{pad(now.getSeconds())}</span>
      <span>{pad(now.getUTCHours())}:{pad(now.getUTCMinutes())}Z</span>
    </div>
  )
}

export default function App() {
  const { actualMode, online } = useMode()
  const [navOpen, setNavOpen] = useState(false)
  const location = useLocation()
  // close the phone drawer whenever the route changes
  const [lastPath, setLastPath] = useState(location.pathname)
  if (lastPath !== location.pathname) { setLastPath(location.pathname); setNavOpen(false) }

  return (
    <div className={`shell${navOpen ? ' nav-open' : ''}`}>
      <header className="topbar">
        <button className="btn btn-ghost topbar-menu" aria-label={navOpen ? 'Close navigation' : 'Open navigation'}
          onClick={() => setNavOpen(v => !v)}>
          {navOpen ? <X /> : <Menu />}
        </button>
        <Link to="/" className="brand" aria-label="HamPi dashboard">
          <span className="brand-mark"><Activity /></span>
          <span className="brand-text">
            <span className="brand-name">HamPi</span>
            <span className="brand-sub">RF Monitoring Console</span>
          </span>
        </Link>
        <div className="topbar-status">
          <ModeStatus />
          <span className={`topbar-chip hide-sm${online === false ? ' err' : ''}`}
            title="backend reachability (polled every 5 s)">
            <StatusDot tone={online === null ? 'gray' : online ? 'green' : 'red'} />
            {online === null ? 'Connecting' : online ? 'Online' : 'Offline'}
          </span>
          <Clock24 />
        </div>
      </header>

      <nav className="sidebar" aria-label="Modes">
        {NAV.map(g => (
          <div key={g.group} className="nav-group">
            <div className="nav-group-label">{g.group}</div>
            {g.items.map(({ to, label, icon: Icon, sdr }) => (
              <NavLink key={to} to={to} end={to === '/'} title={label}
                className={({ isActive }) => 'nav-item' + (isActive ? ' active' : '')}>
                <Icon />
                <span className="nav-label">{label}</span>
                {sdr && actualMode === sdr && <span className="nav-live"><StatusDot tone="green" title="owns device 0" /></span>}
              </NavLink>
            ))}
          </div>
        ))}
      </nav>
      <div className="scrim" onClick={() => setNavOpen(false)} />

      <main className="main-content">
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
            <Route path="/scanner"    element={<ScannerPage />} />
            <Route path="/sstv"       element={<SSTVPage />} />
            <Route path="/meteor"     element={<MeteorPage />} />
            <Route path="/subghz"     element={<SubGHzPage />} />
            <Route path="/ble"        element={<BLEPage />} />
            <Route path="/pager"      element={<PagerPage />} />
            <Route path="/websdr"     element={<WebSDRPage />} />
            <Route path="/satellite"  element={<SatellitePage />} />
            <Route path="/hamclock"   element={<HamClockPage />} />
            <Route path="/allscan"    element={<AllScanPage />} />
          </Routes>
        </div>
      </main>
    </div>
  )
}
