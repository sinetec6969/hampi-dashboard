import type { ReactNode, ButtonHTMLAttributes, HTMLAttributes } from 'react'

export type Tone = 'green' | 'amber' | 'red' | 'blue' | 'gray'

export function StatusDot({ tone, pulse = false, lg = false, title }: { tone: Tone; pulse?: boolean; lg?: boolean; title?: string }) {
  return <span className={`status-dot ${tone}${pulse ? ' pulse' : ''}${lg ? ' lg' : ''}`} title={title} aria-hidden={!title} />
}

/** Colour + dot + text — state is never carried by colour alone. */
export function StatusBadge({ tone, children, pulse = false }: { tone: Tone; children: ReactNode; pulse?: boolean }) {
  return (
    <span className={`status-badge ${tone}`}>
      <StatusDot tone={tone} pulse={pulse} />
      {children}
    </span>
  )
}

interface PanelProps extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: ReactNode
  icon?: ReactNode
  sub?: ReactNode
  actions?: ReactNode
  bordered?: boolean
  flush?: boolean
}

export function Panel({ title, icon, sub, actions, bordered, flush, className = '', children, onClick, ...rest }: PanelProps) {
  return (
    <section className={`ui-panel${onClick ? ' clickable' : ''} ${className}`} onClick={onClick} {...rest}>
      {(title || actions) && (
        <header className={`ui-panel-header${bordered ? ' bordered' : ''}`}>
          {title && <h2 className="ui-panel-title">{icon}{title}</h2>}
          {sub && <span className="ui-panel-sub">{sub}</span>}
          {actions && <div className="ui-panel-actions">{actions}</div>}
        </header>
      )}
      <div className={`ui-panel-body${flush ? ' flush' : ''}`}>{children}</div>
    </section>
  )
}

export function Metric({ label, value, mono = false, className = '' }: { label: ReactNode; value: ReactNode; mono?: boolean; className?: string }) {
  return (
    <div className={`metric ${className}`}>
      <span className="metric-label">{label}</span>
      <span className={`metric-value${mono ? ' mono' : ''}`}>{value}</span>
    </div>
  )
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title?: ReactNode; children?: ReactNode }) {
  return (
    <div className="empty-state">
      {icon}
      {title && <strong>{title}</strong>}
      {children && <span>{children}</span>}
    </div>
  )
}

type Variant = 'secondary' | 'primary' | 'danger' | 'ghost'
interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant
  size?: 'sm' | 'md'
  selected?: boolean
  loading?: boolean
  icon?: ReactNode
}

export function Button({ variant = 'secondary', size = 'md', selected, loading, icon, className = '', children, ...rest }: ButtonProps) {
  const cls = ['btn', variant !== 'secondary' && `btn-${variant}`, size === 'sm' && 'btn-sm',
               selected && 'selected', loading && 'loading', className].filter(Boolean).join(' ')
  return (
    <button className={cls} aria-pressed={selected} aria-busy={loading || undefined} {...rest}>
      {icon}{children}
    </button>
  )
}
