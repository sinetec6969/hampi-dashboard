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
    description: 'AM demodulation with channel scanner. Cycles Guard, CTAF, Center, and Departure — holds on squelch break. Switch SDR mode from the home page to share a single dongle.',
    status: 'live',
    color: '#44ccff',
  },
  {
    path: '/meshtastic',
    icon: '🕸️',
    title: 'Meshtastic',
    subtitle: 'LoRa Mesh Network',
    description: 'Live mesh monitor via USB serial. Node map, text messages, battery and telemetry. Auto-connects to any attached Meshtastic device.',
    status: 'live',
    color: '#aa66ff',
  },
  {
    path: '/adsb',
    icon: '✈️',
    title: 'ADS-B',
    subtitle: '1090 MHz Aircraft',
    description: 'Live aircraft map from 1090 MHz transponder broadcasts via rtl_adsb. Altitude, speed, heading, track history, click for details. Switch SDR mode or set ADSB_ENABLE=1 for a dedicated dongle.',
    status: 'live',
    color: '#4488ff',
  },
  {
    path: '/aprs',
    icon: '📻',
    title: 'APRS',
    subtitle: '144.390 MHz Packet',
    description: 'Decode Automatic Packet Reporting System traffic via direwolf. Station map, packet log, and weather data. Switch SDR mode to share device 0.',
    status: 'live',
    color: '#ff8844',
    hardware: 'RTL-SDR + direwolf',
  },
  {
    path: '/sstv',
    icon: '📺',
    title: 'SSTV',
    subtitle: '145.800 MHz FM',
    description: 'Slow Scan Television decoder. Receives Scottie S1/S2, Martin M1/M2, and Robot 36 images. ISS SSTV events and local 2m activity. Switch SDR mode to share device 0.',
    status: 'live',
    color: '#ff8800',
  },
  {
    path: '/satellite',
    icon: '🛰️',
    title: 'Satellite Telemetry',
    subtitle: 'TinyGS / LoRa',
    description: 'Live satellite packet reception via TinyGS on LilyGO T3 LoRa32. RSSI, SNR, decoded frames, raw hex. Board connects to local Mosquitto broker — no cloud dependency.',
    status: 'live',
    color: '#00ccff',
    hardware: 'LilyGO T3 V1.6.1',
  },
]

export default function Home() {
  const [info, setInfo] = useState<SysInfo | null>(null)
  const [sdrMode, setSdrMode] = useState<'dmr' | 'airband' | 'adsb' | 'sstv' | 'aprs' | null>(null)
  const [switching, setSwitching] = useState(false)
  const navigate = useNavigate()

  useEffect(() => {
    fetch('/api/sysinfo').then(r => r.json()).then(setInfo).catch(() => {})
    fetch('/api/sdr/mode').then(r => r.json()).then(d => setSdrMode(d.mode)).catch(() => {})
  }, [])

  async function switchMode(mode: 'dmr' | 'airband' | 'adsb' | 'sstv' | 'aprs') {
    if (mode === sdrMode || switching) return
    setSwitching(true)
    try {
      const r = await fetch(`/api/sdr/mode?mode=${mode}`, { method: 'POST' })
      const d = await r.json()
      setSdrMode(d.mode)
    } catch {}
    setSwitching(false)
  }

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

      {sdrMode !== null && (
        <div className="sdr-mode-bar">
          <span className="sdr-mode-label">SDR</span>
          <div className="sdr-mode-toggle">
            <button
              className={'sdr-mode-btn' + (sdrMode === 'dmr' ? ' sdr-mode-active' : '')}
              onClick={() => switchMode('dmr')}
              disabled={switching}
            >
              DMR
            </button>
            <button
              className={'sdr-mode-btn' + (sdrMode === 'airband' ? ' sdr-mode-active' : '')}
              onClick={() => switchMode('airband')}
              disabled={switching}
            >
              Airband
            </button>
            <button
              className={'sdr-mode-btn' + (sdrMode === 'adsb' ? ' sdr-mode-active' : '')}
              onClick={() => switchMode('adsb')}
              disabled={switching}
            >
              ADS-B
            </button>
            <button
              className={'sdr-mode-btn' + (sdrMode === 'sstv' ? ' sdr-mode-active' : '')}
              onClick={() => switchMode('sstv')}
              disabled={switching}
            >
              SSTV
            </button>
            <button
              className={'sdr-mode-btn' + (sdrMode === 'aprs' ? ' sdr-mode-active' : '')}
              onClick={() => switchMode('aprs')}
              disabled={switching}
            >
              APRS
            </button>
          </div>
          {switching && <span className="sdr-mode-switching">switching…</span>}
        </div>
      )}

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
