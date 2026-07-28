const ALLSCAN_URL = 'http://100.124.27.79/allscan/'

export default function AllScanPage() {
  return (
    <>
      <div className="header">
        <span className="header-title">┌─ ALLSCAN</span>
        <a href={ALLSCAN_URL} target="_blank" rel="noreferrer"
           style={{ fontSize: 11, letterSpacing: 1, color: '#4d7a62', textDecoration: 'none' }}>
          OPEN DIRECT ↗
        </a>
      </div>
      <iframe
        src={ALLSCAN_URL}
        title="AllScan"
        style={{ flex: 1, minHeight: 0, width: '100%', border: 'none', background: '#000' }}
      />
    </>
  )
}
