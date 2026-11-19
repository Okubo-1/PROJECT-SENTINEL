import { z } from 'zod'
import {
  safetySnapshotSchema, safetyMethodologyVersion, isExcludedSyntheticSafetyIncident,
  type SafetyDataset, type SafetyFilters, type SafetyIncident, type SafetyScope, type SafetySnapshot,
} from './safetyIntelligenceContracts.ts'
import {
  calculateIncidentStatusCounts, effectiveIncidentSeverity, isActionDueNotPassed, isClosedIncidentStatus, isDraftIncidentStatus, isOpenIncidentStatus,
  isUnfinishedCorrectiveActionStatus, normalizeIncidentReportType, normalizeIncidentSeverity,
} from './incidentReportFilters.ts'

const day = 86_400_000
const severityRanks = { low: 1, medium: 2, high: 3, critical: 4 } as const

export function effectiveSafetySeverity(actual: string | null, potential: string | null): number | null {
  const severity = effectiveIncidentSeverity(actual, potential)
  return severity ? severityRanks[severity] : null
}

const validTimestamp = z.iso.datetime({ offset: true })
function timestamp(value: string | null | undefined) {
  if (!value || !validTimestamp.safeParse(value).success) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
function between(value: string | null, start: number, end: number) {
  const time = timestamp(value)
  return time !== null && time >= start && time < end
}
function isOpen(incident: SafetyIncident) { return isOpenIncidentStatus(incident.status) }
function severity(incident: SafetyIncident) { return effectiveSafetySeverity(incident.severity, incident.potential_severity) }
function severityLabel(incident: SafetyIncident) {
  const rank = severity(incident)
  return rank === null ? null : (['Low', 'Medium', 'High', 'Critical'][rank - 1] ?? null)
}
function isHigh(incident: SafetyIncident) { return (severity(incident) ?? 0) >= 3 }
function average(values: number[]) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null }
const iso = (time: number) => new Date(time).toISOString()

