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
  sdrMode?: SdrMode   // set when this card is one of the device-0 switcher modes
}

type SdrMode = 'dmr' | 'airband' | 'adsb' | 'sstv' | 'aprs' | 'meteor' | 'trunk'

const MODE_TITLE: Record<SdrMode, string> = {
  dmr: 'DMR', airband: 'Airband', adsb: 'ADS-B', sstv: 'SSTV',
  aprs: 'APRS', meteor: 'METEOR', trunk: 'Trunk',
}

const SDR_MODES: { mode: SdrMode; label: string }[] = [
  { mode: 'dmr',     label: 'DMR' },
  { mode: 'airband', label: 'Airband' },
  { mode: 'adsb',    label: 'ADS-B' },
  { mode: 'sstv',    label: 'SSTV' },
  { mode: 'aprs',    label: 'APRS' },
  { mode: 'meteor',  label: 'METEOR' },
  { mode: 'trunk',   label: 'Trunk' },
]

const MODES: ModeCard[] = [
  {
    path: '/dmr',
    sdrMode: 'dmr',
    icon: '📡',
    title: 'DMR Voice',
    subtitle: 'Digital Mobile Radio',
    description: 'Decode DMR / MOTOTRBO digital voice. Live waterfall, caller map, RadioID lookup, and persistent call history.',
    status: 'live',
    color: '#00ff88',
  },
  {
    path: '/airband',
    sdrMode: 'airband',
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
    sdrMode: 'adsb',
    icon: '✈️',
    title: 'ADS-B',
    subtitle: '1090 MHz Aircraft',
    description: 'Live aircraft map from 1090 MHz transponder broadcasts via rtl_adsb. Altitude, speed, heading, track history, click for details. Switch device 0 here, or give ADS-B its own dongle in config.yaml.',
    status: 'live',
    color: '#4488ff',
  },
  {
    path: '/aprs',
    sdrMode: 'aprs',
    icon: '📻',
    title: 'APRS',
    subtitle: '144.390 MHz Packet',
    description: 'Decode Automatic Packet Reporting System traffic via direwolf. Station map, packet log, and weather data. Switch SDR mode to share device 0.',
    status: 'live',
    color: '#ff8844',
    hardware: 'RTL-SDR + direwolf',
  },
  {
    path: '/ax25',
    sdrMode: 'aprs',
    icon: '📟',
    title: 'AX.25 Terminal',
    subtitle: 'Packet Radio / KISS',
    description: 'Raw AX.25 frame monitor over the shared APRS direwolf TNC. Terminal console, waterfall with click-to-tune, digipeater paths. RX only until TX hardware lands.',
    status: 'live',
    color: '#33ff66',
    hardware: 'direwolf KISS :8001',
  },
  {
    path: '/sstv',
    sdrMode: 'sstv',
    icon: '📺',
    title: 'SSTV',
    subtitle: '145.800 MHz FM',
    description: 'Slow Scan Television decoder. Receives Scottie S1/S2, Martin M1/M2, and Robot 36 images. ISS SSTV events and local 2m activity. Switch SDR mode to share device 0.',
    status: 'live',
    color: '#ff8800',
  },
  {
    path: '/meteor',
    sdrMode: 'meteor',
    icon: '🌍',
    title: 'METEOR LRPT',
    subtitle: '137 MHz Weather',
    description: 'Decode METEOR-M2 LRPT weather imagery (137.9 MHz QPSK) via SatDump. MSU-MR visible/IR composites, Doppler-tracked, with pass prediction. Uses device 0 exclusively — switch SDR mode to catch a pass.',
    status: 'live',
    color: '#33bb88',
    hardware: 'RTL-SDR + satdump',
  },
  {
    path: '/trunk',
    sdrMode: 'trunk',
    icon: '🚔',
    title: 'Trunked DMR',
    subtitle: 'Connect Plus',
    description: 'Track a MOTOTRBO Connect Plus control channel via SDRTrunk. Follows voice grants across LCNs, logs decoded calls, flags encrypted talkgroups. Uses device 0 exclusively — switch SDR mode to hand the dongle to the SDRTrunk service.',
    status: 'live',
    color: '#ffcc33',
    hardware: 'RTL-SDR + SDRTrunk',
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
  const [sdrMode, setSdrMode] = useState<SdrMode | null>(null)
  const [switching, setSwitching] = useState<SdrMode | null>(null)
  const [switchErr, setSwitchErr] = useState('')
  const navigate = useNavigate()

  useEffect(() => {
    fetch('/api/sysinfo').then(r => r.json()).then(setInfo).catch(() => {})
    fetch('/api/sdr/mode').then(r => r.json()).then(d => setSdrMode(d.mode)).catch(() => {})
  }, [])

  async function switchMode(mode: SdrMode) {
    if (mode === sdrMode || switching) return
    setSwitching(mode)
    setSwitchErr('')
    try {
      const r = await fetch(`/api/sdr/mode?mode=${mode}`, { method: 'POST' })
      if (r.ok) {
        const d = await r.json()
        setSdrMode(d.mode)
      } else {
        // switch failed — backend rolled back to DMR; tell the user, don't hide it
        const d = await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))
        setSwitchErr(`${d.detail ?? 'switch failed'} — rolled back. Usually the dongle was still settling; try again in a few seconds.`)
        const cur = await fetch('/api/sdr/mode').then(res => res.json())
        setSdrMode(cur.mode)
      }
    } catch {
      setSwitchErr('Lost the server mid-switch — reload the page and check the service.')
    }
    setSwitching(null)
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
        <div className="sdr-mode-block">
          <div className="sdr-mode-bar">
            <span className="sdr-mode-label">Device 0</span>
            <div className="sdr-mode-toggle">
              {SDR_MODES.map(({ mode, label }) => (
                <button
                  key={mode}
                  className={'sdr-mode-btn'
                    + (sdrMode === mode ? ' sdr-mode-active' : '')
                    + (switching === mode ? ' sdr-mode-pending' : '')}
                  onClick={() => switchMode(mode)}
                  disabled={switching !== null}
                >
                  {switching === mode ? `${label}…` : label}
                </button>
              ))}
            </div>
          </div>
          {switching && (
            <div className="sdr-mode-note">
              stopping {MODE_TITLE[sdrMode]} · starting {MODE_TITLE[switching]} — a failed start rolls back to DMR
            </div>
          )}
          {switchErr && <div className="sdr-mode-error">{switchErr}</div>}
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
              <span style={{ display: 'flex', gap: 6 }}>
                {m.sdrMode && m.sdrMode === sdrMode && (
                  <span className="mode-card-badge badge-active">▶ on device 0</span>
                )}
                <span className={'mode-card-badge ' + (m.status === 'live' ? 'badge-live' : 'badge-soon')}>
                  {m.status === 'live' ? '● Live' : '○ Soon'}
                </span>
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
