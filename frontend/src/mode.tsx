import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'

export type SdrMode = 'dmr' | 'scanner' | 'adsb' | 'sstv' | 'aprs' | 'meteor' | 'subghz' | 'pager' | 'websdr' | 'trunk'

export const SDR_MODES: { mode: SdrMode; label: string }[] = [
  { mode: 'dmr',     label: 'DMR' },
  { mode: 'scanner', label: 'Scanner' },
  { mode: 'adsb',    label: 'ADS-B' },
  { mode: 'sstv',    label: 'SSTV' },
  { mode: 'aprs',    label: 'APRS' },
  { mode: 'meteor',  label: 'METEOR' },
  { mode: 'subghz',  label: 'Sub-GHz' },
  { mode: 'pager',   label: 'Pager' },
  { mode: 'websdr',  label: 'WebSDR' },
  { mode: 'trunk',   label: 'Trunk' },
]

export const MODE_LABEL = Object.fromEntries(SDR_MODES.map(m => [m.mode, m.label])) as Record<SdrMode, string>

const INTENT_KEY = 'hampi-intended-mode'

export interface ModeCap { ok: boolean; missing: string[]; hint: string }

interface ModeCtx {
  actualMode: SdrMode | null
  intendedMode: SdrMode
  setIntendedMode: (m: SdrMode) => void
  switching: SdrMode | null
  switchErr: string
  switchMode: (m: SdrMode) => void
  caps: Partial<Record<SdrMode, ModeCap>>
  online: boolean | null   // null until the first /api/sdr/mode poll answers
}

const Ctx = createContext<ModeCtx | null>(null)

export function ModeProvider({ children }: { children: React.ReactNode }) {
  const [actualMode, setActualMode] = useState<SdrMode | null>(null)
  const [intendedMode, setIntended] = useState<SdrMode>(() => {
    // A stale 'airband' from before the scanner rename would 400 on switch
    const saved = localStorage.getItem(INTENT_KEY) as SdrMode
    return SDR_MODES.some(m => m.mode === saved) ? saved : 'dmr'
  })
  const [switching, setSwitching] = useState<SdrMode | null>(null)
  const [switchErr, setSwitchErr] = useState('')
  const switchingRef = useRef(false)
  const [caps, setCaps] = useState<Partial<Record<SdrMode, ModeCap>>>({})
  const [online, setOnline] = useState<boolean | null>(null)

  useEffect(() => {
    fetch('/api/capabilities').then(r => r.json()).then(d => setCaps(d.modes ?? {})).catch(() => {})
  }, [])

  useEffect(() => {
    let alive = true
    const poll = () => fetch('/api/sdr/mode').then(r => r.json())
      .then(d => { if (alive) { setActualMode(d.mode); setOnline(true) } })
      .catch(() => { if (alive) setOnline(false) })
    poll()
    const id = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  const setIntendedMode = useCallback((m: SdrMode) => {
    setIntended(m)
    localStorage.setItem(INTENT_KEY, m)
  }, [])

  const switchMode = useCallback(async (mode: SdrMode) => {
    if (switchingRef.current) return
    switchingRef.current = true
    setSwitching(mode)
    setSwitchErr('')
    try {
      const r = await fetch(`/api/sdr/mode?mode=${mode}`, { method: 'POST' })
      if (r.ok) {
        const d = await r.json()
        setActualMode(d.mode)
      } else {
        const d = await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))
        setSwitchErr(`${d.detail ?? 'switch failed'} — rolled back. Usually the dongle was still settling; try again in a few seconds.`)
        const cur = await fetch('/api/sdr/mode').then(res => res.json())
        setActualMode(cur.mode)
      }
    } catch {
      setSwitchErr('Lost the server mid-switch — reload the page and check the service.')
    }
    switchingRef.current = false
    setSwitching(null)
  }, [])

  return (
    <Ctx.Provider value={{ actualMode, intendedMode, setIntendedMode, switching, switchErr, switchMode, caps, online }}>
      {children}
    </Ctx.Provider>
  )
}

export function useMode() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useMode outside ModeProvider')
  return c
}
