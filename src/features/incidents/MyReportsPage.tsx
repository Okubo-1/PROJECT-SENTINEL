import { useEffect, useState, type ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useQuery } from '@tanstack/react-query'

import {
  Alert,
  Badge,
  DataTable,
  ExportMenu,
  PageHeader,
  Pagination,
  SeverityBadge,
  StatusBadge,
  buttonVariants,
  type DataTableColumn,
} from '../../components/ui'
import { useIncidentOrganization, useIncidents } from './useIncidentData'
import { getAllMatchingIncidents, getIncidentTypeCounts } from './incidentService'
import { incidentReportTypes, type IncidentListFilters, type IncidentListScope, type IncidentSummary } from './incidentTypes'
import { effectiveIncidentSeverityLabel } from '../../../supabase/functions/_shared/incidentReportFilters'
import { getActionsForIncidents } from '../qhse/inspectionActionService'
import type { LinkedIncidentAction } from '../qhse/inspectionActionService'
import { activeSettingNames, formatDate, formatDateTime, incidentHref, label } from './incidentFormatting'
import { exportExcel, exportPdf, exportRows, exportWord, type ExportFormat } from './incidentExport'
import { MyReportsFilters } from './MyReportsFilters'
import { companySettingsEventMatchesOrganization, companySettingsUpdatedEvent } from '../../lib/companySettingsSync'

const pageSize = 10

function SummaryStat({ label: statLabel, value }: { label: string; value: ReactNode }) {
  return (
    <div className="grid gap-1 border-line sm:border-l sm:pl-5 sm:first:border-l-0 sm:first:pl-0">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{statLabel}</span>
      <span className="font-display text-2xl font-semibold tabular-nums tracking-tight text-foreground">{value}</span>
    </div>
  )
}

