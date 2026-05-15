import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'

interface SysInfo {
  hostname: string
  local_ip: string | null
  tailscale_ip: string | null
  version: string
}

interface ModeCard {
  path: string
  icon: string
  title: string
  subtitle: string
  description: string
  status: 'live' | 'coming-soon'
  color: string
  hardware?: string
}

const MODES: ModeCard[] = [
  {
    path: '/dmr',
    icon: '📡',
    title: 'DMR Voice',
    subtitle: 'Digital Mobile Radio',
    description: 'Decode DMR / MOTOTRBO digital voice. Live waterfall, caller map, RadioID lookup, and persistent call history.',
    status: 'live',
    color: '#00ff88',
  },
  {
    path: '/airband',
    icon: '🛩',
    title: 'Airband AM',
    subtitle: 'VHF 118–137 MHz',
    description: 'Receive VHF airband voice with AM demodulation. Scanner mode cycles a configurable frequency list and holds on squelch break.',
    status: 'coming-soon',
    color: '#44ccff',
    hardware: 'RTL-SDR (shared or dedicated)',
  },
  {
    path: '/adsb',
    icon: '✈️',
    title: 'ADS-B',
    subtitle: '1090 MHz Aircraft',
    description: 'Live aircraft map from 1090 MHz transponder broadcasts. Altitude, speed, heading, squawk, and track history.',
    status: 'coming-soon',
    color: '#4488ff',
    hardware: 'Dedicated RTL-SDR + dump1090-fa',
  },
  {
    path: '/aprs',
    icon: '📻',
    title: 'APRS',
    subtitle: '144.390 MHz Packet',
    description: 'Decode Automatic Packet Reporting System traffic. Station map with APRS symbols, packet log, and weather data.',
    status: 'coming-soon',
    color: '#ff8844',
    hardware: 'RTL-SDR + direwolf',
  },
  {
    path: '/meshtastic',
    icon: '🕸️',
    title: 'Meshtastic',
    subtitle: 'LoRa Mesh Network',
    description: 'Monitor a Meshtastic LoRa mesh — node positions, text messages, telemetry, and battery status.',
    status: 'coming-soon',
    color: '#aa66ff',
    hardware: 'Meshtastic USB device',
  },
]

export default function Home() {
  const [info, setInfo] = useState<SysInfo | null>(null)
  const navigate = useNavigate()

  useEffect(() => {
    fetch('/api/sysinfo').then(r => r.json()).then(setInfo).catch(() => {})
  }, [])

  return (
    <div className="home-page">
      <div className="home-hero">
        <div className="home-hero-title">🛰 HamPi Dashboard</div>
        <div className="home-hero-sub">Local RF monitoring — Raspberry Pi</div>
        {info && (
          <div className="home-sysinfo">
            <span className="sysinfo-item">
              <span className="sysinfo-label">host</span>
              <span className="sysinfo-val">{info.hostname}</span>
            </span>
            {info.local_ip && (
              <span className="sysinfo-item">
                <span className="sysinfo-label">local</span>
                <span className="sysinfo-val">{info.local_ip}:8000</span>
              </span>
            )}
            {info.tailscale_ip && (
              <span className="sysinfo-item sysinfo-ts">
                <span className="sysinfo-label">tailscale</span>
                <span className="sysinfo-val">{info.tailscale_ip}:8000</span>
              </span>
            )}
            <span className="sysinfo-item">
              <span className="sysinfo-label">ver</span>
              <span className="sysinfo-val">{info.version}</span>
            </span>
          </div>
        )}
      </div>

      <div className="mode-grid">
        {MODES.map(m => (
          <div
            key={m.path}
            className={'mode-card' + (m.status === 'coming-soon' ? ' mode-card-dim' : '')}
            style={{ '--card-color': m.color } as React.CSSProperties}
            onClick={() => navigate(m.path)}
          >
            <div className="mode-card-top">
              <span className="mode-card-icon">{m.icon}</span>
              <span className={'mode-card-badge ' + (m.status === 'live' ? 'badge-live' : 'badge-soon')}>
                {m.status === 'live' ? '● Live' : '○ Soon'}
              </span>
            </div>
            <div className="mode-card-title">{m.title}</div>
            <div className="mode-card-sub">{m.subtitle}</div>
            <div className="mode-card-desc">{m.description}</div>
            {m.hardware && (
              <div className="mode-card-hw">⚙ {m.hardware}</div>
            )}
          </div>
        ))}
      </div>

      <div className="home-footer">
        <a href="https://github.com/sinetec6969/hampi-dashboard" target="_blank" rel="noreferrer">
          GitHub
        </a>
        {info?.version && <span>v{info.version}</span>}
      </div>
    </div>
  )
}
