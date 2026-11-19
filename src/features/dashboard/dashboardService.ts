import type { SupabaseClient } from '@supabase/supabase-js'
import { CheckCircle2, CircleAlert, ClipboardCheck, ClipboardList, Eye, FileWarning, Flame, Gauge } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import type { DashboardActivity, DashboardFilters, DashboardIncident, DashboardMetric, DashboardSnapshot } from './types'
import { calculateIncidentStatusCounts, effectiveIncidentSeverityLabel, incidentSeverityFilterPatterns, normalizeIncidentReportType } from '../../../supabase/functions/_shared/incidentReportFilters'

const dateRangeDays: Record<DashboardFilters['dateRange'], number | null> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
  all: null,
}

function metadataText(metadata: Record<string, unknown>, key: string) {
  return typeof metadata[key] === 'string' ? metadata[key] : ''
}

function normalizeIncidentCategoryName(value: string) {
  const normalized = value.trim().toLowerCase().replace(/\s+/g, ' ')
  const legacyMap: Record<string, string> = {
    'near miss': 'Near Miss',
    'near-miss': 'Near Miss',
    'unsafe condition': 'Unsafe Condition',
    'unsafe act': 'Unsafe Act',
    'environmental incident': 'Environmental Incident',
    'environmental event': 'Environmental Incident',
    'slip trip fall': 'Slip/Trip/Fall',
    'slip/trip/fall': 'Slip/Trip/Fall',
  }
  return legacyMap[normalized] || value.trim()
}

function incidentCategoryValues(value: string) {
  const normalized = normalizeIncidentCategoryName(value)
  const legacyValues: Record<string, string[]> = {
    'Near Miss': ['Near Miss', 'near miss', 'near-miss'],
    'Unsafe Condition': ['Unsafe Condition', 'unsafe condition'],
    'Unsafe Act': ['Unsafe Act', 'unsafe act'],
    'Environmental Incident': ['Environmental Incident', 'environmental incident', 'environmental event'],
    'Slip/Trip/Fall': ['Slip/Trip/Fall', 'slip trip fall', 'slip/trip/fall'],
  }
  return legacyValues[normalized] || [value]
}

function configuredActiveNames(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    if (typeof item === 'string') {
      const name = item.trim()
      return name ? [name] : []
    }
    if (item && typeof item === 'object') {
      const candidate = item as Record<string, unknown>
      const name = typeof candidate.name === 'string' ? candidate.name.trim() : ''
      return name && candidate.active !== false && candidate.deleted !== true ? [name] : []
    }
    return []
  })
}

type DashboardIncidentRow = {
  id: string
  reference_number: string
  title: string
  report_type: string
  status: string
  occurred_at: string | null
  reported_at: string | null
  created_at: string
  location: string | null
  site_id: string | null
  department: string | null
  shift: string | null
  severity: string | null
  potential_severity: string | null
  incident_category: string | null
}

function configuredDistribution(configuredNames: string[], values: Array<string | null | undefined>) {
  const counts = new Map(configuredNames.map((name) => [name, 0]))
  values.forEach((value) => {
    const name = value?.trim()
    if (!name) return
    const configuredName = configuredNames.find((candidate) => candidate.toLowerCase() === name.toLowerCase())
    counts.set(configuredName || name, (counts.get(configuredName || name) || 0) + 1)
  })
  return [...counts.entries()]
    .map(([name, value]) => ({ name, value }))
}

function monthLabel(value: Date) {
  return value.toLocaleDateString(undefined, { month: 'short', year: 'numeric' })
}