// The own view lists the current user's reports; the organization view lists incidents across the organization.
// Both reuse this page's filters, table, and links for reopening drafts or viewing submitted incidents.
export function MyReportsPage({ supabase, canExport = false, canViewAll = false, scope = 'organization' }: { supabase: SupabaseClient; canExport?: boolean; canViewAll?: boolean; canClose?: boolean; scope?: IncidentListScope }) {
  const organization = useIncidentOrganization(supabase)
  const [sites, setSites] = useState<Array<{ id: string; name: string }>>([])
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [exportLoading, setExportLoading] = useState(false)
  const [exportMessage, setExportMessage] = useState('')
  const [exportError, setExportError] = useState('')
  const [administrator, setAdministrator] = useState('Authenticated user')
  const [selectedScope, setSelectedScope] = useState(scope)
  const [filters, setFilters] = useState<IncidentListFilters>(() => {
    const requestedReportType = new URLSearchParams(window.location.hash.split('?')[1] || '').get('reportType')
    const reportType = scope === 'organization'
      ? incidentReportTypes.find((type) => type === requestedReportType)
      : undefined
    return { status: 'all', incidentCategory: 'all', severity: 'all', siteId: 'all', department: 'all', reportType, page: 1, pageSize }
  })
  const [typeCounts, setTypeCounts] = useState<{ byType: Record<string, number>; open: number; closed: number } | null>(null)
  const incidents = useIncidents(supabase, filters, canViewAll ? selectedScope : 'own')
  const isOwnView = !canViewAll || selectedScope === 'own'
  const notifications = useQuery({
    queryKey: ['my-report-notifications', organization.data?.organizationId, organization.data?.userId],
    queryFn: async () => {
      const { data, error } = await supabase.rpc('get_my_report_notifications')
      if (error || !Array.isArray(data)) throw new Error('Unable to load your incident notifications.')
      return data as Array<{ incident_id: string; status: 'investigation_assigned' | 'investigated' | 'closed' | 'reopened' }>
    },
    enabled: Boolean(isOwnView && organization.data?.userId),
    refetchInterval: 60_000,
  })
  const incidentIds = incidents.data?.items.map((incident) => incident.id) || []
  const linkedActions = useQuery({
    queryKey: ['incident-linked-actions', organization.data?.organizationId || 'pending', organization.data?.userId || 'pending', incidentIds],
    queryFn: () => getActionsForIncidents(supabase, organization.data!.organizationId, incidentIds),
    enabled: Boolean(organization.data?.organizationId && incidentIds.length),
  })

  useEffect(() => {
    if (!organization.data?.organizationId) return
    let active = true
    const organizationId = organization.data.organizationId
    const loadSettings = () => {
      void Promise.all([
        supabase.from('sites').select('id, name').eq('organization_id', organizationId).order('name'),
        supabase.from('company_settings').select('departments, operational_sites, incident_categories, severity_levels').eq('organization_id', organizationId).maybeSingle(),
      ]).then(([siteResult, settingsResult]) => {
        if (!active) return
        setSettings(settingsResult.data || {})
        const configuredSiteNames = activeSettingNames(settingsResult.data?.operational_sites)
        setSites((siteResult.data || []).filter((site) => configuredSiteNames.some((name) => name.toLowerCase() === site.name.toLowerCase())))
      })
    }
    const handleSettingsUpdated = (event: Event) => {
      if (companySettingsEventMatchesOrganization(event, organizationId)) loadSettings()
    }
    loadSettings()
    window.addEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    return () => {
      active = false
      window.removeEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    }
  }, [organization.data?.organizationId, supabase])

  useEffect(() => {
    if (!organization.data?.userId) return
    void supabase.from('profiles').select('full_name').eq('id', organization.data.userId).maybeSingle().then(({ data }) => {
      if (data?.full_name) setAdministrator(data.full_name)
    })
  }, [organization.data?.userId, supabase])

  useEffect(() => {
    let active = true
    void getIncidentTypeCounts(supabase, filters, canViewAll ? selectedScope : 'own')
      .then((counts) => { if (active) setTypeCounts(counts) })
      .catch(() => { if (active) setTypeCounts(null) })
    return () => { active = false }
  }, [supabase, filters, canViewAll, selectedScope])

  const categories = activeSettingNames(settings.incident_categories)
  const severities = activeSettingNames(settings.severity_levels)
  const departments = activeSettingNames(settings.departments)
  const totalPages = incidents.data ? Math.max(1, Math.ceil(incidents.data.total / pageSize)) : 1
  const updateFilter = (key: keyof IncidentListFilters, value: string) => setFilters((current) => ({ ...current, [key]: value || undefined, page: 1 }))
  const resetFilters = () => setFilters({ status: 'all', incidentCategory: 'all', severity: 'all', siteId: 'all', department: 'all', incidentFilter: 'all', page: 1, pageSize })
  const changeScope = (nextScope: IncidentListScope) => {
    setSelectedScope(nextScope)
    setFilters((current) => ({ ...current, page: 1 }))
  }
  const actionsByIncident = new Map<string, LinkedIncidentAction[]>()
  for (const action of linkedActions.data || []) {
    if (!action.incident_id) continue
    actionsByIncident.set(action.incident_id, [...(actionsByIncident.get(action.incident_id) || []), action])
  }
  const siteName = (siteId: string | null) => sites.find((site) => site.id === siteId)?.name || 'Not set'

  const exportIncidents = async (format: ExportFormat) => {
    if (!canExport || !incidents.data) return
    setExportLoading(true)
    setExportError('')
    setExportMessage('')
    const generatedAt = new Date()
    try {
      // Export the full filtered set, not just the visible page.
      const allIncidents = await getAllMatchingIncidents(supabase, filters, canViewAll ? selectedScope : 'own')
      const rows = exportRows(allIncidents, sites)
      if (format === 'xlsx') await exportExcel(rows, generatedAt, administrator)
      if (format === 'pdf') exportPdf(rows, generatedAt, administrator)
      if (format === 'docx') await exportWord(rows, generatedAt, administrator)
      setExportMessage(`${format.toUpperCase()} incident register downloaded · ${rows.length} incident${rows.length === 1 ? '' : 's'}.`)
    } catch (error) {
      setExportError(error instanceof Error ? error.message : 'Unable to generate the incident export.')
    } finally {
      setExportLoading(false)
    }
  }

  const columns: DataTableColumn<IncidentSummary>[] = [
    {
      id: 'reference',
      header: 'Reference',
      cell: (incident) => (
        <a href={incidentHref(incident.id, incident.status)} className="font-mono text-xs font-medium text-brand-dark hover:underline">
          {incident.referenceNumber}
        </a>
      ),
    },
    {
      id: 'incident',
      header: 'Incident',
      cell: (incident) => (
        <div className="grid min-w-[220px] gap-0.5">
          <a href={incidentHref(incident.id, incident.status)} className="font-medium text-foreground hover:text-brand-dark">
            {incident.title}
          </a>
          <span className="text-xs text-muted">{incident.incidentCategory || 'Not set'} · Reported by {incident.createdBy}</span>
        </div>
      ),
    },
    { id: 'type', header: 'Type', cell: (incident) => <span className="text-sm">{label(incident.reportType)}</span> },
    {
      id: 'severity',
      header: 'Severity',
      cell: (incident) => <SeverityBadge severity={effectiveIncidentSeverityLabel(incident.severity, incident.potentialSeverity).toLowerCase()} />,
    },
    { id: 'status', header: 'Status', cell: (incident) => (
      <StatusBadge
        status={incident.status}
        label={incident.status === 'pending_verification' ? 'Resolved, awaiting verification' : undefined}
      />
    ) },
    {
      id: 'location',
      header: 'Site / department',
      cell: (incident) => (
        <div className="grid min-w-[150px] gap-0.5">
          <span className="text-sm text-foreground">{siteName(incident.siteId)}</span>
          <span className="text-xs text-muted">{incident.department || 'Not set'}</span>
        </div>
      ),
    },
    {
      id: 'actions',
      header: 'Assigned action',
      cell: (incident) => {
        const actions = actionsByIncident.get(incident.id) || []
        if (!actions.length) return <span className="text-xs text-muted">Unassigned</span>
        return (
          <div className="grid gap-1">
            {actions.map((action) => (
              <a key={action.id} href={`#assigned-actions?action=${action.id}`} className="text-xs font-medium text-brand-dark hover:underline">
                {label(action.type)} action
              </a>
            ))}
          </div>
        )
      },
    },
    {
      id: 'dates',
      header: 'Occurred / submitted',
      cell: (incident) => (
        <div className="grid min-w-[150px] gap-0.5">
          <span className="text-sm text-foreground">{formatDate(incident.occurredAt)}</span>
          <span className="text-xs text-muted">{formatDateTime(incident.reportedAt)}</span>
        </div>
      ),
    },
    {
      id: 'manage',
      header: 'Manage',
      cell: (incident) => {
        const canSubmitDraft = incident.status === 'draft' && selectedScope === 'own'
        if (!canSubmitDraft) return <span className="text-xs text-muted">—</span>
        return (
          <div className="flex flex-wrap gap-1">
            {canSubmitDraft && (
              <a href={`#report-incident?draft=${incident.id}&submit=1`} className={buttonVariants({ size: 'sm' })}>
                Submit
              </a>
            )}
          </div>
        )
      },
    },
  ]

  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Operations & QHSE"
        title={selectedScope === 'own' ? 'My reports' : 'Incident management'}
        description={`${incidents.data?.total ?? 0} records match the current filters.`}
        actions={
          <>
            {canExport && (
              <ExportMenu
                label="Export"
                busy={exportLoading}
                disabled={!incidents.data}
                options={[
                  { format: 'xlsx', label: 'Excel workbook (.xlsx)', icon: 'database' },
                  { format: 'pdf', label: 'PDF', icon: 'fileDownload' },
                  { format: 'docx', label: 'Word document (.docx)', icon: 'file' },
                ]}
                onExport={(format) => {
                  if (format === 'xlsx' || format === 'pdf' || format === 'docx') void exportIncidents(format)
                }}
              />
            )}
            <a href="#report-incident" className={buttonVariants({ size: 'sm' })}>Report incident</a>
          </>
        }
      />

      {exportError && <Alert tone="danger">{exportError}</Alert>}
      {exportMessage && <Alert tone="success">{exportMessage}</Alert>}
      {incidents.isError && <Alert tone="danger">Unable to load incidents. Please try again.</Alert>}
      {linkedActions.isError && <Alert tone="danger">{linkedActions.error.message}</Alert>}
      {isOwnView && notifications.isError && <Alert tone="danger">Unable to load your incident notifications.</Alert>}
      {isOwnView && Boolean(notifications.data?.length) && (
        <section className="rounded-xl border border-line p-4" aria-label="My incident notifications">
          <h2 className="text-sm font-semibold">Incident notifications</h2>
          <ul className="mt-2 grid gap-2">
            {[...(notifications.data || [])].reverse().map((notification, index) => (
              <li key={`${notification.incident_id}-${notification.status}-${index}`} className="text-sm">
                <a className="text-brand-dark underline" href={`#incident-detail?id=${notification.incident_id}`}>{notification.incident_id}</a>
                {' · '}{notification.status === 'investigation_assigned'
                  ? 'Assigned for investigation'
                  : notification.status === 'investigated'
                    ? 'Investigated'
                    : notification.status === 'reopened'
                      ? 'Reopened'
                      : 'Closed'}
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="border-y border-line">
        <div className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-3">
          <SummaryStat label="Total records" value={incidents.data?.total ?? '—'} />
          <SummaryStat label="Open" value={typeCounts ? typeCounts.open : '—'} />
          <SummaryStat label="Closed" value={typeCounts ? typeCounts.closed : '—'} />
        </div>
        <div className="flex flex-wrap items-center gap-2 border-t border-line py-3">
          {incidentReportTypes.map((type) => (
            <Badge key={type} tone="neutral">
              {label(type)} <span className="font-mono">{typeCounts ? typeCounts.byType[type] ?? 0 : '—'}</span>
            </Badge>
          ))}
        </div>
      </section>

      <MyReportsFilters
        filters={filters}
        selectedScope={selectedScope}
        canViewAll={canViewAll}
        isFetching={incidents.isFetching}
        sites={sites}
        severities={severities}
        departments={departments}
        categories={categories}
        onFilterChange={updateFilter}
        onScopeChange={changeScope}
        onReset={resetFilters}
        onRefresh={() => void incidents.refetch()}
      />

      <DataTable
        columns={columns}
        rows={incidents.data?.items ?? []}
        rowKey={(incident) => incident.id}
        loading={organization.isLoading || incidents.isLoading}
        loadingRows={6}
        empty={
          <div className="grid justify-items-center gap-2 py-4">
            <strong className="text-sm font-semibold text-foreground">No incident reports found</strong>
            <span className="text-sm text-muted">Adjust the filters or report the first incident.</span>
            <a href="#report-incident" className={buttonVariants({ size: 'sm' })}>Report incident</a>
          </div>
        }
        pagination={
          <div className="border-t border-line px-4 py-3">
            <Pagination
              page={filters.page || 1}
              totalPages={totalPages}
              total={incidents.data?.total}
              itemLabel="incidents"
              onPageChange={(page) => setFilters((current) => ({ ...current, page }))}
            />
          </div>
        }
      />
    </div>
  )
}
