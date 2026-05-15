import { useNavigate } from 'react-router-dom'

interface Props {
  icon: string
  title: string
  color: string
  description: string
  features: string[]
  hardware: string[]
}

export default function PlaceholderPage({ icon, title, color, description, features, hardware }: Props) {
  const navigate = useNavigate()

  return (
    <div className="placeholder-page">
      <div className="placeholder-inner">
        <button className="placeholder-back" onClick={() => navigate('/')}>← Home</button>

        <div className="placeholder-header" style={{ borderColor: color }}>
          <span className="placeholder-icon">{icon}</span>
          <div>
            <div className="placeholder-title" style={{ color }}>{title}</div>
            <div className="placeholder-badge">○ Coming Soon</div>
          </div>
        </div>

        <p className="placeholder-desc">{description}</p>

        <div className="placeholder-section">
          <div className="placeholder-section-title">Planned features</div>
          <ul className="placeholder-list">
            {features.map((f, i) => <li key={i}>{f}</li>)}
          </ul>
        </div>

        <div className="placeholder-section">
          <div className="placeholder-section-title">Hardware required</div>
          <ul className="placeholder-list placeholder-list-hw">
            {hardware.map((h, i) => <li key={i}>{h}</li>)}
          </ul>
        </div>

        <div className="placeholder-roadmap">
          See <a href="https://github.com/sinetec6969/hampi-dashboard/blob/master/ROADMAP.md" target="_blank" rel="noreferrer">ROADMAP.md</a> for full implementation notes.
        </div>
      </div>
    </div>
  )
}