export function calculateSafetySnapshot(
  dataset: SafetyDataset, scope: SafetyScope, filters: SafetyFilters, asOf: Date, generatedAt = asOf,
): SafetySnapshot {
  if (!Number.isFinite(asOf.getTime()) || !Number.isFinite(generatedAt.getTime())) throw new Error('Invalid snapshot timestamp.')
  if (scope.siteId !== filters.siteId) throw new Error('Snapshot site filter mismatch.')
  const end = asOf.getTime()
  const allTime = filters.days === 'all'
  // The reporting window can be based on occurrence or reporting date. Every
  // metric below reads through this single accessor so KPIs, lists and trends agree.
  const dateBasis = filters.dateBasis ?? 'reported'
  const basisValue = (row: SafetyIncident) => dateBasis === 'occurred' ? row.occurred_at : row.reported_at
  const historyDates = allTime ? [
    ...dataset.rows.incidents.filter((row) => row.status !== 'draft' && !isExcludedSyntheticSafetyIncident(row)
      && (!scope.siteId || row.site_id === scope.siteId)).map((row) => timestamp(basisValue(row))),
    ...dataset.rows.closures.map((row) => timestamp(row.closed_at)),
  ].filter((time): time is number => time !== null && time < end) : []
  const start = filters.days === 'all' ? Math.min(end, ...historyDates) : end - filters.days * day
  const previousStart = filters.days === 'all' ? start : start - filters.days * day
  const indicatorStart = allTime ? start : end - 90 * day
  const recentStart = allTime ? start : end - 14 * day
  const currentMonth = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth(), 1)
  const previousMonth = Date.UTC(asOf.getUTCFullYear(), asOf.getUTCMonth() - 1, 1)
  const previousMonthEnd = Math.min(previousMonth + end - currentMonth, currentMonth)
  const windows = {
    reporting: { start: iso(start), end: iso(end) },
    previousResolution: { start: iso(previousStart), end: iso(start) },
    nearMissCurrent: { start: iso(allTime ? start : currentMonth), end: iso(end) },
    nearMissPrevious: { start: iso(allTime ? start : previousMonth), end: iso(allTime ? start : previousMonthEnd) },
    indicator: { start: iso(indicatorStart), end: iso(end) },
    recent: { start: iso(recentStart), end: iso(end) },
  }
  const { rows, coverage } = dataset
  // Pure calculations still verify scope, so future callers cannot accidentally mix tenant datasets.
  for (const collection of Object.values(rows)) {
    if (collection.some((row) => row.organization_id !== scope.organizationId)) throw new Error('Snapshot scope mismatch.')
  }
  if (dataset.planningIncidents?.some((row) => row.organization_id !== scope.organizationId)
    || dataset.planningActions?.some((row) => row.organization_id !== scope.organizationId)) throw new Error('Snapshot scope mismatch.')
  if (dataset.incidentList?.some((row) => row.organization_id !== scope.organizationId)) throw new Error('Snapshot scope mismatch.')
  if (dataset.companySettings && dataset.companySettings.organization_id !== scope.organizationId) throw new Error('Snapshot settings scope mismatch.')
  const incidents = rows.incidents.filter((row) => row.status !== 'draft' && !isExcludedSyntheticSafetyIncident(row)
    && (!scope.siteId || row.site_id === scope.siteId))
  const planningIncidents = (dataset.planningIncidents ?? rows.incidents).filter((row) =>
    !isDraftIncidentStatus(row.status) && !isExcludedSyntheticSafetyIncident(row) && (!scope.siteId || row.site_id === scope.siteId))
  const planningActions = dataset.planningActions ?? rows.actions
  const observed = incidents.filter((row) => {
    const value = timestamp(basisValue(row))
    return value === null || value < end
  })
  const byId = new Map(observed.map((row) => [row.id, row]))
  const actions = rows.actions.filter((row) => row.incident_id && byId.has(row.incident_id))
  const closureDates = new Map(rows.closures.map((closure) => [closure.incident_id, timestamp(closure.closed_at)]))
  const sourceComplete = (...sources: SafetyDataset['coverage'][number]['source'][]) =>
    sources.every((source) => coverage.some((entry) => entry.source === source && entry.complete))
  const missingReportedAt = incidents.filter((row) => timestamp(basisValue(row)) === null).length
  const futureReportedAt = incidents.filter((row) => (timestamp(basisValue(row)) ?? -Infinity) >= end).length
  const selected = observed.filter((row) => between(basisValue(row), start, end))
  const unclassified = selected.filter((row) => severity(row) === null).length
  const uncategorized = selected.filter((row) => !row.incident_category?.trim()).length
  const highRisk = selected.filter(isHigh)
  const openHighRisk = highRisk.filter(isOpen)
  const windowIncidentCounts = calculateIncidentStatusCounts(selected)
  const reportReasons = [
    ...(!sourceComplete('incidents') ? ['Incident retrieval is incomplete.'] : []),
    ...(missingReportedAt ? ['Some authorized reports have missing or invalid reporting timestamps.'] : []),
    ...(futureReportedAt ? ['Reports at or after the snapshot cutoff are excluded.'] : []),
  ]
  const uncertainReporting = !sourceComplete('incidents') || missingReportedAt > 0
  const incidentListRows = [...new Map((dataset.incidentList ?? dataset.planningIncidents ?? rows.incidents)
    .filter((row) => !isDraftIncidentStatus(row.status) && (!scope.siteId || row.site_id === scope.siteId)
      && (allTime || between(basisValue(row), start, end)))
    .map((row) => [row.id, row])).values()]
  const incidentListCounts = calculateIncidentStatusCounts(incidentListRows)
  const nearMissCount = incidentListRows.filter((row) => normalizeIncidentReportType(row.report_type) === 'near_miss').length
  // Outstanding means unfinished under the existing workflow, including work awaiting verification.
  // It is a current backlog, not actions attached only to newly reported incidents.
  const outstandingActions = [...new Map(actions.map((row) => [row.id, row])).values()]
    .filter((row) => isUnfinishedCorrectiveActionStatus(row.status))
  const actionReasons = [
    ...(!sourceComplete('incidents', 'actions') ? ['Incident or action retrieval is incomplete; known counts only.'] : []),
    ...(coverage.some((entry) => entry.source === 'actions' && entry.access === 'caller_visible')
      ? ['Caller-visible actions only; this is not a complete organization total.'] : []),
  ]
  const riskReasons = [
    ...reportReasons,
    ...(unclassified ? ['Some eligible severities require explicit mapping.'] : []),
    ...(selected.length < 10 ? ['At least 10 eligible classified reports are required.'] : []),
  ]
  const riskState = uncertainReporting ? 'incomplete' : unclassified || selected.length < 10 ? 'insufficient' : 'available'
  // Integer weights keep exact 30/60 thresholds stable without rounding the approved index.
  // It describes reported events, not accident probability or exposure.
  const score = riskState === 'available'
    ? (70 * highRisk.length + 30 * openHighRisk.length) / selected.length : null
  const riskBand = score === null ? null : score < 30 ? 'Low' : score < 60 ? 'Medium' : 'High'

  const nearMissCurrent = incidents.filter((row) => normalizeIncidentReportType(row.report_type) === 'near_miss' && between(basisValue(row), allTime ? start : currentMonth, end)).length
  const nearMissPrevious = allTime ? 0 : incidents.filter((row) => normalizeIncidentReportType(row.report_type) === 'near_miss' && between(basisValue(row), previousMonth, previousMonthEnd)).length
  const percentageChange = !allTime && !uncertainReporting && nearMissPrevious
    ? 100 * (nearMissCurrent - nearMissPrevious) / nearMissPrevious : null
  const direction = allTime ? nearMissCurrent ? 'unchanged' : 'no_reports' : nearMissPrevious === 0
    ? nearMissCurrent ? 'new_reporting' : 'no_reports'
    : nearMissCurrent > nearMissPrevious ? 'up' : nearMissCurrent < nearMissPrevious ? 'down' : 'unchanged'
  const categories = new Map<string, number>()
  for (const row of selected) {
    const category = row.incident_category?.trim()
    if (category) categories.set(category, (categories.get(category) ?? 0) + 1)
  }
  const category = [...categories].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]

  const validClosureIds = new Set<string>()
  const durations: number[] = []
  const previousDurations: number[] = []
  let invalidDurations = 0
  // Closed is status-based. Use the structured closure date when available and
  // fall back to updated_at (approximate) for legacy closed reports.
  for (const incident of observed.filter((row) => row.status === 'closed')) {
    const structured = closureDates.get(incident.id)
    if (structured != null) validClosureIds.add(incident.id)
    const closedAt = structured ?? timestamp(incident.updated_at)
    const reportedAt = timestamp(incident.reported_at)
    if (closedAt === null || reportedAt === null || closedAt < reportedAt) { invalidDurations++; continue }
    if (closedAt >= start && closedAt < end) durations.push((closedAt - reportedAt) / day)
    if (closedAt >= previousStart && closedAt < start) previousDurations.push((closedAt - reportedAt) / day)
  }
  const resolutionComplete = sourceComplete('incidents', 'closures')
  const averageDays = resolutionComplete ? average(durations) : null
  const previousAverageDays = resolutionComplete ? average(previousDurations) : null
  const legacyClosedWithoutEvidence = observed.filter((row) => row.status === 'closed' && !validClosureIds.has(row.id)).length
  const resolutionReasons = [
    ...(!resolutionComplete ? ['Incident or closure retrieval is incomplete.'] : []),
    ...(legacyClosedWithoutEvidence ? [`${legacyClosedWithoutEvidence} closed reports use their last-updated time because structured closure evidence is missing.`] : []),
    ...(invalidDurations ? ['Missing, invalid or negative closure durations are excluded.'] : []),
    ...(!durations.length ? ['No valid closure durations in this window.'] : []),
  ]

  const location = (level: 'facility' | 'site', id: string, name: string) => {
    const atLocation = observed.filter((row) => row.site_id === id)
    const atLocationIncidents = atLocation.filter((row) => normalizeIncidentReportType(row.report_type) !== 'near_miss')
    const windowReports = atLocation.filter((row) => between(basisValue(row), start, end))
    const windowIncidents = atLocationIncidents.filter((row) => between(basisValue(row), start, end))
    const incidentIndicatorReports = atLocationIncidents.filter((row) => between(basisValue(row), indicatorStart, end))
    const locationIds = new Set(atLocationIncidents.map((row) => row.id))
    const locationActions = actions.filter((row) => row.incident_id !== null && locationIds.has(row.incident_id))
    let invalidActionDueDates = 0
    const overdue = locationActions.filter((row) => {
      if (!isUnfinishedCorrectiveActionStatus(row.status)) return false
      // PostgreSQL due_date is date-only: work becomes overdue after that UTC day finishes.
      const due = row.due_date && /^\d{4}-\d{2}-\d{2}$/.test(row.due_date)
        ? timestamp(`${row.due_date}T00:00:00.000Z`) : null
      if (due === null || iso(due).slice(0, 10) !== row.due_date) { invalidActionDueDates++; return false }
      return due + day <= end
    })
    return {
      level, id, name, count: windowIncidents.length,
      highRiskCount: windowIncidents.filter(isHigh).length,
      openHighCount: windowReports.filter((row) => isOpen(row) && severity(row) === 3).length,
      openCriticalCount: windowReports.filter((row) => isOpen(row) && severity(row) === 4).length,
      overdueActions: overdue.length,
      unclassified: incidentIndicatorReports.filter((row) => severity(row) === null).length,
      recentHighRiskCount: atLocationIncidents.filter((row) => isHigh(row) && between(basisValue(row), recentStart, end)).length,
      indicatorSampleSize: incidentIndicatorReports.filter((row) => severity(row) !== null).length,
      backlogOpenCritical: atLocationIncidents.filter((row) => isOpen(row) && severity(row) === 4).length,
      backlogOpenHigh: atLocationIncidents.filter((row) => isOpen(row) && severity(row) === 3).length,
      backlogUnclassified: atLocationIncidents.filter((row) => isOpen(row) && severity(row) === null).length,
      missingReportedAt: atLocationIncidents.filter((row) => timestamp(basisValue(row)) === null).length,
      overdueCriticalActions: overdue.filter((row) => {
        const parent = row.incident_id ? byId.get(row.incident_id) : undefined
        return parent && severity(parent) === 4
      }).length,
      invalidActionDueDates,
      evidenceIncidentIds: windowIncidents.filter(isHigh).map((row) => row.id).sort().slice(0, 20),
    }
  }
  const compareLocations = (a: SafetySnapshot['locations'][number], b: SafetySnapshot['locations'][number]) =>
    b.highRiskCount - a.highRiskCount || b.openCriticalCount - a.openCriticalCount
    || b.openHighCount - a.openHighCount || b.count - a.count
    || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
  const sites = rows.sites.filter((row) => !scope.siteId || row.id === scope.siteId)
    .map((row) => location('site', row.id, row.name))
  const locations = sites.sort(compareLocations)
  const planningRows = planningIncidents.filter((row) => row.site_id && (!scope.siteId || row.site_id === scope.siteId))
  const planningSites = (dataset.planningSites ?? rows.sites).filter((row) => !scope.siteId || row.id === scope.siteId).map((site) => {
    const reports = planningRows.filter((row) => row.site_id === site.id)
    const reportIds = new Set(reports.map((row) => row.id))
    const openCriticalIds = new Set(reports.filter((row) => isOpenIncidentStatus(row.status, true)
      && normalizeIncidentSeverity(row.severity) === 'critical').map((row) => row.id))
    const unfinished = planningActions.filter((row) => reportIds.has(row.incident_id ?? '')
      && isUnfinishedCorrectiveActionStatus(row.status))
    const missingDue = (dueDate: string | null) => {
      if (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return true
      const parsed = new Date(`${dueDate}T00:00:00.000Z`)
      return !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== dueDate
    }
    return {
      id: site.id, name: site.name,
      openCritical: reports.filter((row) => isOpenIncidentStatus(row.status, true)
        && normalizeIncidentSeverity(row.severity) === 'critical').length,
      openHigh: reports.filter((row) => isOpenIncidentStatus(row.status, true)
        && normalizeIncidentSeverity(row.severity) === 'high').length,
      nonOverdueUnfinishedActions: unfinished.filter((row) => isActionDueNotPassed(row.due_date, asOf)).length,
      criticalLinkedUnfinishedActions: unfinished.filter((row) => openCriticalIds.has(row.incident_id ?? '')).length,
      unfinishedActionsMissingDueDate: unfinished.filter((row) => missingDue(row.due_date)).length,
    }
  })

  const evidence: SafetySnapshot['evidence'] = []
  let characters = 0
  let evidenceTruncated = false
  const addEvidence = (source: SafetySnapshot['evidence'][number]['source'], id: string, incidentId: string | undefined, label: string, excerpt: string) => {
    const item = { source, id, ...(incidentId ? { incidentId } : {}), label: label.slice(0, 200), excerpt: excerpt.slice(0, 1000) }
    const size = item.label.length + item.excerpt.length
    if (evidence.length >= 80 || characters + size > 24_000) { evidenceTruncated = true; return }
    evidence.push(item)
    characters += size
  }
  const relevant = new Set(observed.filter((row) => isOpen(row) || between(basisValue(row), indicatorStart, end)
    || rows.closures.some((closure) => closure.incident_id === row.id && between(closure.closed_at, previousStart, end)))
    .map((row) => row.id))
  for (const row of observed.filter((row) => relevant.has(row.id)).sort((a, b) => a.id.localeCompare(b.id))) {
    addEvidence('incidents', row.id, row.id, row.reference_number, row.title)
  }
  for (const row of actions.filter((row) => row.incident_id && relevant.has(row.incident_id))) addEvidence('actions', row.id, row.incident_id ?? undefined, row.type === 'preventive' ? 'Preventive action' : row.type === 'investigation' ? 'Investigation action' : 'Corrective action', row.title)
  const investigations = rows.investigations.filter((row) => relevant.has(row.incident_id))
  const investigationMap = new Map(investigations.map((row) => [row.id, row]))
  for (const row of investigations) addEvidence('investigations', row.id, row.incident_id, `Investigation (${row.status})`, row.findings_summary ?? '')
  for (const row of rows.causes) {
    const parent = investigationMap.get(row.investigation_id)
    if (parent) addEvidence('causes', row.id, parent.incident_id, `Recorded cause (${parent.status})`, row.root_cause_statement)
  }
  for (const row of rows.findings) {
    const parent = investigationMap.get(row.investigation_id)
    if (parent) addEvidence('findings', row.id, parent.incident_id, 'Recorded finding', row.description)
  }
  for (const row of rows.closures.filter((row) => relevant.has(row.incident_id))) {
    addEvidence('closures', row.incident_id, row.incident_id, 'Human-authored closure evidence', `${row.root_cause}\n${row.corrective_action}`)
  }
  const companySettings = dataset.companySettings
  const missingClosureDates = incidents.filter((row) => {
    if (row.status !== 'closed') return false
    const closedAt = closureDates.get(row.id) ?? timestamp(row.updated_at)
    const reportedAt = timestamp(row.reported_at)
    return closedAt == null || (reportedAt !== null && closedAt < reportedAt)
  }).length
  const trendReasons = [
    ...(!sourceComplete('incidents', 'closures', 'sites') ? ['Incident, closure or site retrieval is incomplete.'] : []),
    ...(!companySettings ? ['Company settings are unavailable.'] : []),
  ]
  const missingTrendReportingDates = incidents.filter((row) => timestamp(basisValue(row)) === null).length
  const trendWarnings = [
    ...coverage.filter((source) => source.source === 'incidents').flatMap((source) =>
      source.reasons.filter((reason) => reason.includes('confirmed synthetic incident records'))),
    ...(missingClosureDates ? [`${missingClosureDates} closed records have no valid closure or update date and are excluded from Closed.`] : []),
    ...(missingTrendReportingDates ? [`${missingTrendReportingDates} records have missing or invalid dates for the selected window and are excluded from their reporting-date series.`] : []),
  ]
  const trendPeriod = filters.trendDays ?? filters.days
  const trendStart = trendPeriod === 'all' ? -Infinity : end - trendPeriod * day
  const trendRecords = incidents.flatMap((row) => {
    const basisTime = timestamp(basisValue(row))
    // Closed is status-based; use the structured closure date, falling back to
    // the last update for legacy closed reports.
    const closureTime = row.status === 'closed' ? (closureDates.get(row.id) ?? timestamp(row.updated_at)) : null
    const reportedAt = basisTime !== null && basisTime >= trendStart && basisTime < end ? iso(basisTime) : null
    const closedAt = closureTime != null && closureTime >= trendStart && closureTime < end
      && (basisTime === null || closureTime >= basisTime) ? iso(closureTime) : null
    return reportedAt || closedAt ? [{
      id: row.id, reportType: normalizeIncidentReportType(row.report_type), reportedAt, closedAt,
      siteId: row.site_id, department: row.department ?? null, severity: severityLabel(row), category: row.incident_category,
    }] : []
  })
  return safetySnapshotSchema.parse({
    methodologyVersion: safetyMethodologyVersion, origin: 'deterministic', authoritative: false,
    generatedAt: generatedAt.toISOString(), asOf: asOf.toISOString(), timezone: 'UTC', scope, filters, windows, coverage,
    incidentTrend: {
      complete: trendReasons.length === 0,
      reasons: trendReasons,
      warnings: trendWarnings,
      records: trendRecords,
      settings: {
        sites: companySettings ? rows.sites.filter((site) => companySettings.operational_sites.some((name) =>
          name.toLowerCase() === site.name.trim().toLowerCase())).map((site) => ({ id: site.id, name: site.name })) : [],
        departments: companySettings?.departments ?? [],
        severities: companySettings?.severity_levels ?? [],
        categories: companySettings?.incident_categories ?? [],
      },
    },
    dataQuality: {
      missingReportedAt, futureReportedAt, unclassified, uncategorized,
      // Retain the response field for compatibility; facility means the incident form's site.
      unassignedFacility: selected.filter((row) => !row.site_id || !rows.sites.some((site) => site.id === row.site_id)).length,
    },
    metrics: {
      incidentCounts: {
        state: uncertainReporting ? 'incomplete' : 'available', reasons: reportReasons,
        total: incidentListCounts.total,
        open: incidentListCounts.open,
        closed: incidentListCounts.closed,
        ...(dataset.draftTotal === undefined ? {} : { drafts: dataset.draftTotal, draftScope: 'organization_open' as const }),
        nearMiss: nearMissCount,
      },
      outstandingActions: {
        state: sourceComplete('incidents', 'actions') ? 'available' : 'incomplete',
        reasons: actionReasons, count: outstandingActions.length,
      },
      risk: { state: riskState, reasons: riskReasons, score, band: riskBand, sampleSize: selected.length - unclassified, changePoints: null, comparisonReason: 'Historical open-state observations are unavailable.' },
      highRisk: { state: uncertainReporting || unclassified ? 'incomplete' : 'available', reasons: [...reportReasons, ...(unclassified ? ['Unknown severity reports are excluded from known high-risk counts.'] : [])], count: windowIncidentCounts.highRisk, openCount: windowIncidentCounts.openHighRisk, closedCount: windowIncidentCounts.closedHighRisk },
      nearMiss: { state: uncertainReporting ? 'incomplete' : 'available', reasons: reportReasons, currentCount: nearMissCurrent, previousCount: nearMissPrevious, percentageChange, direction },
      category: { state: uncertainReporting ? 'incomplete' : category ? 'available' : 'unavailable', reasons: [...reportReasons, ...(!category ? ['No categorized reports in this window.'] : [])], label: category?.[0] ?? null, count: category?.[1] ?? 0, share: category && !uncertainReporting ? 100 * category[1] / selected.length : null, denominator: selected.length },
      resolution: { state: !resolutionComplete ? 'incomplete' : durations.length ? 'available' : 'insufficient', reasons: resolutionReasons, averageDays, previousAverageDays, changeDays: averageDays !== null && previousAverageDays !== null ? averageDays - previousAverageDays : null, sampleSize: durations.length, previousSampleSize: previousDurations.length, legacyClosedWithoutEvidence, invalidDurations },
    },
    locations, planningSites, evidence, evidenceTruncated,
    limitations: [
      'Read-only live observations, not a transactionally frozen historical snapshot.',
      'Only caller-authorized records are represented; invisible record totals are not disclosed.',
      'No enforced site assignments; site filters only narrow existing record visibility.',
      'Risk index is deterministic and uncalibrated, not accident probability or machine learning.',
      'Historical risk-score changes are unavailable.',
      'Inspections, operational audits, procedures, regulatory libraries and trained prediction are unavailable.',
      'Location drivers are inputs for later advisory guidance and planning indicators, not predictions.',
      ...(coverage.some((entry) => !entry.complete) ? ['Some sources exceeded retrieval limits; do not interpret partial rankings/counts as complete.'] : []),
      ...(coverage.some((entry) => entry.source === 'actions' && entry.access === 'caller_visible') ? ['Action coverage is caller-visible only; absence does not prove there are no other organization actions.'] : []),
      ...(evidenceTruncated ? ['Evidence excerpts are bounded; they are not the complete aggregate dataset.'] : []),
    ],
  })
}
