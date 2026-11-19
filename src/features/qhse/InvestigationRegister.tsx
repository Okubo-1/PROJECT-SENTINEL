import type { SupabaseClient } from '@supabase/supabase-js'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { z } from 'zod'

import { Alert, Badge, Button, Card, DataTable, EmptyState, Skeleton } from '../../components/ui'
import type { DataTableColumn } from '../../components/ui'
import { InvestigationDialog } from './InvestigationDialog'

const investigationRowSchema = z.object({
  investigation_id: z.uuid(),
  incident_id: z.uuid(),
  incident_reference: z.string(),
  severity: z.string().nullable(),
  status: z.string(),
  due_at: z.iso.datetime({ offset: true }).nullable(),
  is_overdue: z.boolean(),
  no_team_assigned: z.boolean(),
  can_edit: z.boolean(),
  assigned_team: z.array(z.object({
    user_id: z.uuid(),
    full_name: z.string(),
  })),
})

const investigationNotificationSchema = z.object({
  id: z.uuid(),
  notification_type: z.enum(['assigned', 'due_soon']),
  incident_id: z.uuid(),
  severity: z.string(),
  due_at: z.iso.datetime({ offset: true }),
  created_at: z.iso.datetime({ offset: true }),
})
const incidentNotificationSchema = z.object({
  id: z.uuid(),
  notification_type: z.enum(['verification_ready', 'reopened']),
  incident_id: z.uuid(),
  severity: z.string(),
  due_at: z.iso.datetime({ offset: true }).nullable(),
  created_at: z.iso.datetime({ offset: true }),
})

type InvestigationRow = z.infer<typeof investigationRowSchema>
type InvestigationNotification = z.infer<typeof investigationNotificationSchema>

function formatDueAt(value: string | null) {
  if (!value) return '—'
  const date = new Date(value)
  return Number.isNaN(date.getTime())
    ? '—'
    : date.toLocaleString(undefined, {
        day: '2-digit',
        month: 'short',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
      })
}

