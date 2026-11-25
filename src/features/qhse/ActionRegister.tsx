import { Badge, Button, Select, Skeleton, StatusBadge, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui'
import type { ActionRecord, ActionType, EligibleIncident, QhsePerson, QhseSite } from './inspectionActionService'

const ACTION_TONE: Record<ActionType, 'warning' | 'info' | 'accent'> = {
  corrective: 'warning',
  preventive: 'info',
  investigation: 'accent',
}

function actionTypeLabel(type: ActionType) {
  return type === 'corrective' ? 'Corrective' : type === 'preventive' ? 'Preventive' : 'Investigation'
}

export function ActionRegister({ filteredActions, workspaceLoading, currentTime, currentUserId, canManage, assignedOnly, busy, sites, people, linkedIncidents, onToggleResolve, onReassign, onDownloadProof }: {
  filteredActions: ActionRecord[]
  workspaceLoading: boolean
  currentTime: number
  currentUserId: string
  canManage: boolean
  assignedOnly: boolean
  busy: boolean
  sites: QhseSite[]
  people: QhsePerson[]
  linkedIncidents: EligibleIncident[]
  onToggleResolve: (action: ActionRecord) => void
  onReassign: (action: ActionRecord, assigneeId: string) => void
  onDownloadProof: (action: ActionRecord) => void
}) {
  const siteName = (id: string) => sites.find((site) => site.id === id)?.name || 'Site unavailable'
  const personName = (id: string) => people.find((person) => person.id === id)?.full_name || 'Organization user'
  const incidentLabel = (id: string | null) => {
    if (!id) return '—'
    const incident = linkedIncidents.find((item) => item.id === id)
    return incident ? `${incident.reference_number} — ${incident.title}` : 'Incident details unavailable'
  }

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Action</TableHead>
              <TableHead>Incident</TableHead>
              <TableHead>Site</TableHead>
              <TableHead>Assignee</TableHead>
              <TableHead>Due</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Dates</TableHead>
              <TableHead>Manage</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {workspaceLoading && Array.from({ length: 4 }).map((_, index) => (
              <TableRow key={`skeleton-${index}`} className="hover:bg-transparent">
                <TableCell colSpan={8}><Skeleton className="h-10 w-full" /></TableCell>
              </TableRow>
            ))}

            {!workspaceLoading && filteredActions.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="py-10 text-center">
                  <div className="grid justify-items-center gap-1">
                    <strong className="text-sm font-semibold text-foreground">
                      {assignedOnly ? 'No actions assigned to you' : 'No actions have been created yet'}
                    </strong>
                    <span className="text-sm text-muted">
                      {assignedOnly ? 'When an action is assigned to you it will appear here.' : 'Create the first action using the form above.'}
                    </span>
                  </div>
                </TableCell>
              </TableRow>
            )}

            {!workspaceLoading && filteredActions.map((action) => {
              const overdue = action.status === 'open' && new Date(action.due_at).getTime() < currentTime
              const canResolve = action.status === 'open' && action.assignee_id === currentUserId
              return (
                <TableRow key={action.id} id={`action-${action.id}`}>
                  <TableCell>
                    <div className="flex min-w-[260px] flex-col items-start gap-1">
                      <Badge tone={ACTION_TONE[action.type]}>{actionTypeLabel(action.type)}</Badge>
                      <strong className="text-sm font-medium text-foreground">{action.description}</strong>
                      {action.resolution_notes && <span className="text-xs text-muted">Resolution: {action.resolution_notes}</span>}
                    </div>
                  </TableCell>
                  <TableCell><span className="block min-w-[200px] text-sm">{incidentLabel(action.incident_id)}</span></TableCell>
                  <TableCell><span className="text-sm">{siteName(action.site_id)}</span></TableCell>
                  <TableCell>
                    {canManage && !assignedOnly && action.status === 'open' ? (
                      <Select
                        aria-label={`Assignee for ${action.description}`}
                        value={action.assignee_id}
                        disabled={busy}
                        onChange={(event) => onReassign(action, event.target.value)}
                        containerClassName="min-w-[160px]"
                      >
                        {people.map((person) => <option key={person.id} value={person.id}>{person.full_name}</option>)}
                      </Select>
                    ) : (
                      <span className="text-sm">{personName(action.assignee_id)}</span>
                    )}
                  </TableCell>
                  <TableCell>
                    <span className={`block min-w-[150px] text-sm ${overdue ? 'font-medium text-danger' : ''}`}>
                      {new Date(action.due_at).toLocaleString()}
                    </span>
                  </TableCell>
                  <TableCell>
                    <StatusBadge status={overdue ? 'overdue' : action.status === 'resolved' ? 'closed' : 'open'} />
                  </TableCell>
                  <TableCell>
                    <div className="grid min-w-[150px] gap-0.5">
                      <span className="text-sm text-foreground">{new Date(action.created_at).toLocaleDateString()}</span>
                      <span className="text-xs text-muted">{action.resolved_at ? new Date(action.resolved_at).toLocaleString() : 'Not resolved'}</span>
                    </div>
                  </TableCell>
                  <TableCell>
                    {canResolve ? (
                      <Button variant="outline" size="sm" onClick={() => onToggleResolve(action)}>
                        Resolve
                      </Button>
                    ) : action.proof_storage_path && action.proof_file_name ? (
                      <Button variant="outline" size="sm" onClick={() => onDownloadProof(action)}>
                        View proof
                      </Button>
                    ) : (
                      <span className="text-xs text-muted">—</span>
                    )}
                  </TableCell>
                </TableRow>
              )
            })}
          </TableBody>
        </table>
      </div>
    </div>
  )
}
