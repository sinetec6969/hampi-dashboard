import { useEffect, useState } from 'react'
import { Cctv, BellRing, Bluetooth, Wifi, Info } from 'lucide-react'
import { wsUrl } from '../ws'
import { Panel, StatusBadge, Metric, EmptyState, type Tone } from '../components/ui'

interface Status {
  running: boolean; counts: { high: number; medium: number; low: number }
  ring: number; flock: number; wifi_error: string; last_wifi_scan: number; aps_seen: number; wifi_scan_s: number
}
interface Detection {
  key: string; source: 'ble' | 'wifi'; id: string; name: string | null
  kind: 'ring' | 'flock'; tier: 'high' | 'medium' | 'low'; label: string; evidence: string[]
  strength: number; strength_unit: string; first: number; last: number; count: number
  addr_type?: string; channel?: string
}

const TIER_TONE: Record<Detection['tier'], Tone> = { high: 'red', medium: 'amber', low: 'gray' }
const TIER_LABEL: Record<Detection['tier'], string> = { high: 'High', medium: 'Medium', low: 'Low' }

function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round(now / 1000 - ts))
  if (s < 60) return `${s}s ago`
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`
}
const hm = (ts: number) => new Date(ts * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })

export default function SurveillancePage() {
  const [st, setSt] = useState<Status | null>(null)
  const [dets, setDets] = useState<Detection[]>([])
  const [showLow, setShowLow] = useState(false)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    fetch('/api/surveil/status').then(r => r.json()).then(setSt).catch(() => {})
    fetch('/api/surveil/detections').then(r => r.json()).then(setDets).catch(() => {})
    const tick = setInterval(() => setNow(Date.now()), 1000)
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null
    function connect() {
      ws = new WebSocket(wsUrl('/ws/surveil'))
      ws.onmessage = e => {
        try {
          const m = JSON.parse(e.data)
          if (m.type === 'detections') { setDets(m.detections); setSt(m.status) }
        } catch { /* */ }
      }
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); ws?.close(); clearInterval(tick) }
  }, [])

  const shown = dets.filter(d => showLow || d.tier !== 'low')
  const hidden = dets.length - shown.length

  return (
    <div className="page">
      <div className="header">
        <span className="header-title">Surveillance devices</span>
        <span className="muted">Ring and Flock Safety, from public signatures</span>
        {st && (st.running ? <StatusBadge tone="green">Watching</StatusBadge> : <StatusBadge tone="gray">Off</StatusBadge>)}
      </div>

      <div className="surv-summary">
        <Panel>
          <div className="metric-grid surv-metrics">
            <Metric label="Flock devices" value={st?.flock ?? 0} />
            <Metric label="Ring devices" value={st?.ring ?? 0} />
            <Metric label="High confidence" value={st?.counts.high ?? 0} />
            <Metric label="Medium" value={st?.counts.medium ?? 0} />
            <Metric label="Low (hints)" value={st?.counts.low ?? 0} />
          </div>
        </Panel>
        <Panel title="Sensors" icon={<Info />}>
          <ul className="surv-sensors">
            <li><Bluetooth size={14} /> <b>BLE</b> — every advert from the built-in radio</li>
            <li><Wifi size={14} /> <b>WiFi APs</b> — {st?.wifi_error
              ? <span className="t-red">{st.wifi_error}</span>
              : st?.last_wifi_scan ? <>{st.aps_seen} APs in the last scan, {ago(st.last_wifi_scan, now)}</> : 'waiting for first scan'}</li>
          </ul>
        </Panel>
      </div>

      <Panel title="Detections" icon={<Cctv />} bordered flush className="surv-table-panel"
        actions={<label className="surv-toggle"><input type="checkbox" checked={showLow} onChange={e => setShowLow(e.target.checked)} /> Show low-confidence hints{hidden > 0 && !showLow ? ` (${hidden})` : ''}</label>}>
        {shown.length === 0 ? (
          <EmptyState icon={<Cctv />} title="Nothing detected yet">
            Detections appear when a Ring or Flock signature is heard. Flock cameras are mostly
            roadside — this will stay quiet at home.
          </EmptyState>
        ) : (
          <div className="surv-scroll">
            <table className="data-table">
              <thead>
                <tr><th>Confidence</th><th>Device</th><th>Source</th><th>Identifier</th><th>Evidence</th>
                  <th className="r">Signal</th><th className="r">Seen</th><th className="r">First</th><th className="r">Last</th></tr>
              </thead>
              <tbody>
                {shown.map(d => (
                  <tr key={d.key}>
                    <td><StatusBadge tone={TIER_TONE[d.tier]}>{TIER_LABEL[d.tier]}</StatusBadge></td>
                    <td className="primary">
                      <span className="surv-kind">{d.kind === 'ring' ? <BellRing size={14} /> : <Cctv size={14} />}{d.label}</span>
                    </td>
                    <td>{d.source === 'ble' ? 'BLE' : `WiFi ch ${d.channel ?? '?'}`}</td>
                    <td className="mono">{d.id}{d.name && <div className="muted">{d.name}</div>}</td>
                    <td className="surv-evidence">{d.evidence.join(' · ')}</td>
                    <td className="mono r">{d.strength} {d.strength_unit}</td>
                    <td className="mono r">{d.count}×</td>
                    <td className="mono r">{hm(d.first)}</td>
                    <td className="mono r" title={new Date(d.last * 1000).toLocaleString()}>{ago(d.last, now)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <p className="surv-note">
        Signatures: Ring LLC and Flock Safety OUIs verified against the IEEE registry; BLE names, the
        XUNTONG battery advert, accessory/Raven GATT services and the <span className="mono">Flock-XXXXXX</span> SoftAP
        from <a href="https://github.com/colonelpanichacks/flock-you" target="_blank" rel="noreferrer">Flock-You</a> (MIT).
        OUI matches on BLE count only for public addresses. The built-in WiFi can't sniff probe requests,
        so camera clients that never run an AP need a monitor-mode adapter to catch.
      </p>
    </div>
  )
}
