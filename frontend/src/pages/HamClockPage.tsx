const OHC_PORT = 3001

export default function HamClockPage() {
  const src = `http://${window.location.hostname}:${OHC_PORT}/`
  return (
    <>
      <div className="header">
        <span className="header-title">┌─ HAMCLOCK</span>
        <a href={src} target="_blank" rel="noreferrer"
           style={{ fontSize: 11, letterSpacing: 1, color: '#4d7a62', textDecoration: 'none' }}>
          OPEN DIRECT ↗
        </a>
      </div>
      <iframe
        src={src}
        title="OpenHamClock"
        style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#000' }}
      />
    </>
  )
}
