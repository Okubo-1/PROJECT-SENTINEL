import { Alert, Badge, Card, DetailList, Skeleton, StatusBadge, buttonVariants } from '../../components/ui'
import type { LinkedIncidentAction } from '../qhse/inspectionActionService'
import { SectionTitle } from './IncidentDetailSection'
import { elapsedSince, formatDate, formatLabel } from './incidentDetailFormatting'

const ACTION_TONE: Record<LinkedIncidentAction['type'], 'warning' | 'info' | 'accent'> = {
  corrective: 'warning',
  preventive: 'info',
  investigation: 'accent',
}

export function IncidentLinkedActionsCard({ className, actions, loading, error, currentTime }: {
  className?: string
  actions: LinkedIncidentAction[] | undefined
  loading: boolean
  error: string | null
  currentTime: number
}) {
  return (
    <Card className={`h-full p-5 shadow-none ${className ?? ''}`}>
      <SectionTitle title="Linked actions" action={<Badge tone="neutral">{actions?.length ?? 0}</Badge>} />

      {loading ? (
        <Skeleton className="mt-4 h-20" />
      ) : error ? (
        <Alert tone="danger" className="mt-4">{error}</Alert>
      ) : actions?.length ? (
        <div className="mt-2 grid">
          {actions.map((action) => {
            const overdue = action.status === 'open' && new Date(action.due_at).getTime() < currentTime
            return (
              <div key={action.id} className="grid gap-3 border-b border-line py-4 first:pt-0 last:border-0 last:pb-0">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge tone={ACTION_TONE[action.type]}>{formatLabel(action.type)}</Badge>
                  <StatusBadge status={overdue ? 'overdue' : action.status === 'resolved' ? 'closed' : 'open'} />
                </div>
                <p className="text-sm text-foreground">{action.description}</p>
                <DetailList
                  columns={2}
                  items={[
                    { label: 'Assigned', value: formatDate(action.assigned_at) },
                    { label: 'Elapsed', value: elapsedSince(action.assigned_at, currentTime) },
                    { label: 'Due', value: formatDate(action.due_at) },
                  ]}
                />
                {action.assignee_id && (
                  <a href={`#assigned-actions?action=${action.id}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                    View action
                  </a>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <p className="mt-4 text-sm text-muted">No actions are linked to this incident.</p>
      )}
    </Card>
  )
}
