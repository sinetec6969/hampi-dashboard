import { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react'

export type SdrMode = 'dmr' | 'scanner' | 'adsb' | 'sstv' | 'aprs' | 'meteor' | 'trunk'

export const SDR_MODES: { mode: SdrMode; label: string }[] = [
  { mode: 'dmr',     label: 'DMR' },
  { mode: 'scanner', label: 'SCANNER' },
  { mode: 'adsb',    label: 'ADS-B' },
  { mode: 'sstv',    label: 'SSTV' },
  { mode: 'aprs',    label: 'APRS' },
  { mode: 'meteor',  label: 'METEOR' },
  { mode: 'trunk',   label: 'TRUNK' },
]

export const MODE_LABEL: Record<SdrMode, string> = {
  dmr: 'DMR', scanner: 'SCANNER', adsb: 'ADS-B', sstv: 'SSTV',
  aprs: 'APRS', meteor: 'METEOR', trunk: 'TRUNK',
}

const INTENT_KEY = 'hampi-intended-mode'

interface ModeCtx {
  actualMode: SdrMode | null
  intendedMode: SdrMode
  setIntendedMode: (m: SdrMode) => void
  switching: SdrMode | null
  switchErr: string
  switchMode: (m: SdrMode) => void
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

  useEffect(() => {
    let alive = true
    const poll = () => fetch('/api/sdr/mode').then(r => r.json())
      .then(d => { if (alive) setActualMode(d.mode) }).catch(() => {})
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
    <Ctx.Provider value={{ actualMode, intendedMode, setIntendedMode, switching, switchErr, switchMode }}>
      {children}
    </Ctx.Provider>
  )
}

export function useMode() {
  const c = useContext(Ctx)
  if (!c) throw new Error('useMode outside ModeProvider')
  return c
}
