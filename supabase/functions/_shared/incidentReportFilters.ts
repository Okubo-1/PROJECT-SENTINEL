const severityAliases: Record<string, 'low' | 'medium' | 'high' | 'critical'> = {
  low: 'low', lowrisk: 'low', lowseverity: 'low',
  medium: 'medium', mediumrisk: 'medium', mediumseverity: 'medium',
  high: 'high', highrisk: 'high', highseverity: 'high',
  critical: 'critical', criticalrisk: 'critical', criticalseverity: 'critical',
}
const incidentStatuses = ['draft', 'submitted', 'under_review', 'investigation', 'corrective_action', 'pending_verification', 'open', 'closed'] as const
const incidentStatusAliases: Record<string, (typeof incidentStatuses)[number]> = {
  draft: 'draft', draftreport: 'draft', savedraft: 'draft', submitted: 'submitted', underreview: 'under_review', investigation: 'investigation',
  correctiveaction: 'corrective_action', pendingverification: 'pending_verification', open: 'open', closed: 'closed', resolved: 'closed',
}

function normalizeLabel(value: unknown) {
  return typeof value === 'string' ? value.trim().toLowerCase().replace(/[^a-z0-9]/g, '') : ''
}

export function normalizeIncidentSeverity(value: unknown) {
  const normalized = normalizeLabel(value)
  return Object.prototype.hasOwnProperty.call(severityAliases, normalized)
    ? severityAliases[normalized]
    : null
}

const severityRank = { low: 1, medium: 2, high: 3, critical: 4 } as const

// Effective severity is the worse of the actual and potential values, matching
// Executive Analytics and the dashboard risk calculations. Near misses carry
// potential_severity, incidents carry severity; either can satisfy a filter.
export function effectiveIncidentSeverity(actual: unknown, potential: unknown) {
  const supplied = [actual, potential].filter((value) => typeof value === 'string' && value.trim())
  const candidates = supplied.map(normalizeIncidentSeverity)
  if (!candidates.length || candidates.some((value) => value === null)) return null
  const ranked = candidates.filter((value): value is keyof typeof severityRank => value !== null)
  if (!ranked.length) return null
  return ranked.sort((a, b) => severityRank[b] - severityRank[a])[0]
}

export type IncidentStatusCountRow = {
  status: unknown
  severity: unknown
  potential_severity: unknown
}

export function calculateIncidentStatusCounts(rows: readonly IncidentStatusCountRow[]) {
  const incidents = rows.filter((row) => !isDraftIncidentStatus(row.status))
  const closed = incidents.filter((row) => isClosedIncidentStatus(row.status))
  const open = incidents.filter((row) => isOpenIncidentStatus(row.status))
  const isHighRisk = (row: IncidentStatusCountRow) => {
    const severity = effectiveIncidentSeverity(row.severity, row.potential_severity)
    return severity === 'high' || severity === 'critical'
  }
  const highRisk = incidents.filter(isHighRisk)
  return {
    total: incidents.length,
    open: open.length,
    closed: closed.length,
    highRisk: highRisk.length,
    openHighRisk: highRisk.filter((row) => isOpenIncidentStatus(row.status)).length,
    closedHighRisk: highRisk.filter((row) => isClosedIncidentStatus(row.status)).length,
  }
}

export function effectiveIncidentSeverityLabel(actual: unknown, potential: unknown) {
  const severity = effectiveIncidentSeverity(actual, potential)
  return severity ? severity[0].toUpperCase() + severity.slice(1) : 'Not set'
}

export function matchesIncidentSeverity(value: unknown, selected: unknown) {
  const severity = normalizeIncidentSeverity(value)
  return severity !== null && severity === normalizeIncidentSeverity(selected)
}

export function normalizeIncidentStatus(status: unknown) {
  const normalized = normalizeLabel(status)
  return incidentStatusAliases[normalized] ?? (typeof status === 'string' ? status.trim() : '')
}

export function normalizeIncidentReportType(reportType: unknown) {
  return normalizeLabel(reportType) === 'nearmiss' ? 'near_miss' : normalizeLabel(reportType)
}

export function incidentSeverityFilterPatterns(selected: unknown) {
  const severity = normalizeIncidentSeverity(selected)
  if (severity) return [severity, `${severity}%risk`, `${severity}%severity`]
  const exact = typeof selected === 'string' ? selected.trim().toLowerCase() : ''
  return exact ? [exact] : []
}

export function isDraftIncidentStatus(status: unknown) {
  return normalizeIncidentStatus(status) === 'draft'
}

export function isClosedIncidentStatus(status: unknown) {
  return normalizeIncidentStatus(status) === 'closed'
}

export function isOpenIncidentStatus(status: unknown, includeDrafts = false) {
  return !isClosedIncidentStatus(status) && (includeDrafts || !isDraftIncidentStatus(status))
}

export function openIncidentStatuses(includeDrafts = false) {
  return incidentStatuses.filter((status) => isOpenIncidentStatus(status, includeDrafts))
}

export function isUnfinishedCorrectiveActionStatus(status: unknown) {
  return !['verified', 'closed', 'resolved', 'complete', 'completed', 'rejected'].includes(normalizeLabel(status))
}

export function isActionDueNotPassed(dueDate: unknown, asOf: Date) {
  if (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return false
  const parsed = new Date(`${dueDate}T00:00:00.000Z`)
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dueDate) return false
  return dueDate >= asOf.toISOString().slice(0, 10)
}
