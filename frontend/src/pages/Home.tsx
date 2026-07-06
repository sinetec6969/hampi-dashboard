import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { wsUrl } from '../ws'
import { useMode, SDR_MODES, type SdrMode } from '../mode'
import Waterfall from '../components/Waterfall'
import SignalMeters from '../components/SignalMeters'

interface SysInfo {
  hostname: string
  local_ip: string | null
  tailscale_ip: string | null
  version: string
}

const MEM_KEY = 'hampi-memory-channels'
const SCAN_KEY = 'hampi-scanlines'

interface MemChannel { id: string; name: string; freq: number; gain: number }

function loadMem(): MemChannel[] {
  try { return JSON.parse(localStorage.getItem(MEM_KEY) || '[]') } catch { return [] }
}

function pad(n: number) { return n.toString().padStart(2, '0') }
function fmtClock(d: Date) { return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` }
function fmtHM(ms: number) { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}` }
function fmtDur(ms: number) { const s = Math.max(0, Math.round(ms / 1000)); return `${Math.floor(s / 60)}:${pad(s % 60)}` }
function fmtFreq(hz: number) { return Math.round(hz).toLocaleString('de-DE') }

// ── DMR feed ────────────────────────────────────────────────────────────────
interface DMRFrame {
  sync: boolean; frame_type: string; src_id: number; dst_id: number
  tg_name?: string; alias: string
}
interface ActiveCall { id: number; tg: number; tgName: string; callsign: string; startMs: number }
interface HistRow { t: string; tg: string; call: string; dur: string }

