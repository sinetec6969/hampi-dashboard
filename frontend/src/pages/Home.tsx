import { useEffect, useRef, useState, type ComponentType } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  Mic, Network, Plane, Radar, MapPin, SquareTerminal, Image, CloudSun, Antenna,
  MessageSquareText, AudioWaveform, Waypoints, Satellite, Bluetooth, Radio, Sun, Moon, Server,
  ChevronRight, Cctv,
} from 'lucide-react'
import { wsUrl } from '../ws'
import { useMode, type SdrMode } from '../mode'
import Waterfall from '../components/Waterfall'
import SignalMeters from '../components/SignalMeters'
import AudioPlayer from '../components/AudioPlayer'
import MemoryChannels from '../components/MemoryChannels'
import SdrControl from '../components/SdrControl'
import { Panel, StatusBadge, StatusDot, Metric, EmptyState, type Tone } from '../components/ui'

interface SysInfo {
  hostname: string
  local_ip: string | null
  tailscale_ip: string | null
  version: string
}

function pad(n: number) { return n.toString().padStart(2, '0') }
function fmtHM(ms: number) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function fmtDur(ms: number) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}` }
function fmtMHz(hz: number) {
  const [i, f] = (hz / 1e6).toFixed(6).split('.')
  return `${i}.${f.slice(0, 3)} ${f.slice(3)}`
}

// ── DMR feed ────────────────────────────────────────────────────────────────
interface DMRFrame {
  sync: boolean; frame_type: string; src_id: number; dst_id: number
  tg_name?: string; alias: string
}
interface ActiveCall { id: number; tg: number; tgName: string; callsign: string; startMs: number }
interface HistRow { t: string; tg: number; tgName: string; call: string; dur: string }

function useDmrFeed() {
  const [active, setActive] = useState<ActiveCall | null>(null)
  const [history, setHistory] = useState<HistRow[]>([])
  const activeRef = useRef<ActiveCall | null>(null)
  useEffect(() => { activeRef.current = active }, [active])

  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined

    function finalize(c: ActiveCall) {
      setHistory(h => [{
        t: fmtHM(c.startMs), tg: c.tg, tgName: c.tgName,
        call: c.callsign || String(c.id),
        dur: fmtDur(Date.now() - c.startMs),
      }, ...h].slice(0, 8))
    }

    function connect() {
      const ws = new WebSocket(wsUrl('/ws/dmr'))
      ws.onmessage = e => {
        let f: DMRFrame
        try { f = JSON.parse(e.data) } catch { return }
        if (f.frame_type !== 'VOICE') return

        if (idle) clearTimeout(idle)
        idle = setTimeout(() => {
          const cur = activeRef.current
          if (cur) { finalize(cur); setActive(null) }
        }, 2000)

        if (f.src_id === 0) return   // VLC header — call boundary, wait for VC*
        setActive(prev => {
          if (prev && prev.id === f.src_id) {
            return {
              ...prev,
              tg: f.dst_id || prev.tg,
              tgName: f.tg_name || prev.tgName,
              callsign: f.alias || prev.callsign,
            }
          }
          if (prev) finalize(prev)
          const call: ActiveCall = {
            id: f.src_id, tg: f.dst_id, tgName: f.tg_name || '',
            callsign: f.alias || '', startMs: Date.now(),
          }
          if (!f.alias) {
            fetch(`/api/lookup/${f.src_id}`).then(r => r.json()).then(d => {
              const cs = [d.callsign, d.name].filter(Boolean).join(' ')
              if (cs) setActive(a => a && a.id === call.id ? { ...a, callsign: cs } : a)
            }).catch(() => {})
          }
          return call
        })
      }
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); if (idle) clearTimeout(idle) }
  }, [])

  return { active, history }
}

// ── Meshtastic feed ─────────────────────────────────────────────────────────
interface MeshMsg { id: string; timestamp: number; from_short: string; from_long: string; text: string }

function useMeshFeed() {
  const [nodeCount, setNodeCount] = useState<number | null>(null)
  const [messages, setMessages] = useState<MeshMsg[]>([])

  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    function connect() {
      const ws = new WebSocket(wsUrl('/ws/meshtastic'))
      ws.onmessage = e => {
        if (typeof e.data !== 'string') return
        try {
          const m = JSON.parse(e.data)
          if (m.type === 'status' && typeof m.node_count === 'number') setNodeCount(m.node_count)
          else if (m.type === 'node_list') setNodeCount((m.nodes ?? []).length)
          else if (m.type === 'message' && m.message?.text) {
            setMessages(prev => prev.some(x => x.id === m.message.id) ? prev
              : [m.message, ...prev].slice(0, 6))
          }
        } catch { /* ignore */ }
      }
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 4000) }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry) }
  }, [])

  return { nodeCount, messages }
}

// ── HamClock feed (solar/band data via backend proxy to local OpenHamClock) ──
interface BandCond { name: string; time: string; condition: string }
interface HamClockData {
  sfi: string | null; a: string | null; k: string | null
  bands: BandCond[]; callsign: string; grid: string
}

function useHamClock() {
  const [data, setData] = useState<HamClockData | null>(null)
  useEffect(() => {
    let alive = true
    const load = () => fetch('/api/hamclock').then(r => r.ok ? r.json() : null).then(j => {
      if (!alive || !j) return
      setData({
        sfi: j.solarData?.solarFlux ?? null,
        a:   j.solarData?.aIndex ?? null,
        k:   j.solarData?.kIndex ?? null,
        bands: j.bandConditions || [],
        callsign: j.station?.callsign || '',
        grid: j.station?.grid || '',
      })
    }).catch(() => {})
    load()
    const t = setInterval(load, 300_000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return data
}

// ── independent devices + per-mode live stats for the mode cards ─────────────
interface SideStatus {
  ble?: { running: boolean; devices: number; trackers: number }
  sat?: { mqtt_connected: boolean; packet_count: number }
  adsb?: { aircraft_count: number }
  surv?: { running: boolean; ring: number; flock: number; counts: { high: number }; wifi_error: string }
}

function useSideStatus(actualMode: SdrMode | null) {
  const [s, setS] = useState<SideStatus>({})
  useEffect(() => {
    let alive = true
    const get = (url: string) => fetch(url).then(r => r.ok ? r.json() : undefined).catch(() => undefined)
    const load = async () => {
      const [ble, sat, adsb, surv] = await Promise.all([
        get('/api/ble/status'), get('/api/satellite/status'),
        actualMode === 'adsb' ? get('/api/adsb/status') : Promise.resolve(undefined),
        get('/api/surveil/status'),
      ])
      if (alive) setS({ ble, sat, adsb, surv })
    }
    load()
    const t = setInterval(load, 10_000)
    return () => { alive = false; clearInterval(t) }
  }, [actualMode])
  return s
}

const COND_TONE: Record<string, Tone> = { Good: 'green', Fair: 'amber', Poor: 'red' }

// ── mode cards ──────────────────────────────────────────────────────────────
interface CardDef {
  name: string; path: string; desc: string; icon: ComponentType<{ size?: number }>
  sdr?: SdrMode; shared?: boolean; independent?: 'mesh' | 'sat' | 'ble' | 'surv'
}
const CARDS: CardDef[] = [
  { name: 'DMR',        path: '/dmr',        desc: '438.800 MHz digital voice',     icon: Mic,               sdr: 'dmr' },
  { name: 'WebSDR',     path: '/websdr',     desc: 'Zoomable receiver · SSB/CW/FM', icon: AudioWaveform,     sdr: 'websdr' },
  { name: 'ADS-B',      path: '/adsb',       desc: '1090 MHz aircraft',             icon: Plane,             sdr: 'adsb' },
  { name: 'Scanner',    path: '/scanner',    desc: 'AM/FM VHF/UHF favourites',      icon: Radar,             sdr: 'scanner' },
  { name: 'Pager',      path: '/pager',      desc: 'POCSAG · FLEX',                 icon: MessageSquareText, sdr: 'pager' },
  { name: 'Sub-GHz',    path: '/subghz',     desc: '433.92 / 315 MHz ISM · TPMS',   icon: Antenna,           sdr: 'subghz' },
  { name: 'Trunk',      path: '/trunk',      desc: 'Connect Plus via SDRTrunk',     icon: Network,           sdr: 'trunk' },
  { name: 'APRS',       path: '/aprs',       desc: '144.390 MHz packet',            icon: MapPin,            sdr: 'aprs' },
  { name: 'AX.25',      path: '/ax25',       desc: 'KISS terminal (with APRS)',     icon: SquareTerminal,    sdr: 'aprs', shared: true },
  { name: 'SSTV',       path: '/sstv',       desc: '145.800 MHz images',            icon: Image,             sdr: 'sstv' },
  { name: 'METEOR',     path: '/meteor',     desc: '137.9 MHz LRPT weather',        icon: CloudSun,          sdr: 'meteor' },
  { name: 'Meshtastic', path: '/meshtastic', desc: 'LoRa mesh · USB',               icon: Waypoints,         independent: 'mesh' },
  { name: 'BLE',        path: '/ble',        desc: 'Built-in Bluetooth scan',       icon: Bluetooth,         independent: 'ble' },
  { name: 'Surveillance', path: '/surveillance', desc: 'Ring · Flock Safety detection', icon: Cctv,          independent: 'surv' },
  { name: 'Satellite',  path: '/satellite',  desc: 'TinyGS via local MQTT',         icon: Satellite,         independent: 'sat' },
]

export default function Home() {
  const navigate = useNavigate()
  const { actualMode, caps } = useMode()
  const dmr = useDmrFeed()
  const mesh = useMeshFeed()
  const hc = useHamClock()
  const side = useSideStatus(actualMode)

  const [info, setInfo] = useState<SysInfo | null>(null)
  const [freq, setFreq] = useState(438_800_000)
  const [gain, setGain] = useState(49.6)
  const [freqEdit, setFreqEdit] = useState<string | null>(null)
  const [clients, setClients] = useState<Record<string, number>>({})
  const [sig, setSig] = useState(-100)
  const [snr, setSnr] = useState(0)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    fetch('/api/sysinfo').then(r => r.json()).then(setInfo).catch(() => {})
    const poll = () => fetch('/api/status').then(r => r.json())
      .then(d => {
        if (typeof d.freq === 'number') setFreq(d.freq)
        if (typeof d.gain === 'number') setGain(d.gain)
        if (d.clients) setClients(d.clients)
      })
      .catch(() => {})
    poll()
    const s = setInterval(poll, 3000)
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(s); clearInterval(t) }
  }, [])

  function tune(f: number, g?: number) {
    setFreq(f)
    if (g != null) setGain(g)
    const q = g != null ? `freq=${Math.round(f)}&gain=${g}` : `freq=${Math.round(f)}`
    fetch(`/api/tune?${q}`, { method: 'POST' }).catch(() => {})
  }

  function commitFreqEdit() {
    if (freqEdit === null) return
    const v = parseFloat(freqEdit.replace(/[^\d.]/g, ''))
    setFreqEdit(null)
    if (!isFinite(v) || v <= 0) return
    tune(v < 10_000 ? v * 1e6 : v)   // "438.8" means MHz, big numbers are Hz
  }

  function cardStatus(c: CardDef): { tone: Tone; label: string; stat: string } {
    const cap = c.sdr ? caps[c.sdr] : undefined
    if (cap?.ok === false) return { tone: 'gray', label: 'Not installed', stat: cap.hint }
    if (c.independent === 'mesh')
      return mesh.nodeCount != null ? { tone: 'green', label: 'Online', stat: `${mesh.nodeCount} nodes` }
                                    : { tone: 'amber', label: 'Connecting', stat: 'Waiting for the radio' }
    if (c.independent === 'ble') {
      const b = side.ble
      if (!b) return { tone: 'gray', label: 'Unknown', stat: '—' }
      return b.running ? { tone: 'green', label: 'Scanning', stat: `${b.devices} devices · ${b.trackers} trackers` }
                       : { tone: 'red', label: 'Stopped', stat: 'Bluetooth blocked or off' }
    }
    if (c.independent === 'surv') {
      const v = side.surv
      if (!v) return { tone: 'gray', label: 'Unknown', stat: '—' }
      if (!v.running) return { tone: 'gray', label: 'Off', stat: 'Disabled in config' }
      const n = v.ring + v.flock
      if (v.counts.high > 0) return { tone: 'red', label: `${v.counts.high} detected`, stat: `${v.flock} Flock · ${v.ring} Ring` }
      return { tone: 'green', label: 'Watching', stat: n ? `${n} possible` : v.wifi_error ? 'BLE only — WiFi scan failing' : 'BLE + WiFi APs' }
    }
    if (c.independent === 'sat') {
      const s = side.sat
      if (!s) return { tone: 'gray', label: 'Unknown', stat: '—' }
      return s.mqtt_connected ? { tone: 'green', label: 'MQTT up', stat: `${s.packet_count} packets` }
                              : { tone: 'red', label: 'MQTT down', stat: 'Local broker unreachable' }
    }
    if (c.sdr && actualMode === c.sdr) {
      let stat = 'Receiving on SDR 0'
      if (c.sdr === 'dmr' && dmr.active) stat = `TG ${dmr.active.tg} · ${dmr.active.callsign || dmr.active.id}`
      if (c.sdr === 'adsb' && side.adsb) stat = `${side.adsb.aircraft_count} aircraft`
      if (c.shared) stat = 'Shares the APRS decoder'
      return { tone: 'green', label: 'Active', stat }
    }
    return { tone: 'gray', label: 'Idle', stat: 'Needs SDR 0' }
  }

  const bands = hc ? Array.from(new Set(hc.bands.map(b => b.name))) : []

  return (
    <div className="dash">
      {/* ── primary workspace ─────────────────────────────────────────────── */}
      <div className="dash-main">
        <Panel className="tuner">
          <div className="tuner-top">
            <div className="tuner-freq">
              <span className="metric-label">Frequency · SDR 0</span>
              {freqEdit !== null ? (
                <input autoFocus className="tuner-input mono" value={freqEdit}
                  onChange={e => setFreqEdit(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') commitFreqEdit(); if (e.key === 'Escape') setFreqEdit(null) }}
                  onBlur={() => setFreqEdit(null)}
                  placeholder="MHz (438.8) or Hz" aria-label="Frequency" />
              ) : (
                <button className="tuner-readout mono" onClick={() => setFreqEdit((freq / 1e6).toString())}
                  title="Click to type a frequency — MHz or Hz, Enter to tune">
                  {fmtMHz(freq)}<span className="tuner-unit">MHz</span>
                </button>
              )}
            </div>
            <div className="tuner-gain">
              <label className="metric-label" htmlFor="rf-gain">RF gain</label>
              <div className="tuner-gain-row">
                <input id="rf-gain" type="range" min={0} max={50} step={0.1} value={gain}
                  onChange={e => setGain(Number(e.target.value))}
                  onPointerUp={e => tune(freq, Number((e.target as HTMLInputElement).value))}
                  onKeyUp={e => tune(freq, Number((e.target as HTMLInputElement).value))}
                  title="Release to apply" />
                <span className="mono tuner-gain-val">{gain.toFixed(1)} dB</span>
              </div>
            </div>
            <SignalMeters sig={sig} snr={snr} />
          </div>
          <MemoryChannels currentFreq={freq} currentGain={gain} onRecall={(f, g) => tune(f, g)} />
        </Panel>

        <Panel className="spectrum" title="Spectrum" sub="2.4 MHz span · click to tune" flush>
          <div className="spectrum-bezel">
            <Waterfall
              centerFreqHz={freq}
              palette="green"
              onClickTune={tune}
              onStats={(s, n) => { setSig(s); setSnr(n) }}
            />
          </div>
        </Panel>

        <Panel title="Modes" sub="Open a mode for its full controls" className="modes-panel">
          <div className="mode-cards">
            {CARDS.map(c => {
              const st = cardStatus(c)
              const Icon = c.icon
              return (
                <button key={c.path} className={`mode-card2${st.tone === 'green' ? ' live' : ''}`} onClick={() => navigate(c.path)}>
                  <div className="mc-top">
                    <span className="mc-icon"><Icon size={16} /></span>
                    <span className="mc-name">{c.name}</span>
                    <ChevronRight size={14} className="mc-go" />
                  </div>
                  <div className="mc-desc">{c.desc}</div>
                  <div className="mc-foot">
                    <StatusBadge tone={st.tone}>{st.label}</StatusBadge>
                    <span className="mc-stat" title={st.stat}>{st.stat}</span>
                  </div>
                </button>
              )
            })}
          </div>
        </Panel>
      </div>

      {/* ── status workspace ──────────────────────────────────────────────── */}
      <aside className="dash-side">
        <SdrControl />

        <Panel title="DMR" icon={<Mic />} bordered className={`dmr-panel${dmr.active ? ' call-live' : ''}`}
          actions={dmr.active ? <StatusBadge tone="green" pulse>Receiving</StatusBadge>
            : actualMode === 'dmr' ? <StatusBadge tone="gray">Idle</StatusBadge>
            : <StatusBadge tone="gray">Not on SDR 0</StatusBadge>}>
          {dmr.active ? (
            <div className="call">
              <div className="call-main">
                <div>
                  <div className="metric-label">Active call</div>
                  <div className="call-tg mono">TG {dmr.active.tg}</div>
                  {dmr.active.tgName && <div className="call-tgname">{dmr.active.tgName}</div>}
                </div>
                <div className="call-dur mono">{fmtDur(now - dmr.active.startMs)}</div>
              </div>
              <div className="call-caller">
                <span className="call-callsign mono">{dmr.active.callsign || dmr.active.id}</span>
                <span className="muted mono">Radio ID {dmr.active.id}</span>
              </div>
            </div>
          ) : (
            <EmptyState icon={<Radio />} title={actualMode === 'dmr' ? 'Channel idle' : 'SDR 0 is not in DMR mode'}>
              {actualMode === 'dmr' ? 'Calls appear here the moment a voice frame decodes.' : 'Switch device 0 to DMR to monitor calls.'}
            </EmptyState>
          )}
          {dmr.history.length > 0 && (
            <table className="data-table call-hist">
              <thead><tr><th>Time</th><th>Talkgroup</th><th>Caller</th><th className="r">Dur</th></tr></thead>
              <tbody>
                {dmr.history.map((d, i) => (
                  <tr key={i}>
                    <td className="mono">{d.t}</td>
                    <td className="primary">TG {d.tg}{d.tgName && <span className="muted"> · {d.tgName}</span>}</td>
                    <td className="mono">{d.call}</td>
                    <td className="mono r">{d.dur}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <div className="dash-audio">
            <AudioPlayer wsPath="/ws/dmr-audio" inputRate={8000} label="DMR audio" />
          </div>
        </Panel>

        <Panel title="Meshtastic" icon={<Waypoints />} bordered onClick={() => navigate('/meshtastic')}
          actions={mesh.nodeCount != null ? <StatusBadge tone="green">{mesh.nodeCount} nodes</StatusBadge>
                                          : <StatusBadge tone="amber">Connecting</StatusBadge>}>
          {mesh.messages.length === 0 ? (
            <EmptyState>No messages since this page opened.</EmptyState>
          ) : (
            <ul className="feed">
              {mesh.messages.map(m => (
                <li key={m.id}>
                  <span className="feed-time mono">{fmtHM(m.timestamp * 1000)}</span>
                  <span className="feed-from">{m.from_short || m.from_long}</span>
                  <span className="feed-text">{m.text}</span>
                </li>
              ))}
            </ul>
          )}
        </Panel>

        <Panel title="Propagation" icon={<Sun />} bordered onClick={() => navigate('/hamclock')}
          actions={hc ? <span className="muted mono">{hc.callsign} · {hc.grid}</span> : <StatusBadge tone="gray">Offline</StatusBadge>}>
          {hc ? (
            <>
              <div className="metric-grid hc-metrics">
                <Metric label="Solar flux" value={hc.sfi ?? '—'} mono />
                <Metric label="A index" value={hc.a ?? '—'} mono />
                <Metric label="K index" value={hc.k ?? '—'} mono />
              </div>
              <table className="data-table">
                <thead><tr><th>Band</th><th><Sun size={12} /> Day</th><th><Moon size={12} /> Night</th></tr></thead>
                <tbody>
                  {bands.map(name => {
                    const day   = hc.bands.find(b => b.name === name && b.time === 'day')
                    const night = hc.bands.find(b => b.name === name && b.time === 'night')
                    return (
                      <tr key={name}>
                        <td className="primary">{name}</td>
                        {[day, night].map((b, i) => (
                          <td key={i}><span className="cond"><StatusDot tone={COND_TONE[b?.condition ?? ''] ?? 'gray'} />{b?.condition ?? '—'}</span></td>
                        ))}
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </>
          ) : (
            <EmptyState>OpenHamClock service is not answering.</EmptyState>
          )}
        </Panel>

        <Panel title="System" icon={<Server />} bordered>
          <dl className="kv">
            <dt>Host</dt><dd className="mono">{info?.hostname ?? '—'}</dd>
            {info?.local_ip && <><dt>LAN</dt><dd className="mono">{info.local_ip}:8000</dd></>}
            {info?.tailscale_ip && <><dt>Tailscale</dt><dd className="mono">{info.tailscale_ip}</dd></>}
            <dt>Viewers</dt><dd className="mono" title="connected browsers: waterfall / DMR metadata">waterfall {clients.waterfall || 0} · DMR {clients.dmr || 0}</dd>
            <dt>Version</dt>
            <dd className="mono">{info?.version ?? '—'} · <a href="https://github.com/sinetec6969/hampi-dashboard" target="_blank" rel="noreferrer">GitHub</a></dd>
          </dl>
        </Panel>
      </aside>
    </div>
  )
}