function unavailableMetrics(): DashboardMetric[] {
  const entries: [string, string, LucideIcon, string, string][] = [
    ['total-incidents', 'Total incidents', FileWarning, '#incidents', 'Incident Management'],
    ['open-incidents', 'Open incidents', CircleAlert, '#incidents', 'Incident Management'],
    ['resolved-incidents', 'Resolved incidents', CheckCircle2, '#incidents', 'Incident Management'],
    ['high-risk-incidents', 'High-risk incidents', Flame, '#incidents', 'Incident Management'],
    ['open-high-risk-incidents', 'Open high-risk incidents', Flame, '#incidents', 'Incident Management'],
    ['closed-high-risk-incidents', 'Closed high-risk incidents', Flame, '#incidents', 'Incident Management'],
    ['near-misses', 'Near misses', Eye, '#report-incident', 'Report Incident'],
    ['inspections-completed', 'Inspections completed', ClipboardCheck, '#inspections', 'Safety Inspections'],
    ['safety-score', 'Safety score', Gauge, '#executive-analytics', 'Executive Analytics'],
  ]
  return entries.map(([key, label, icon, href, module]) => ({
    key,
    label,
    value: 'Unavailable',
    detail: `Coming with ${module}`,
    icon,
    href,
    available: false,
    tone: key.includes('risk') || key.includes('overdue') ? 'orange' : 'neutral',
  }))
}