function useDmrFeed() {
  const [active, setActive] = useState<ActiveCall | null>(null)
  const [history, setHistory] = useState<HistRow[]>([])
  const activeRef = useRef<ActiveCall | null>(null)
  activeRef.current = active

  useEffect(() => {
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    let idle: ReturnType<typeof setTimeout> | undefined

    function finalize(c: ActiveCall) {
      setHistory(h => [{
        t: fmtHM(c.startMs),
        tg: `TG ${c.tg}${c.tgName ? ' ' + c.tgName : ''}`,
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

// ── Meshtastic feed ───────────────────────────────────────────────────────────
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

// ── mode cards ────────────────────────────────────────────────────────────────
interface CardDef { name: string; path: string; sub: string; sdr?: SdrMode; shared?: boolean; independent?: boolean }
const CARDS: CardDef[] = [
  { name: 'DMR VOICE', path: '/dmr',        sub: '438.800 MHz NFM · dsd-fme',    sdr: 'dmr' },
  { name: 'TRUNK',     path: '/trunk',      sub: 'Connect Plus · SDRTrunk',      sdr: 'trunk' },
  { name: 'ADS-B',     path: '/adsb',       sub: '1090 MHz · rtl_adsb',          sdr: 'adsb' },
  { name: 'AIRBAND',   path: '/airband',    sub: '118–137 MHz AM',               sdr: 'airband' },
  { name: 'APRS',      path: '/aprs',       sub: '144.390 MHz · direwolf',       sdr: 'aprs' },
  { name: 'AX.25',     path: '/ax25',       sub: 'direwolf KISS :8001',          sdr: 'aprs', shared: true },
  { name: 'SSTV',      path: '/sstv',       sub: '145.800 MHz FM',               sdr: 'sstv' },
  { name: 'METEOR',    path: '/meteor',     sub: '137.9 MHz QPSK · SatDump',     sdr: 'meteor' },
  { name: 'MESHTASTIC', path: '/meshtastic', sub: 'LoRa mesh · USB serial',      independent: true },
  { name: 'SATELLITE', path: '/satellite',  sub: 'TinyGS · Mosquitto',           independent: true },
]

const GREEN = '#00ff88', AMBER = '#ffb000'

// ── panel header (┌─ TITLE ─── meta) ──────────────────────────────────────────
function PanelHead({ title, meta }: { title: string; meta?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 10, letterSpacing: 2, color: '#4d7a62' }}>┌─ {title}</span>
      <span style={{ flex: 1, borderTop: '1px solid #123322' }} />
      {meta}
    </div>
  )
}

export default function Home() {
  const navigate = useNavigate()
  const { actualMode, intendedMode, setIntendedMode, switching, switchErr, switchMode } = useMode()
  const dmr = useDmrFeed()
  const mesh = useMeshFeed()

  const [info, setInfo] = useState<SysInfo | null>(null)
  const [freq, setFreq] = useState(438_800_000)
  const [gain, setGain] = useState(49.6)
  const [sig, setSig] = useState(-100)
  const [snr, setSnr] = useState(0)
  const [now, setNow] = useState(() => Date.now())
  const [mem, setMem] = useState<MemChannel[]>(loadMem)
  const [scanlines, setScanlines] = useState(() => localStorage.getItem(SCAN_KEY) !== 'off')

  useEffect(() => {
    fetch('/api/sysinfo').then(r => r.json()).then(setInfo).catch(() => {})
    const poll = () => fetch('/api/status').then(r => r.json())
      .then(d => { if (typeof d.freq === 'number') setFreq(d.freq); if (typeof d.gain === 'number') setGain(d.gain) })
      .catch(() => {})
    poll()
    const s = setInterval(poll, 3000)
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => { clearInterval(s); clearInterval(t) }
  }, [])

  function tune(f: number, g?: number) {
    setFreq(f)
    const q = g != null ? `freq=${Math.round(f)}&gain=${g}` : `freq=${Math.round(f)}`
    fetch(`/api/tune?${q}`, { method: 'POST' }).catch(() => {})
  }

  function saveMem() {
    const name = prompt('Channel name:')
    if (!name?.trim()) return
    const next = [...mem, { id: crypto.randomUUID(), name: name.trim().toUpperCase(), freq, gain }]
    setMem(next); localStorage.setItem(MEM_KEY, JSON.stringify(next))
  }

  function toggleScanlines() {
    setScanlines(v => { localStorage.setItem(SCAN_KEY, v ? 'off' : 'on'); return !v })
  }

  const match = actualMode !== null && actualMode === intendedMode
  const actualLabel = actualMode ? SDR_MODES.find(m => m.mode === actualMode)?.label ?? actualMode : '—'
  const intendedLabel = SDR_MODES.find(m => m.mode === intendedMode)?.label ?? intendedMode

  return (
    <div className="rx-home" style={{ position: 'relative', background: '#030604' }}>
      {scanlines && <div className="rx-scanlines" onDoubleClick={toggleScanlines} />}
      <div className="rx-grid" style={{ display: 'grid', gridTemplateColumns: '460px 1fr', height: '100%' }}>

        {/* ── LEFT: spectrum ─────────────────────────────────────────── */}
        <div className="rx-left" style={{ borderRight: '1px solid #123322', display: 'flex', flexDirection: 'column', background: '#000', minHeight: 0 }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #123322', background: '#050a07' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, letterSpacing: 2, color: '#4d7a62' }}>SPECTRUM · DEV0</span>
              <span style={{ flex: 1 }} />
              <span style={{ fontSize: 10, color: '#3d6b52' }}>2.4 MHZ FFT · GAIN {gain.toFixed(1)}</span>
            </div>
            <div style={{ fontFamily: "'VT323', monospace", fontSize: 38, color: '#00ff88', textShadow: '0 0 12px rgba(0,255,136,.6)' }}>
              {fmtFreq(freq)}<span style={{ fontSize: 19, color: '#4d7a62' }}> HZ</span>
            </div>
          </div>

          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', background: '#050a07', borderBottom: '1px solid #0d2418', overflowX: 'auto' }}>
            <span style={{ fontSize: 9, letterSpacing: 2, color: '#3d6b52', flexShrink: 0 }}>MEM</span>
            {mem.map(ch => (
              <span key={ch.id} className="rx-mem-chip" onClick={() => tune(ch.freq, ch.gain)}
                style={{ fontSize: 10, border: '1px solid #1d4030', padding: '2px 7px', color: '#7dffb8', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>
                {ch.name} {(ch.freq / 1e6).toFixed(4)}
              </span>
            ))}
            <span className="rx-save-chip" onClick={saveMem}
              style={{ fontSize: 10, border: '1px dotted #1d4030', padding: '2px 7px', color: '#3d6b52', cursor: 'pointer', whiteSpace: 'nowrap', flexShrink: 0 }}>+ SAVE</span>
          </div>

          <SignalMeters sig={sig} snr={snr} />

          <div className="rx-wf" style={{ position: 'relative', flex: 1, minHeight: 0 }}>
            <Waterfall
              centerFreqHz={freq}
              palette="green"
              onClickTune={tune}
              onStats={(s, n) => { setSig(s); setSnr(n) }}
            />
            <div style={{ position: 'absolute', bottom: 22, left: 12, fontSize: 9, letterSpacing: 1, color: '#3d6b52', pointerEvents: 'none' }}>CLICK-TO-TUNE</div>
          </div>
        </div>

        {/* ── RIGHT ──────────────────────────────────────────────────── */}
        <div style={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>

          {/* header bar */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '10px 16px', borderBottom: '1px solid #123322', background: '#050a07' }}>
            <span onClick={() => navigate('/')} style={{ fontSize: 15, fontWeight: 700, letterSpacing: 2, color: '#00ff88', textShadow: '0 0 10px rgba(0,255,136,.5)', cursor: 'pointer' }}>▚ HAMPI://RX</span>
            <span style={{ fontSize: 10, color: '#3d6b52' }}>v{info?.version ?? '0.9-b3t5'}</span>
            <span style={{ fontFamily: "'VT323', monospace", fontSize: 24, color: '#7dffb8', marginLeft: 'auto', textShadow: '0 0 8px rgba(0,255,136,.4)' }}>
              {fmtClock(new Date(now))}<span className="rx-blink">▌</span>
            </span>
            {match ? (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #1d4030', padding: '5px 10px', background: '#07120c' }}>
                <span style={{ fontSize: 10, letterSpacing: 2, color: '#00ff88' }}>MODE LOCK · {actualLabel}</span>
                <span style={{ width: 14, height: 14, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 16px #00ff88' }} />
              </div>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, border: '1px solid #5a1622', padding: '5px 10px', background: '#160709' }}>
                <span style={{ fontSize: 10, letterSpacing: 2, color: '#ff3355' }}>MISMATCH · DEV0={actualLabel} INTENT={intendedLabel}</span>
                <span className="rx-blink-fast" style={{ width: 14, height: 14, borderRadius: '50%', background: '#ff3355', boxShadow: '0 0 16px #ff3355' }} />
              </div>
            )}
          </div>

          {/* DEV0 / INTENT switcher */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, padding: '8px 16px', borderBottom: '1px solid #0d2418', background: '#040805' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, letterSpacing: 2, color: '#3d6b52', width: 52 }}>DEV0</span>
              {SDR_MODES.map(({ mode, label }) => {
                const on = actualMode === mode
                const pending = switching === mode
                return (
                  <button key={mode} onClick={() => switchMode(mode)} disabled={switching !== null}
                    style={{
                      fontFamily: 'inherit', fontSize: 11, letterSpacing: 1, padding: '4px 14px',
                      cursor: switching ? 'default' : 'pointer',
                      border: `1px solid ${on ? '#00ff88' : '#1d4030'}`,
                      background: on ? '#00ff88' : 'transparent',
                      color: on ? '#04170c' : '#58a67a',
                      opacity: pending ? 0.6 : 1,
                    }}>{pending ? `${label}…` : label}</button>
                )
              })}
              <span style={{ fontSize: 9, color: '#2c4d3a', marginLeft: 'auto' }}>one owner at a time · failed switch rolls back to DMR</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 10, letterSpacing: 2, color: '#3d6b52', width: 52 }}>INTENT</span>
              {SDR_MODES.map(({ mode, label }) => {
                const on = intendedMode === mode
                return (
                  <button key={mode} onClick={() => setIntendedMode(mode)}
                    style={{
                      fontFamily: 'inherit', fontSize: 11, letterSpacing: 1, padding: '4px 14px', cursor: 'pointer',
                      border: `1px dashed ${on ? '#00ff88' : '#16301f'}`,
                      background: on ? '#123726' : 'transparent',
                      color: on ? '#7dffb8' : '#3d6b52',
                    }}>{label}</button>
                )
              })}
            </div>
            {switching && (
              <div style={{ fontSize: 9, letterSpacing: 1, color: '#ffb000' }}>
                stopping {actualLabel} · starting {SDR_MODES.find(m => m.mode === switching)?.label} — a failed start rolls back to DMR
              </div>
            )}
            {switchErr && <div style={{ fontSize: 9, color: '#ff3355' }}>{switchErr}</div>}
          </div>

          {/* feeds row */}
          <div className="rx-feeds" style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, background: '#0d2418', borderBottom: '1px solid #0d2418' }}>
            {/* DMR VOICE */}
            <div style={{ background: '#040805', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              <PanelHead title="DMR VOICE" meta={
                <span className="rx-pulse" style={{ width: 7, height: 7, borderRadius: '50%', background: '#00ff88', boxShadow: '0 0 6px #00ff88' }} />
              } />
              {dmr.active && (
                <div style={{ border: '1px solid #1d4030', background: '#07160e', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span className="rx-blink" style={{ color: '#00ff88', fontWeight: 700 }}>▶RX</span>
                  <span style={{ fontSize: 12, color: '#c8ffe0', fontWeight: 600 }}>TG {dmr.active.tg}{dmr.active.tgName ? ` ${dmr.active.tgName}` : ''}</span>
                  <span style={{ fontSize: 11, color: '#7fbf9a' }}>{dmr.active.callsign || dmr.active.id}</span>
                  <span style={{ fontFamily: "'VT323', monospace", fontSize: 19, color: '#00ff88', marginLeft: 'auto' }}>{fmtDur(now - dmr.active.startMs)}</span>
                </div>
              )}
              {dmr.history.length === 0 && !dmr.active && (
                <div style={{ fontSize: 10, color: '#3d6b52', padding: '4px 2px' }}>no calls yet — dev0 must be in DMR</div>
              )}
              {dmr.history.map((d, i) => (
                <div key={i} style={{ display: 'flex', gap: 10, fontSize: 11, padding: '3px 2px', borderBottom: '1px dotted #0d2418' }}>
                  <span style={{ color: '#3d6b52' }}>{d.t}</span>
                  <span style={{ color: '#a8e8c4', width: 130 }}>{d.tg}</span>
                  <span style={{ color: '#6aa886', flex: 1 }}>{d.call}</span>
                  <span style={{ color: '#4d7a62' }}>{d.dur}</span>
                </div>
              ))}
            </div>
            {/* MESHTASTIC */}
            <div style={{ background: '#040805', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 7 }}>
              <PanelHead title="MESHTASTIC" meta={
                <span style={{ fontSize: 10, color: '#7fbf9a' }}>{mesh.nodeCount != null ? `${mesh.nodeCount} NODES` : 'CONNECTING'}</span>
              } />
              {mesh.messages.length === 0 && (
                <div style={{ fontSize: 10, color: '#3d6b52', padding: '4px 2px' }}>no messages yet</div>
              )}
              {mesh.messages.map(m => (
                <div key={m.id} style={{ fontSize: 11, padding: '4px 2px', borderBottom: '1px dotted #0d2418' }}>
                  <div style={{ display: 'flex', gap: 10 }}>
                    <span style={{ color: '#3d6b52' }}>{fmtHM(m.timestamp * 1000)}</span>
                    <span style={{ color: '#a8e8c4' }}>{m.from_short || m.from_long}</span>
                  </div>
                  <div style={{ color: '#6aa886', padding: '2px 0 0 60px' }}>{m.text}</div>
                </div>
              ))}
            </div>
          </div>

          {/* ALL MODES grid */}
          <div style={{ padding: '12px 16px', flex: 1, minHeight: 0, overflowY: 'auto' }}>
            <div style={{ marginBottom: 10 }}><PanelHead title="ALL MODES" /></div>
            <div className="rx-cards" style={{ display: 'grid', gridTemplateColumns: 'repeat(5, 1fr)', gap: 8 }}>
              {CARDS.map(c => {
                let led = AMBER, badge = 'IDLE', stat = '— dev0 not in mode'
                if (c.independent) {
                  led = GREEN
                  badge = 'LIVE'
                  stat = c.name === 'MESHTASTIC'
                    ? (mesh.nodeCount != null ? `${mesh.nodeCount} nodes · live` : 'connecting…')
                    : 'TinyGS · MQTT online'
                } else if (c.sdr && actualMode === c.sdr) {
                  led = GREEN
                  badge = c.shared ? 'LIVE' : '▶ DEV0'
                  stat = c.name === 'DMR VOICE' && dmr.active
                    ? `▶ TG ${dmr.active.tg} ${dmr.active.callsign || dmr.active.id}`
                    : 'receiving on dev0'
                }
                return (
                  <div key={c.path} className="rx-card" onClick={() => navigate(c.path)}
                    style={{ border: '1px solid #123322', background: '#050c08', padding: '9px 11px', display: 'flex', flexDirection: 'column', gap: 4, cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 7 }}>
                      <span style={{ width: 7, height: 7, borderRadius: '50%', flexShrink: 0, background: led, boxShadow: `0 0 6px ${led}` }} />
                      <span style={{ fontSize: 11.5, fontWeight: 600, letterSpacing: 1, color: '#c8ffe0' }}>{c.name}</span>
                    </div>
                    <div style={{ fontSize: 9, color: '#3d6b52' }}>{c.sub}</div>
                    <div style={{ fontSize: 10, color: '#7fbf9a', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{stat}</div>
                    <div style={{ fontSize: 9, letterSpacing: 1, color: led }}>{badge}</div>
                  </div>
                )
              })}
            </div>
          </div>

          {/* sysinfo footer */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 18, padding: '7px 16px', borderTop: '1px solid #123322', background: '#050a07', fontSize: 10, color: '#4d7a62' }}>
            <span>host <span style={{ color: '#7fbf9a' }}>{info?.hostname ?? 'hampi.local'}</span></span>
            {info?.local_ip && <span>local <span style={{ color: '#7fbf9a' }}>{info.local_ip}:8000</span></span>}
            {info?.tailscale_ip && <span>tailscale <span style={{ color: '#7fbf9a' }}>{info.tailscale_ip}:8000</span></span>}
            <span style={{ marginLeft: 'auto' }}>
              ver <span style={{ color: '#7fbf9a' }}>{info?.version ?? '0.9-b3t5'}</span> · <a href="https://github.com/sinetec6969/hampi-dashboard" target="_blank" rel="noreferrer" style={{ color: '#7fbf9a' }}>github</a>
            </span>
          </div>
        </div>
      </div>
    </div>
  )
}
