import { useEffect, useRef, useState } from 'react'
import { ClipboardList, Plus, Square, Download, X, Users } from 'lucide-react'
import { wsUrl } from '../ws'
import { Panel, StatusBadge, Metric, EmptyState, Button, type Tone } from '../components/ui'

interface Net {
  id: number; name: string; frequency: string; mode: string; band: string
  started_utc: string; ended_utc: string | null; ncs_callsign: string; my_role: string
  notes: string; checkin_count?: number
}
interface Operator {
  callsign: string; first_name?: string | null; name?: string | null; nickname?: string | null
  city?: string | null; state?: string | null; grid?: string | null; license_class?: string | null
  lookup_source?: string | null
}
interface CheckIn {
  id: number; net_id: number; callsign: string; logged_as: string; seq: number; time_utc: string
  mobile: number; portable: number; has_traffic: number; recognized: number; ragchew: number
  echolink: number; relayed_by: string; notes: string
}
interface Row { checkin: CheckIn; operator: Operator | null; nth: number; prev_seen: string | null }
interface OpDetail {
  operator: Operator; checkin_count: number; first_seen: string | null; last_seen: string | null
  history: { checkin: CheckIn; net: Net }[]
}

const FLAGS: { key: keyof CheckIn; label: string; tone: Tone }[] = [
  { key: 'mobile', label: 'M', tone: 'blue' },
  { key: 'portable', label: 'P', tone: 'blue' },
  { key: 'has_traffic', label: 'TFC', tone: 'amber' },
  { key: 'ragchew', label: 'RAG', tone: 'green' },
]
const hm = (iso: string) => iso ? iso.slice(11, 16) : ''
const opName = (o?: Operator | null) => o ? (o.name || [o.first_name, o.nickname].filter(Boolean).join(' ') || '') : ''
const opQth = (o?: Operator | null) => o ? [o.city, o.state].filter(Boolean).join(', ') : ''

