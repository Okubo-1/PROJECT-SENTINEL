import { SeverityBadge } from '../../components/ui/badge'
import { Card } from '../../components/ui/card'
import { EmptyState } from '../../components/ui/empty-state'
import { Icon } from '../../components/ui/icon'
import { StatusBadge } from '../../components/ui/status-badge'
import type { DashboardIncident } from './types'

function formatIncidentDate(value: string | null) {
  if (!value) return 'Date not set'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Date not set' : date.toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
}

/** The handover list: latest incidents, their severity and current status. */
export function RecentIncidentsCard({ incidents }: { incidents: DashboardIncident[] }) {
  return (
    <Card className="flex h-full flex-col shadow-none">
      <div className="flex items-start justify-between gap-3 p-5 pb-2">
        <div>
          <h3 className="font-display text-base font-semibold text-foreground">Recent incidents</h3>
          <p className="mt-0.5 text-sm text-muted">Latest submissions in this window</p>
        </div>
        <a href="#incidents" className="inline-flex shrink-0 items-center gap-1 text-xs font-semibold text-brand-dark hover:underline">
          View all <Icon name="arrowRight" size={12} />
        </a>
      </div>

      {incidents.length ? (
        <div className="grid px-5 pb-2">
          {incidents.slice(0, 3).map((incident) => (
            <a
              key={incident.id}
              href={`#incident-detail?id=${incident.id}`}
              className="group grid gap-1.5 border-t border-line py-2.5 first:border-t-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand/40 focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
            >
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate font-mono text-[11px] text-muted">{incident.referenceNumber}</span>
                <span className="shrink-0 text-[11px] text-muted">{formatIncidentDate(incident.occurredAt)}</span>
              </div>
              <div className="flex min-w-0 items-center justify-between gap-3">
                <span className="min-w-0 truncate text-sm font-medium text-foreground transition-colors group-hover:text-brand-dark">{incident.title}</span>
                <SeverityBadge severity={incident.severity} className="shrink-0" />
              </div>
              <div className="flex min-w-0 items-center gap-2">
                <StatusBadge
                  status={incident.status}
                  label={incident.status === 'pending_verification' ? 'Resolved, awaiting verification' : undefined}
                  className="shrink-0"
                />
                {incident.location && <span className="min-w-0 truncate text-xs text-muted">{incident.location}</span>}
              </div>
            </a>
          ))}
        </div>
      ) : (
        <EmptyState
          className="my-4"
          icon="inbox"
          title="No incidents in this window"
          description="Adjust the filters or report an incident to start the register."
        />
      )}
    </Card>
  )
}