export function InvestigationRegister({ client, organizationId }: {
  client: SupabaseClient
  organizationId: string
}) {
  const [selectedInvestigationId, setSelectedInvestigationId] = useState<string | null>(null)
  const investigations = useQuery({
    queryKey: ['investigation-register', organizationId],
    queryFn: async () => {
      const { data, error } = await client.rpc('list_investigations')
      if (error) throw new Error(error.message)
      return z.array(investigationRowSchema).parse(data)
    },
  })
  const notifications = useQuery({
    queryKey: ['investigation-notifications', organizationId],
    enabled: investigations.isSuccess,
    queryFn: async () => {
      const { data, error } = await client
        .from('investigation_notifications')
        .select('id, notification_type, incident_id, severity, due_at, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw new Error(error.message)
      return z.array(investigationNotificationSchema).parse(data)
    },
  })
  const incidentNotifications = useQuery({
    queryKey: ['incident-workflow-notifications', organizationId],
    enabled: investigations.isSuccess,
    queryFn: async () => {
      const { data, error } = await client
        .from('incident_workflow_notifications')
        .select('id, notification_type, incident_id, severity, due_at, created_at')
        .eq('organization_id', organizationId)
        .order('created_at', { ascending: false })
        .limit(50)
      if (error) throw new Error(error.message)
      return z.array(incidentNotificationSchema).parse(data)
    },
  })

  const columns: DataTableColumn<InvestigationRow>[] = [
    {
      id: 'incident',
      header: 'Incident ID',
      cell: (row) => <span className="font-mono text-sm">{row.incident_reference}</span>,
    },
    {
      id: 'severity',
      header: 'Severity',
      cell: (row) => <span className="text-sm">{row.severity || 'Unspecified'}</span>,
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <div className="flex flex-wrap gap-2">
          <Badge tone={row.status === 'completed' ? 'success' : 'neutral'}>
            {row.status === 'completed' ? 'Investigated' : row.status.replaceAll('_', ' ')}
          </Badge>
          {row.is_overdue && <Badge tone="danger">Overdue</Badge>}
        </div>
      ),
    },
    {
      id: 'due',
      header: 'Due date',
      cell: (row) => <span className="whitespace-nowrap font-mono text-xs">{formatDueAt(row.due_at)}</span>,
    },
    {
      id: 'team',
      header: 'Assigned team',
      cell: (row) => row.assigned_team.length
        ? <span className="text-sm">{row.assigned_team.map((member) => member.full_name).join(', ')}</span>
        : <span className="text-sm text-muted">No team assigned</span>,
    },
    {
      id: 'investigate',
      header: 'Investigation',
      cell: (row) => row.can_edit ? (
        <Button variant="outline" size="sm" onClick={() => setSelectedInvestigationId(row.investigation_id)}>
          {row.status === 'completed' ? 'View record' : 'Investigate'}
        </Button>
      ) : <span className="text-xs text-muted">View only</span>,
    },
  ]

  const refresh = async () => {
    await investigations.refetch()
    await notifications.refetch()
  }

  return (
    <Card className="grid gap-4 p-5 sm:p-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">Investigations</h2>
          <p className="text-sm text-muted">Investigations assigned to your severity-level team.</p>
        </div>
        <Button
          variant="outline"
          size="sm"
          loading={investigations.isFetching}
          onClick={() => void refresh()}
        >
          Refresh
        </Button>
      </div>

      {investigations.isPending ? (
        <Skeleton className="h-48" />
      ) : investigations.isError ? (
        <Alert tone="danger">
          {investigations.error.message}
          <Button variant="outline" size="sm" className="mt-2" onClick={() => void investigations.refetch()}>Retry</Button>
        </Alert>
      ) : (
        <div className="grid gap-4">
          {notifications.isError && <Alert tone="danger">{notifications.error.message}</Alert>}
          {notifications.data?.length ? (
            <section aria-label="Investigation notifications" className="grid gap-2">
              <h3 className="text-sm font-semibold text-foreground">Your notifications</h3>
              {notifications.data.map((notification: InvestigationNotification) => (
                <div key={notification.id} className="rounded-xl border border-line px-4 py-3">
                  <p className="text-sm font-medium text-foreground">
                    {notification.notification_type === 'assigned' ? 'Investigation assigned' : 'Investigation due soon'}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Incident {notification.incident_id} · {notification.severity} · Due {formatDueAt(notification.due_at)}
                  </p>
                </div>
              ))}
            </section>
          ) : notifications.isPending ? (
            <Skeleton className="h-16" />
          ) : null}
          {incidentNotifications.isError && <Alert tone="danger">{incidentNotifications.error.message}</Alert>}
          {incidentNotifications.data?.length ? (
            <section aria-label="Incident verification notifications" className="grid gap-2">
              <h3 className="text-sm font-semibold text-foreground">Close-out and reopen notifications</h3>
              {incidentNotifications.data.map((notification) => (
                <div key={notification.id} className="rounded-xl border border-line px-4 py-3">
                  <p className="text-sm font-medium text-foreground">
                    {notification.notification_type === 'verification_ready'
                      ? 'Incident ready for close-out verification'
                      : 'Investigation reopened and assigned'}
                  </p>
                  <p className="mt-1 text-xs text-muted">
                    Incident {notification.incident_id} · {notification.severity}
                    {notification.due_at ? ` · Due ${formatDueAt(notification.due_at)}` : ''}
                  </p>
                </div>
              ))}
            </section>
          ) : incidentNotifications.isPending ? (
            <Skeleton className="h-16" />
          ) : null}
          {investigations.data.length ? (
            <>
              {investigations.data.some((row) => row.no_team_assigned) && (
                <Alert tone="warning">Some submitted incidents have no configured investigation team. Assign teams in Settings.</Alert>
              )}
              <DataTable
                columns={columns}
                rows={investigations.data}
                rowKey={(row) => row.investigation_id}
                empty={<EmptyState icon="inspections" title="No investigations" description="There are no investigations assigned to your team." />}
              />
            </>
          ) : (
            <EmptyState
              icon="inspections"
              title="No investigations yet"
              description="New incident submissions will appear here when they match your investigation team severity levels."
            />
          )}
        </div>
      )}
      {selectedInvestigationId && (
        <InvestigationDialog
          client={client}
          investigationId={selectedInvestigationId}
          onClose={() => setSelectedInvestigationId(null)}
        />
      )}
    </Card>
  )
}