export async function getDashboardSnapshot(
  client: SupabaseClient,
  organizationId: string,
  filters: DashboardFilters,
  currentUserId: string,
): Promise<DashboardSnapshot> {
  const days = dateRangeDays[filters.dateRange]
  const since = days ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString() : null
  let activityQuery = client
    .from('activity_logs')
    .select('id, created_at, activity, user_id, location, metadata')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(100)

  if (since) activityQuery = activityQuery.gte('created_at', since)

  const { data, error } = await activityQuery
  if (error) throw new Error('Unable to load dashboard activity.')

  const [{ data: settings, error: settingsError }, { data: organizationSites, error: sitesError }] = await Promise.all([
    client
      .from('company_settings')
      .select('departments, operational_sites, incident_categories, severity_levels, working_hours')
      .eq('organization_id', organizationId)
      .maybeSingle(),
    client
      .from('sites')
      .select('id, name')
      .eq('organization_id', organizationId)
      .order('name'),
  ])
  if (settingsError || sitesError) throw new Error('Unable to load organization dashboard configuration.')

  const selectedSiteId = filters.site === 'all'
    ? null
    : organizationSites?.find((site) => site.name.trim().toLowerCase() === filters.site.trim().toLowerCase())?.id ?? '00000000-0000-0000-0000-000000000000'

  let filteredIncidentQuery = client
    .from('incidents')
    .select('id, reference_number, title, report_type, status, occurred_at, reported_at, created_at, location, site_id, department, shift, severity, potential_severity, incident_category')
    .eq('organization_id', organizationId)
    .neq('status', 'draft')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
  const dateColumn = filters.dateBasis === 'reported' ? 'reported_at' : 'occurred_at'
  if (since) filteredIncidentQuery = filteredIncidentQuery.gte(dateColumn, since)
  if (selectedSiteId) filteredIncidentQuery = filteredIncidentQuery.eq('site_id', selectedSiteId)
  if (filters.department !== 'all') filteredIncidentQuery = filteredIncidentQuery.eq('department', filters.department)
  if (filters.severity !== 'all') {
    const severityPatterns = incidentSeverityFilterPatterns(filters.severity)
    filteredIncidentQuery = filteredIncidentQuery.or(severityPatterns.flatMap((pattern) => [`severity.ilike.${pattern}`, `potential_severity.ilike.${pattern}`]).join(','))
  }
  if (filters.incidentType !== 'all') filteredIncidentQuery = filteredIncidentQuery.in('incident_category', incidentCategoryValues(filters.incidentType))
  if (filters.shift !== 'all') filteredIncidentQuery = filteredIncidentQuery.eq('shift', filters.shift)

  const { data: operationsMetrics, error: operationsMetricsError } = await client.rpc('get_inspection_action_metrics', {
    p_since: since,
    p_site_id: selectedSiteId,
  })
  if (operationsMetricsError) throw new Error('Unable to load inspection and action dashboard metrics.')
  const metricsRow = Array.isArray(operationsMetrics) ? operationsMetrics[0] : null

  const incidentRows: DashboardIncidentRow[] = []
  // Chart distributions need every matching row, so fetch them in bounded pages instead of one unbounded request.
  const incidentPageSize = 500
  for (let offset = 0; ; offset += incidentPageSize) {
    const { data: page, error: pageError } = await filteredIncidentQuery.range(offset, offset + incidentPageSize - 1)
    if (pageError) throw new Error('Unable to load incident dashboard metrics.')
    incidentRows.push(...(page || []) as DashboardIncidentRow[])
    if (!page || page.length < incidentPageSize) break
  }
  const incidentStatusCounts = calculateIncidentStatusCounts(incidentRows)
  const incidentMetricValues: Record<string, number> = {
    'total-incidents': incidentStatusCounts.total,
    'open-incidents': incidentStatusCounts.open,
    'resolved-incidents': incidentStatusCounts.closed,
    'high-risk-incidents': incidentStatusCounts.highRisk,
    'open-high-risk-incidents': incidentStatusCounts.openHighRisk,
    'closed-high-risk-incidents': incidentStatusCounts.closedHighRisk,
    'near-misses': incidentRows.filter((incident) => normalizeIncidentReportType(incident.report_type) === 'near_miss').length,
    'inspections-completed': Number(metricsRow?.inspections_completed || 0),
  }
  // Only keys present in incidentMetricValues have live counts; all other metric cards remain explicitly unavailable.
  const metrics = unavailableMetrics().map((metric) => {
    const value = incidentMetricValues[metric.key]
    if (value === undefined) return metric
    const detail = metric.key === 'inspections-completed'
      ? 'Saved inspection records in the selected date range'
      : metric.key.includes('high-risk')
        ? 'High/Critical actual or potential severity'
        : metric.key === 'open-incidents'
          ? 'All submitted incidents not yet closed'
          : 'Organization incident data'
    const tone = metric.key.startsWith('open-') ? 'orange' as const : 'green' as const
    return { ...metric, value: String(value), detail, available: true, tone }
  })
  const actionMetricDefinitions: Array<{ key: string; label: string; type: 'corrective' | 'preventive' | 'investigation'; status: 'open' | 'resolved'; icon: LucideIcon }> = [
    { key: 'open-corrective-actions', label: 'Open Corrective Actions', type: 'corrective', status: 'open', icon: ClipboardList },
    { key: 'closed-corrective-actions', label: 'Closed Corrective Actions', type: 'corrective', status: 'resolved', icon: CheckCircle2 },
    { key: 'open-preventive-actions', label: 'Open Preventive Actions', type: 'preventive', status: 'open', icon: ClipboardList },
    { key: 'closed-preventive-actions', label: 'Closed Preventive Actions', type: 'preventive', status: 'resolved', icon: CheckCircle2 },
    { key: 'open-investigations', label: 'Open Investigations', type: 'investigation', status: 'open', icon: ClipboardList },
    { key: 'closed-investigations', label: 'Closed Investigations', type: 'investigation', status: 'resolved', icon: CheckCircle2 },
  ]
  const actionMetricResults = await Promise.all(actionMetricDefinitions.map(async (definition) => {
    let query = client.from('actions')
      .select('id', { count: 'exact', head: true })
      .eq('organization_id', organizationId)
      .eq('type', definition.type)
      .eq('status', definition.status)
    if (selectedSiteId) query = query.eq('site_id', selectedSiteId)
    const { count, error: actionError } = await query
    return { definition, count, error: actionError }
  }))
  if (actionMetricResults.some((result) => result.error)) throw new Error('Unable to load dashboard action metrics.')
  const actionMetrics: DashboardMetric[] = actionMetricResults.map(({ definition, count }) => ({
    key: definition.key,
    label: definition.label,
    value: String(count || 0),
    detail: 'All actions in your authorized scope',
    icon: definition.icon,
    href: '#assigned-actions',
    available: true,
    tone: definition.status === 'open' ? 'orange' : 'green',
  }))
  const siteNames = new Map((organizationSites || []).map((site) => [site.id, site.name]))
  const recentIncidents = incidentRows.slice(0, 5).map((incident) => ({
    id: incident.id,
    referenceNumber: incident.reference_number,
    title: incident.title,
    reportType: incident.report_type,
    status: incident.status,
    occurredAt: incident.occurred_at,
    location: incident.location,
    severity: incident.severity,
  })) as DashboardIncident[]

  const configuredIncidentTypes = configuredActiveNames(settings?.incident_categories).map(normalizeIncidentCategoryName)
  const configuredDepartments = configuredActiveNames(settings?.departments)
  const configuredSites = configuredActiveNames(settings?.operational_sites)
  const configuredSeverities = configuredActiveNames(settings?.severity_levels)
  // Group timestamps by the browser's local calendar month; rows without a valid occurrence time are skipped.
  const trendBuckets = new Map<string, { label: string; incidents: number; nearMisses: number }>()
  incidentRows.forEach((incident) => {
    const trendDate = filters.dateBasis === 'reported' ? incident.reported_at : incident.occurred_at
    if (!trendDate) return
    const date = new Date(trendDate)
    if (Number.isNaN(date.getTime())) return
    const key = `${date.getFullYear()}-${date.getMonth()}`
    const bucket = trendBuckets.get(key) || { label: monthLabel(date), incidents: 0, nearMisses: 0 }
    if (normalizeIncidentReportType(incident.report_type) === 'near_miss') bucket.nearMisses += 1
    else bucket.incidents += 1
    trendBuckets.set(key, bucket)
  })
  const incidentTrend = [...trendBuckets.entries()].sort(([first], [second]) => first.localeCompare(second)).map(([, value]) => value)
  const incidentSeverity = configuredDistribution(configuredSeverities, incidentRows.map((incident) => {
    const label = effectiveIncidentSeverityLabel(incident.severity, incident.potential_severity)
    return label === 'Not set' ? null : label
  }))
  const incidentTypes = configuredDistribution(configuredIncidentTypes, incidentRows.map((incident) => incident.incident_category))
  const departmentComparison = configuredDistribution(configuredDepartments, incidentRows.map((incident) => incident.department))
  const siteComparison = configuredDistribution(configuredSites, incidentRows.map((incident) => incident.site_id ? siteNames.get(incident.site_id) : null))

  const filteredData = (data || []).filter((item) => {
    const metadata = (item.metadata || {}) as Record<string, unknown>
    if (metadata.entity_type === 'action') return metadata.recipient_id === currentUserId
    const matches = (filter: string, key: string) => filter === 'all' || (key === 'incidentType' ? normalizeIncidentCategoryName(metadataText(metadata, key)) === normalizeIncidentCategoryName(filter) : metadataText(metadata, key) === filter)
    return matches(filters.site, 'site')
      && matches(filters.department, 'department')
      && matches(filters.severity, 'severity')
      && matches(filters.incidentType, 'incidentType')
      && matches(filters.shift, 'shift')
  })
  const userIds = [...new Set(filteredData.map((item) => item.user_id).filter((id): id is string => Boolean(id)))]
  const { data: profiles } = userIds.length
    ? await client.from('profiles').select('id, full_name').in('id', userIds)
    : { data: [] as { id: string; full_name: string }[] }
  const userNames = new Map((profiles || []).map((profile) => [profile.id, profile.full_name]))
  const activities = filteredData.map((item) => ({
    id: item.id,
    createdAt: item.created_at,
    activity: item.activity,
    userId: item.user_id,
    userName: item.user_id ? userNames.get(item.user_id) || 'Organization user' : 'System',
    location: item.location || metadataText((item.metadata || {}) as Record<string, unknown>, 'site') || 'Organization-wide',
    metadata: (item.metadata || {}) as Record<string, unknown>,
  })) as DashboardActivity[]

  return {
    activities,
    recentIncidents,
    metrics,
    actionMetrics,
    incidentTrend,
    incidentSeverity,
    incidentTypes,
    departmentComparison,
    siteComparison,
    correctiveActions: [],
    inspections: null,
    sites: [],
    configuredIncidentTypes,
    configuredDepartments,
    configuredSites,
    hasOperationalData: incidentRows.length > 0,
  }
}