export default function NetLogPage() {
  const [nets, setNets] = useState<Net[]>([])
  const [sel, setSel] = useState<Net | null>(null)
  const [rows, setRows] = useState<Row[]>([])
  const [op, setOp] = useState<OpDetail | null>(null)
  const [enabled, setEnabled] = useState(true)
  const [showNew, setShowNew] = useState(false)
  const [form, setForm] = useState({ name: '', frequency: '', mode: 'FM', band: '2m', ncs_callsign: '', my_role: 'NCS' })
  const [entry, setEntry] = useState('')
  const [err, setErr] = useState('')
  const selRef = useRef<number | null>(null)
  useEffect(() => { selRef.current = sel?.id ?? null }, [sel])

  const loadNets = () => fetch('/api/netlog/nets').then(r => r.json()).then(setNets).catch(() => {})
  const loadRows = (id: number) => fetch(`/api/netlog/nets/${id}/checkins`).then(r => r.json()).then(setRows).catch(() => {})

  useEffect(() => {
    fetch('/api/netlog/status').then(r => r.json()).then(d => setEnabled(d.enabled !== false)).catch(() => {})
    loadNets()
    let alive = true
    let retry: ReturnType<typeof setTimeout> | undefined
    let ws: WebSocket | null = null
    function connect() {
      ws = new WebSocket(wsUrl('/ws/netlog'))
      ws.onmessage = e => {
        try {
          const m = JSON.parse(e.data)
          if (m.type === 'checkins' && m.net_id === selRef.current) setRows(m.checkins)
        } catch { /* */ }
      }
      ws.onclose = () => { if (alive) retry = setTimeout(connect, 3000) }
    }
    connect()
    return () => { alive = false; if (retry) clearTimeout(retry); ws?.close() }
  }, [])

  function selectNet(n: Net) { setSel(n); setOp(null); loadRows(n.id) }

  async function createNet() {
    if (!form.name.trim()) return
    const r = await fetch('/api/netlog/nets', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form),
    })
    if (r.ok) { const n = await r.json(); setShowNew(false); setForm({ ...form, name: '' }); await loadNets(); selectNet(n) }
  }

  async function endNet() {
    if (!sel) return
    await fetch(`/api/netlog/nets/${sel.id}/end`, { method: 'POST' })
    await loadNets(); setSel(s => s ? { ...s, ended_utc: new Date().toISOString() } : s)
  }

  async function checkIn(e: React.FormEvent) {
    e.preventDefault()
    if (!sel || !entry.trim()) return
    setErr('')
    const r = await fetch(`/api/netlog/nets/${sel.id}/checkin`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text: entry }),
    })
    if (r.ok) { setEntry(''); loadRows(sel.id) }
    else { const d = await r.json().catch(() => ({})); setErr(d.detail || 'check-in failed') }
  }

  async function toggleFlag(ci: CheckIn, flag: string) {
    await fetch(`/api/netlog/checkins/${ci.id}/flag`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ flag }),
    })
    if (sel) loadRows(sel.id)
  }

  function openOp(call: string) {
    fetch(`/api/netlog/operators/${encodeURIComponent(call)}`).then(r => r.ok ? r.json() : null).then(setOp).catch(() => {})
  }

  if (!enabled) {
    return <div className="page"><div className="header"><span className="header-title">Net Log</span></div>
      <EmptyState icon={<ClipboardList />} title="Net logging disabled">Set <code>netlog.enable: true</code> in config.yaml.</EmptyState></div>
  }

  const live = sel && !sel.ended_utc

  return (
    <div className="page netlog">
      <div className="header">
        <span className="header-title">Net Log</span>
        <select className="netlog-select" value={sel?.id ?? ''} onChange={e => {
          const n = nets.find(x => x.id === Number(e.target.value)); if (n) selectNet(n)
        }}>
          <option value="" disabled>Select a net…</option>
          {nets.map(n => <option key={n.id} value={n.id}>{n.name}{n.ended_utc ? '' : ' (open)'} · {n.checkin_count ?? 0}</option>)}
        </select>
        <Button size="sm" icon={<Plus />} onClick={() => setShowNew(v => !v)}>New net</Button>
        {sel && <>
          <StatusBadge tone={live ? 'green' : 'gray'}>{live ? 'Open' : 'Ended'}</StatusBadge>
          {live && <Button size="sm" variant="danger" icon={<Square />} onClick={endNet}>End net</Button>}
          <a className="btn btn-sm" href={`/api/netlog/nets/${sel.id}/adif`} download><Download size={15} />ADIF</a>
        </>}
      </div>

      {showNew && (
        <Panel title="Start a net" bordered>
          <div className="netlog-form">
            <input placeholder="Net name" value={form.name} autoFocus
              onChange={e => setForm({ ...form, name: e.target.value })} onKeyDown={e => e.key === 'Enter' && createNet()} />
            <input placeholder="Freq" value={form.frequency} onChange={e => setForm({ ...form, frequency: e.target.value })} style={{ width: 100 }} />
            <input placeholder="Mode" value={form.mode} onChange={e => setForm({ ...form, mode: e.target.value })} style={{ width: 70 }} />
            <input placeholder="Band" value={form.band} onChange={e => setForm({ ...form, band: e.target.value })} style={{ width: 70 }} />
            <input placeholder="NCS call" value={form.ncs_callsign} onChange={e => setForm({ ...form, ncs_callsign: e.target.value.toUpperCase() })} style={{ width: 110 }} />
            <Button variant="primary" onClick={createNet}>Start</Button>
          </div>
        </Panel>
      )}

      {!sel ? (
        <EmptyState icon={<ClipboardList />} title="No net selected">Pick a net above, or start a new one.</EmptyState>
      ) : (
        <div className="netlog-body">
          <Panel className="netlog-main" flush>
            {live && (
              <form className="netlog-entry" onSubmit={checkIn}>
                <input placeholder="Callsign to check in (e.g. W1AW, K6EH/M) — Enter" value={entry}
                  autoFocus onChange={e => setEntry(e.target.value.toUpperCase())} />
                <Button variant="primary" type="submit" disabled={!entry.trim()}>Log</Button>
                {err && <span className="t-red" style={{ fontSize: 'var(--fs-sm)' }}>{err}</span>}
              </form>
            )}
            <div className="netlog-scroll">
              {rows.length === 0 ? <EmptyState>No check-ins yet.</EmptyState> : (
                <table className="data-table">
                  <thead><tr><th>#</th><th>Time</th><th>Callsign</th><th>Name</th><th>QTH</th><th>Flags</th></tr></thead>
                  <tbody>
                    {rows.map(r => (
                      <tr key={r.checkin.id}>
                        <td className="mono">{r.checkin.seq}</td>
                        <td className="mono">{hm(r.checkin.time_utc)}</td>
                        <td className="primary mono" style={{ cursor: 'pointer' }} onClick={() => openOp(r.checkin.callsign)}>
                          {r.checkin.callsign}{r.nth > 1 && <span className="muted"> ×{r.nth}</span>}
                        </td>
                        <td>{opName(r.operator)}</td>
                        <td className="muted">{opQth(r.operator)}{r.operator?.grid ? ` · ${r.operator.grid}` : ''}</td>
                        <td>
                          <span className="netlog-flags">
                            {FLAGS.map(f => (
                              <button key={f.key} className={`netlog-flag${r.checkin[f.key] ? ' on' : ''}`}
                                title={f.key} onClick={() => toggleFlag(r.checkin, f.key)}>{f.label}</button>
                            ))}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </Panel>

          {op && (
            <Panel className="netlog-op" title={op.operator.callsign} icon={<Users />}
              actions={<button className="btn btn-ghost btn-sm" onClick={() => setOp(null)}><X size={15} /></button>} bordered>
              <div className="metric-grid" style={{ paddingTop: 10 }}>
                <Metric label="Name" value={opName(op.operator) || '—'} />
                <Metric label="QTH" value={opQth(op.operator) || '—'} />
                <Metric label="Grid" value={op.operator.grid || '—'} mono />
                <Metric label="Class" value={op.operator.license_class || '—'} />
                <Metric label="Check-ins" value={op.checkin_count} />
              </div>
              <div className="section-label" style={{ margin: '12px 0 6px' }}>History</div>
              <div className="netlog-op-hist">
                {op.history.length === 0 ? <span className="muted">None.</span> : op.history.map((h, i) => (
                  <div key={i} className="netlog-hist-row">
                    <span className="mono muted">{(h.net.started_utc || '').slice(0, 10)}</span>
                    <span>{h.net.name}</span>
                  </div>
                ))}
              </div>
            </Panel>
          )}
        </div>
      )}
    </div>
  )
}
