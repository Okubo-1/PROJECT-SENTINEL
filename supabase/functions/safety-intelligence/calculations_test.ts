import { calculateSafetySnapshot, effectiveSafetySeverity } from '../_shared/safetyIntelligenceCalculations.ts'
import { safetyFiltersSchema, safetyIncidentSchema, safetyResponseSchema, safetySnapshotSchema } from '../_shared/safetyIntelligenceContracts.ts'
import {
  calculateIncidentStatusCounts, incidentSeverityFilterPatterns, isActionDueNotPassed, isOpenIncidentStatus,
  isUnfinishedCorrectiveActionStatus, normalizeIncidentReportType, normalizeIncidentSeverity, normalizeIncidentStatus,
} from '../_shared/incidentReportFilters.ts'
import { asOf, assert, dataset, equal, id, incident, org, scope, site } from './fixtures_test.ts'

const snapshot = (data = dataset(), date = asOf) => calculateSafetySnapshot(data, scope, { days: 90 }, date)

Deno.test('older deployed snapshots without Drafts remain valid responses', () => {
  const legacy = snapshot()
  delete legacy.metrics.incidentCounts?.drafts
  assert(safetyResponseSchema.safeParse({ ok: true, requestId: id(99), snapshot: legacy }).success,
    'Legacy incidentCounts without drafts should remain response-compatible')
})

Deno.test('Drafts KPI uses the organization total and excludes draft details from other counts', () => {
  const submitted = incident(0)
  const draft = incident(1, { status: 'draft' })
  const data = dataset([submitted])
  data.planningIncidents = [submitted, draft]
  data.draftTotal = 7

  const result = snapshot(data)
  equal(result.metrics.incidentCounts?.total, 1)
  equal(result.metrics.incidentCounts?.open, 1)
  equal(result.metrics.incidentCounts?.drafts, 7)
  assert(!JSON.stringify(result).includes(draft.id), 'Draft detail leaked in snapshot')
  equal(result.metrics.category.denominator, 1)
})

Deno.test('incident filters normalize severity and status variants using Incident Management rules', () => {
  equal(['CRITICAL', 'Critical Risk', 'critical-severity'].map(normalizeIncidentSeverity), ['critical', 'critical', 'critical'])
  equal(incidentSeverityFilterPatterns('Critical'), ['critical', 'critical%risk', 'critical%severity'])
  equal(normalizeIncidentStatus('Resolved'), 'closed')
  equal(normalizeIncidentStatus(' Draft Report '), 'draft')
  equal(normalizeIncidentStatus('DRAFT'), 'draft')
  equal(normalizeIncidentReportType('Near Miss'), 'near_miss')
  equal(normalizeIncidentStatus('Pending Verification'), 'pending_verification')
  assert(isOpenIncidentStatus('DRAFT', true), 'Draft should be open when explicitly included')
  assert(!isOpenIncidentStatus('resolved', true), 'Resolved incident counted as open')
  assert(isUnfinishedCorrectiveActionStatus('Pending Verification'), 'Pending verification action treated as complete')
  assert(!isUnfinishedCorrectiveActionStatus('Completed'), 'Completed action treated as unfinished')
  assert(isActionDueNotPassed('2026-10-06', asOf), 'Due today counted overdue')
  assert(!isActionDueNotPassed('2026-10-05', asOf), 'Past-due action counted non-overdue')
})

Deno.test('incident-list KPI counts match Incident Management while synthetic records stay out of operational evidence', () => {
  const data = dataset([
    incident(0, { client_submission_id: 'MOCK-EXAMPLE-INCIDENTS-20260929-0001', digital_signature: 'MOCK:MOCK-EXAMPLE-INCIDENTS-20260929' }),
    incident(1, { report_type: 'near_miss' }),
  ])
  data.rows.actions = [{
    id: id(300), organization_id: org, incident_id: incident(0).id, title: 'Seed action', status: 'open', due_date: null,
  }]
  const result = snapshot(data)
  equal(result.metrics.incidentCounts?.total, 2)
  equal(result.metrics.incidentCounts?.nearMiss, 1)
  equal(result.metrics.outstandingActions?.count, 0)
  equal(result.incidentTrend?.records.map((row) => row.id), [incident(1).id])
})

Deno.test('approved existing evaluation batch restores counts and actions only for its owning organization', () => {
  const approvedOrg = '25ad3a5c-514b-4097-96a6-a712c715d92b'
  const data = dataset([incident(0, {
    organization_id: approvedOrg,
    client_submission_id: 'MOCK-STARNET-INCIDENTS-20260929-0001',
    digital_signature: 'MOCK:MOCK-STARNET-INCIDENTS-20260929',
  })])
  for (const collection of Object.values(data.rows)) for (const row of collection) row.organization_id = approvedOrg
  data.companySettings!.organization_id = approvedOrg
  data.rows.actions.push({
    id: id(300), organization_id: approvedOrg, incident_id: incident(0).id,
    title: 'Existing evaluation action', status: 'open', due_date: null,
  })
  const restored = calculateSafetySnapshot(data, { ...scope, organizationId: approvedOrg }, { days: 90 }, asOf)
  equal(restored.metrics.incidentCounts?.total, 1)
  equal(restored.metrics.outstandingActions?.count, 1)
  for (const collection of Object.values(data.rows)) for (const row of collection) row.organization_id = org
  data.companySettings!.organization_id = org
  equal(snapshot(data).metrics.incidentCounts?.total, 1)
  equal(snapshot(data).metrics.outstandingActions?.count, 0)
})

Deno.test('All Time expands only trend history and preserves every other snapshot calculation', () => {
  const data = dataset([
    incident(0, { reported_at: '2023-10-01T12:00:00.000Z', status: 'closed' }),
    incident(1, { reported_at: '2026-10-02T12:00:00.000Z', report_type: 'near_miss' }),
    incident(2, { status: 'draft' }),
    incident(3, { reported_at: asOf.toISOString() }),
  ])
  data.rows.closures.push({
    incident_id: incident(0).id, organization_id: org, closed_at: '2024-01-01T12:00:00.000Z',
    root_cause: 'Recorded cause', corrective_action: 'Recorded action',
  })

  const before = snapshot(data)
  const allTime = calculateSafetySnapshot(data, scope, { days: 90, trendDays: 'all' }, asOf)
  equal(allTime.incidentTrend?.records.length, 2)
  equal(allTime.incidentTrend?.records[0].closedAt, '2024-01-01T12:00:00.000Z')
  equal(allTime.metrics, before.metrics)
  equal(allTime.locations, before.locations)
  equal(allTime.windows, before.windows)
  equal(allTime.evidence, before.evidence)
  const shorter = calculateSafetySnapshot(data, scope, { days: 90, trendDays: 30 }, asOf)
  equal(shorter.incidentTrend?.records.length, 1)
  equal(shorter.metrics, before.metrics)
})

Deno.test('KPI counts follow Incident Management occurrence-date windows for every report type and status', () => {
    const data = dataset([
      incident(0, { reported_at: '2023-10-01T12:00:00.000Z', status: 'closed', severity: 'High' }),
      incident(1, { reported_at: '2024-02-01T12:00:00.000Z', report_type: 'near_miss' }),
      incident(2, { reported_at: '2026-10-02T12:00:00.000Z' }),
      incident(3, { status: 'draft' }),
      incident(4, { reported_at: asOf.toISOString() }),
    ])
    data.draftTotal = 1
    data.rows.closures.push({ incident_id: incident(0).id, organization_id: org,
      closed_at: '2024-01-01T12:00:00.000Z', root_cause: 'Recorded cause', corrective_action: 'Recorded action' })
    const all = calculateSafetySnapshot(data, scope, { days: 'all' }, asOf)
    equal(all.metrics.incidentCounts?.total, 4)
    equal(all.metrics.incidentCounts?.open, 3)
    equal(all.metrics.incidentCounts?.drafts, 1)
    equal(all.metrics.incidentCounts?.closed, 1)
    equal(all.metrics.incidentCounts?.nearMiss, 1)
    equal(all.metrics.category.denominator, 3)
    equal(all.metrics.nearMiss.currentCount, 1)
    equal(all.metrics.nearMiss.percentageChange, null)
    equal(all.metrics.resolution.sampleSize, 1)
    equal(all.metrics.resolution.previousSampleSize, 0)
    equal(all.incidentTrend?.records.length, 3)
    equal(all.locations.reduce((sum, row) => sum + row.count, 0), 2)
    equal(all.windows.reporting.start, '2023-10-01T12:00:00.000Z')
    for (const days of [30, 90] as const) {
      const bounded = calculateSafetySnapshot(data, scope, { days }, asOf)
      equal(bounded.metrics.incidentCounts?.total, 1)
      equal(bounded.metrics.incidentCounts?.drafts, 1)
      equal(bounded.metrics.incidentCounts?.nearMiss, 0)
      equal(bounded.metrics.resolution.sampleSize, 0)
      equal(bounded.incidentTrend?.records.length, 1)
    }
    const empty = calculateSafetySnapshot(dataset([]), scope, { days: 'all' }, asOf)
    equal(empty.metrics.incidentCounts?.total, 0)
    equal(empty.incidentTrend?.records.length, 0)
})

Deno.test('trend uses independent reporting and actual closure cohorts without altering KPI totals', () => {
  const data = dataset([
    incident(0, { reported_at: '2026-09-06T12:00:00.000Z', department: 'Fixture Department' }),
    incident(1, { report_type: 'near_miss', status: 'closed', severity: null, potential_severity: 'High' }),
    incident(2, { report_type: 'unsafe_act', status: 'closed', reported_at: '2025-01-01T00:00:00.000Z' }),
    incident(3, { status: 'draft' }),
    incident(4, { reported_at: asOf.toISOString() }),
    incident(5, { reported_at: '2026-09-06T11:59:59.999Z' }),
  ])
  data.draftTotal = 1
  data.rows.closures = [1, 2].map((n) => ({
    incident_id: incident(n).id, organization_id: org, closed_at: '2026-10-04T12:00:00.000Z',
    root_cause: 'Fixture cause', corrective_action: 'Fixture action',
  }))
  const result = calculateSafetySnapshot(data, scope, { days: 30 }, asOf)
  const trend = result.incidentTrend!
  equal(trend.complete, true)
  equal(trend.records.map((row) => row.id), [incident(0).id, incident(1).id, incident(2).id])
  equal(trend.records[2].reportedAt, null)
  equal(trend.records[2].closedAt, '2026-10-04T12:00:00.000Z')
  equal(trend.records[1].severity, 'High')
  data.rows.incidents[1].potential_severity = null
  equal(calculateSafetySnapshot(data, scope, { days: 30 }, asOf).incidentTrend?.records[1].severity, null)
  data.rows.incidents[1].potential_severity = 'High'
  equal(result.metrics.incidentCounts?.total, 2)
  equal(result.metrics.incidentCounts?.open, 1)
  equal(result.metrics.incidentCounts?.drafts, 1)
  equal(result.metrics.incidentCounts?.nearMiss, 1)
  equal(trend.settings.categories, ['Equipment'])
  equal(trend.settings.departments, ['Fixture Department'])
  data.rows.closures[1].closed_at = asOf.toISOString()
  equal(calculateSafetySnapshot(data, scope, { days: 30 }, asOf).incidentTrend?.records.length, 2)
})

Deno.test('trend discloses missing settings, incomplete sources, invalid dates and rejects foreign settings', () => {
  const data = dataset([incident(0, { status: 'closed' })])
  equal(snapshot(data).incidentTrend?.complete, true)
  equal(snapshot(data).incidentTrend?.records[0].closedAt, null)
  assert(snapshot(data).incidentTrend?.warnings?.some((warning) => warning.includes('excluded from Closed')), 'Closure exclusion was not disclosed')
  data.rows.incidents[0].status = 'submitted'
  data.rows.incidents[0].reported_at = null
  equal(snapshot(data).incidentTrend?.complete, true)
  equal(snapshot(data).incidentTrend?.records.length, 0)
  assert(snapshot(data).incidentTrend?.warnings?.some((warning) => warning.includes('reporting-date series')), 'Reporting exclusion was not disclosed')
  data.rows.incidents[0].reported_at = '2026-10-02T12:00:00.000Z'
  data.companySettings = null
  assert(!snapshot(data).incidentTrend?.complete, 'Missing settings treated as complete')
  data.companySettings = dataset().companySettings
  data.coverage.find((entry) => entry.source === 'sites')!.complete = false
  assert(!snapshot(data).incidentTrend?.complete, 'Incomplete sites treated as complete')
  data.companySettings = { ...dataset().companySettings!, organization_id: id(999) }
  let rejected = false
  try { snapshot(data) } catch { rejected = true }
  assert(rejected, 'Foreign company settings accepted')
})

Deno.test('missing closure dates do not block open or closed submitted reports and a later valid closure enters Closed', () => {
  const data = dataset([
    incident(0, { status: 'closed' }),
    incident(1, { report_type: 'near_miss', status: 'closed' }),
    incident(2, { status: 'investigation' }),
    incident(3, { status: 'draft' }),
  ])
  let trend = snapshot(data).incidentTrend!
  equal(trend.complete, true)
  equal(trend.records.length, 3)
  equal(trend.records.filter((row) => row.reportedAt && row.reportType === 'incident').length, 2)
  equal(trend.records.filter((row) => row.reportedAt && row.reportType === 'near_miss').length, 1)
  equal(trend.records.filter((row) => row.closedAt).length, 0)
  data.rows.incidents[2].status = 'closed'
  data.rows.closures.push({
    incident_id: incident(2).id, organization_id: org, closed_at: '2026-10-04T12:00:00.000Z',
    root_cause: 'Recorded cause', corrective_action: 'Recorded action',
  })
  trend = snapshot(data).incidentTrend!
  equal(trend.records.length, 3)
  equal(trend.records.filter((row) => row.closedAt).length, 1)
})

Deno.test('incident counts use distinct IDs, normalized status and occurred_at windows', () => {
  const data = dataset([
    incident(0, { occurred_at: '2026-09-06T12:00:00.000Z', reported_at: '2026-09-06T12:00:00.000Z', severity: null }),
    incident(1, { status: 'closed' }),
    incident(2, { status: 'pending_verification' }),
    incident(3, { occurred_at: '2026-07-08T12:00:00.000Z', reported_at: '2026-07-08T12:00:00.000Z' }),
    incident(4, { occurred_at: '2026-07-08T11:59:59.999Z', reported_at: '2026-07-08T11:59:59.999Z' }),
    incident(5, { report_type: 'near_miss' }),
    incident(6, { status: 'draft' }),
    incident(7, { occurred_at: asOf.toISOString(), reported_at: asOf.toISOString() }),
  ])
  data.rows.incidents[6] = safetyIncidentSchema.parse({ ...data.rows.incidents[6], status: ' Draft Report ' })
  data.draftTotal = 1
  data.rows.incidents.push(data.rows.incidents[0])
  equal(snapshot(data).metrics.incidentCounts, { state: 'available', reasons: [
    'Reports at or after the snapshot cutoff are excluded.',
  ], total: 5, open: 4, closed: 1, drafts: 1, draftScope: 'organization_open', nearMiss: 1 })
  const allTime = calculateSafetySnapshot(data, scope, { days: 'all' }, asOf).metrics.incidentCounts!
  equal([allTime.total, allTime.open, allTime.closed, allTime.drafts, allTime.nearMiss], [7, 6, 1, 1, 1])
  const ninetyDays = calculateSafetySnapshot(data, scope, { days: 90 }, asOf).metrics.incidentCounts!
  equal([ninetyDays.total, ninetyDays.open, ninetyDays.closed, ninetyDays.drafts, ninetyDays.nearMiss], [5, 4, 1, 1, 1])
  const shorter = calculateSafetySnapshot(data, scope, { days: 30 }, asOf)
  equal([shorter.metrics.incidentCounts?.total, shorter.metrics.incidentCounts?.open,
    shorter.metrics.incidentCounts?.closed, shorter.metrics.incidentCounts?.drafts,
    shorter.metrics.incidentCounts?.nearMiss], [4, 3, 1, 1, 1])
  equal(snapshot().metrics.incidentCounts?.total, 0)
  data.rows.incidents.push(incident(8, { reported_at: null }))
  equal(snapshot(data).metrics.incidentCounts?.state, 'incomplete')
  data.coverage[0].complete = false
  equal(snapshot(data).metrics.incidentCounts?.state, 'incomplete')
  const foreign = dataset([incident(0, { organization_id: id(999) })])
  let rejected = false
  try { snapshot(foreign) } catch { rejected = true }
  assert(rejected, 'Foreign organization entered KPI calculations')
})

Deno.test('dashboard, executive analytics, and incident report status counts agree', () => {
  const rows = [
    incident(0, { status: 'submitted', severity: 'High' }),
    incident(1, { status: 'pending_verification', severity: 'Critical' }),
    incident(2, { status: 'closed', severity: 'High' }),
    incident(3, { status: 'closed', severity: 'Low', potential_severity: 'Medium' }),
    incident(4, { status: 'draft', severity: 'Critical' }),
    incident(5, { status: 'submitted', severity: 'High', potential_severity: 'Unmapped severity' }),
  ]
  const dashboardCounts = calculateIncidentStatusCounts(rows)
  const reportOpenCount = rows.filter((row) => isOpenIncidentStatus(row.status)).length
  const reportClosedCount = rows.filter((row) => normalizeIncidentStatus(row.status) === 'closed').length
  const data = dataset(rows)
  data.draftTotal = 1
  const executiveCounts = snapshot(data).metrics

  equal(
    [dashboardCounts.total, dashboardCounts.open, dashboardCounts.closed, dashboardCounts.highRisk,
      dashboardCounts.closedHighRisk],
    [5, 3, 2, 3, 1],
  )
  equal([reportOpenCount, reportClosedCount], [dashboardCounts.open, dashboardCounts.closed])
  equal(
    [executiveCounts.incidentCounts?.total, executiveCounts.incidentCounts?.open, executiveCounts.incidentCounts?.closed,
      executiveCounts.highRisk.count, executiveCounts.highRisk.openCount, executiveCounts.highRisk.closedCount],
    [dashboardCounts.total, dashboardCounts.open, dashboardCounts.closed, dashboardCounts.highRisk,
      dashboardCounts.openHighRisk, dashboardCounts.closedHighRisk],
  )
  equal(executiveCounts.incidentCounts?.drafts, 1)
  assert(!JSON.stringify(snapshot(data)).includes(rows[4].id), 'Executive Analytics exposed a draft incident detail')
})

Deno.test('outstanding action backlog uses distinct unfinished actions with authorized parents, not the KPI window', () => {
  const data = dataset([incident(0, { reported_at: '2025-01-01T00:00:00Z' })])
  const statuses = ['open', 'assigned', 'in_progress', 'pending_verification', 'verified', 'closed', 'rejected'] as const
  data.rows.actions = statuses.map((status, n) => ({
    id: id(300 + n), organization_id: org, incident_id: incident(0).id,
    title: 'Recorded action', status, due_date: null,
  }))
  for (const [index, status] of statuses.entries()) {
    const single = dataset(data.rows.incidents)
    single.rows.actions = [data.rows.actions[index]]
    equal(snapshot(single).metrics.outstandingActions?.count, index < 4 ? 1 : 0)
    assert(single.rows.actions[0].status === status, 'Incorrect status fixture')
  }
  data.rows.actions.push(data.rows.actions[0], {
    ...data.rows.actions[0], id: id(400), incident_id: id(999),
  })
  equal(snapshot(data).metrics.outstandingActions, { state: 'available', reasons: [], count: 4 })
  equal(calculateSafetySnapshot(data, scope, { days: 30 }, asOf).metrics.outstandingActions?.count, 4)
  const actionCoverage = data.coverage.find((entry) => entry.source === 'actions')!
  actionCoverage.access = 'caller_visible'
  assert(snapshot(data).metrics.outstandingActions!.reasons.some((reason) => reason.includes('Caller-visible')),
    'Limited visibility was not disclosed')
  actionCoverage.complete = false
  equal(snapshot(data).metrics.outstandingActions?.state, 'incomplete')
  equal(snapshot().metrics.outstandingActions?.count, 0)
})

Deno.test('risk formula, severity mapping, unknown classifications and minimum coverage', () => {
  const data = dataset(Array.from({ length: 100 }, (_, n) => incident(n, {
    severity: n < 40 ? 'High' : 'Low', status: n < 20 || n >= 40 ? 'submitted' : 'closed',
  })))
  const result = snapshot(data)
  equal(result.metrics.risk.score, 34)
  equal(result.metrics.risk.band, 'Medium')
  equal(result.metrics.highRisk, { state: 'available', reasons: [], count: 40, openCount: 20, closedCount: 20 })
  equal(result.metrics.risk.changePoints, null)
  equal(effectiveSafetySeverity(' low ', 'CRITICAL'), 4)
  equal(effectiveSafetySeverity('Low', 'Unmapped custom severity'), null)
  equal(effectiveSafetySeverity('Low', 'constructor'), null)
  equal(effectiveSafetySeverity(null, null), null)
  equal(snapshot().metrics.risk.state, 'insufficient')
  equal(snapshot(dataset(Array.from({ length: 9 }, (_, n) => incident(n)))).metrics.risk.score, null)
  data.rows.incidents[0].potential_severity = 'Unmapped'
  equal(snapshot(data).metrics.risk.state, 'insufficient')
  data.coverage[0].complete = false
  equal(snapshot(data).metrics.risk.state, 'incomplete')
  equal(snapshot(data).metrics.risk.score, null)
})

Deno.test('thresholds use unrounded scores and every nonterminal status is open', () => {
  for (const [high, expected] of [[0, 'Low'], [3, 'Medium'], [6, 'High']] as const) {
    const data = dataset(Array.from({ length: 10 }, (_, n) => incident(n, { severity: n < high ? 'High' : 'Low' })))
    equal(snapshot(data).metrics.risk.band, expected)
  }
  const statuses = ['submitted', 'under_review', 'investigation', 'corrective_action', 'pending_verification', 'closed', 'draft'] as const
  const data = dataset(statuses.map((status, n) => incident(n, { status, severity: 'Critical' })))
  equal(snapshot(data).metrics.highRisk.count, 6)
  equal(snapshot(data).metrics.highRisk.openCount, 5)
})

Deno.test('UTC half-open boundaries and invalid/missing dates are not silently substituted', () => {
  const data = dataset([
    incident(0, { reported_at: '2026-07-08T12:00:00.000Z' }),
    incident(1, { reported_at: '2026-07-08T11:59:59.999Z' }),
    incident(2, { reported_at: asOf.toISOString(), severity: 'Critical' }),
    incident(3, { reported_at: null }),
    incident(4, { reported_at: '2026-02-30T00:00:00Z' }),
  ])
  const result = snapshot(data)
  equal(result.metrics.category.denominator, 1)
  equal(result.dataQuality.missingReportedAt, 2)
  equal(result.dataQuality.futureReportedAt, 1)
  equal(result.locations[0].backlogOpenCritical, 0)
  assert(!result.evidence.some((row) => row.id === incident(2).id), 'Post-cutoff report entered evidence')
  equal(result.metrics.risk.state, 'incomplete')
})

Deno.test('near-miss comparable elapsed periods, zero baselines and shorter months', () => {
  const data = dataset([
    incident(0, { report_type: 'near_miss', reported_at: '2026-09-02T00:00:00Z' }),
    incident(1, { report_type: 'near_miss' }),
    incident(2, { report_type: 'near_miss' }),
    incident(3, { report_type: 'near_miss', reported_at: '2026-09-20T00:00:00Z' }),
  ])
  equal(snapshot(data).metrics.nearMiss.percentageChange, 100)
  data.rows.incidents = data.rows.incidents.filter((row) => !row.reported_at?.startsWith('2026-09'))
  equal(snapshot(data).metrics.nearMiss.direction, 'new_reporting')
  equal(snapshot(data).metrics.nearMiss.percentageChange, null)
  equal(snapshot().metrics.nearMiss.direction, 'no_reports')
  const result = snapshot(dataset(), new Date('2026-03-31T12:00:00Z'))
  equal(result.windows.nearMissPrevious.end, '2026-03-01T00:00:00.000Z')
})

Deno.test('category shares include uncategorized reports and ties are stable', () => {
  const data = dataset([
    incident(0, { incident_category: 'Z category' }), incident(1, { incident_category: 'A category' }),
    incident(2, { incident_category: null }), incident(3, { incident_category: '  ' }),
  ])
  const result = snapshot(data)
  equal(result.metrics.category.label, 'A category')
  equal(result.metrics.category.share, 25)
  equal(result.dataQuality.uncategorized, 2)
})

Deno.test('site rankings use incident site IDs with current-window counts and old backlog inputs', () => {
  const data = dataset([
    incident(0, { severity: 'Critical', site_id: id(5) }),
    incident(1, { severity: 'High', site_id: site }),
    incident(2, { severity: 'Low', site_id: id(6) }),
    incident(3, { severity: 'Low', site_id: id(7) }),
    incident(4, { severity: 'Critical', reported_at: '2025-01-01T00:00:00Z', site_id: id(6) }),
    incident(5, { severity: 'Critical', site_id: null }),
    incident(6, { report_type: 'near_miss', severity: 'Critical', site_id: id(5) }),
  ])
  data.rows.sites.push(
    { id: id(5), organization_id: org, name: 'Zulu' },
    { id: id(6), organization_id: org, name: 'Alpha' },
    { id: id(7), organization_id: org, name: 'Beta' },
  )
  const result = snapshot(data)
  equal(result.locations.filter((row) => row.level === 'site').map((row) => row.name), ['Zulu', 'Fixture Site', 'Alpha', 'Beta'])
  equal(result.locations.find((row) => row.id === id(5))?.count, 1)
  equal(result.locations.find((row) => row.id === id(5))?.highRiskCount, 1)
  equal(result.locations.find((row) => row.id === id(6))?.backlogOpenCritical, 1)
  equal(result.locations.find((row) => row.id === id(6))?.openCriticalCount, 0)
  equal(result.dataQuality.unassignedFacility, 1)
})

Deno.test('site open severity counts include all open report types in the 90-day report-date window', () => {
  const data = dataset([])
  const siteRows = [
    { id: id(5), organization_id: org, name: 'Eckert Drilling Site' },
    { id: id(6), organization_id: org, name: 'Onshore Gas Processing Plant' },
    { id: id(7), organization_id: org, name: 'Offshore Platform Alpha' },
    { id: id(8), organization_id: org, name: 'Alpha Site' },
    { id: id(9), organization_id: org, name: 'High-Volume Site' },
  ]
  data.rows.sites.push(...siteRows)
  const reportTypes = ['incident', 'near_miss', 'unsafe_act', 'unsafe_condition', 'environmental_incident'] as const
  const openStatuses = ['submitted', 'under_review', 'investigation', 'corrective_action', 'pending_verification'] as const
  let reportIndex = 0
  const addReports = (siteId: string, criticalCount: number, highCount: number) => {
    for (const [classification, count] of [['Critical', criticalCount], ['High', highCount]] as const) {
      for (let countIndex = 0; countIndex < count; countIndex++) {
        const firstReport = reportIndex === 0
        const severity = classification === 'Critical'
          ? (countIndex % 3 === 0 ? 'CRITICAL' : countIndex % 3 === 1 ? 'critical' : 'Critical')
          : (countIndex % 2 === 0 ? 'HIGH' : 'High')
        data.rows.incidents.push(incident(reportIndex, {
          site_id: siteId, report_type: reportTypes[reportIndex % reportTypes.length],
          status: openStatuses[reportIndex % openStatuses.length], severity,
          reported_at: firstReport ? '2026-07-08T12:00:00.000Z' : '2026-10-02T12:00:00.000Z',
        }))
        reportIndex++
      }
    }
  }
  addReports(id(5), 10, 2)
  addReports(id(6), 9, 1)
  addReports(id(7), 9, 3)
  addReports(id(8), 9, 3)
  addReports(id(9), 8, 5)
  data.rows.incidents.push(
    incident(reportIndex++, { site_id: id(5), severity: 'Critical', status: 'closed' }),
    incident(reportIndex++, { site_id: id(5), severity: 'Critical', status: 'draft' }),
    incident(reportIndex++, { site_id: id(5), severity: 'Critical', reported_at: '2026-07-08T11:59:59.999Z' }),
  )
  const result = snapshot(data)
  const byName = new Map(result.locations.map((location) => [location.name, location]))
  equal([byName.get('Eckert Drilling Site')?.openCriticalCount, byName.get('Eckert Drilling Site')?.openHighCount], [10, 2])
  equal([byName.get('Onshore Gas Processing Plant')?.openCriticalCount, byName.get('Onshore Gas Processing Plant')?.openHighCount], [9, 1])
  equal([byName.get('Offshore Platform Alpha')?.openCriticalCount, byName.get('Offshore Platform Alpha')?.openHighCount], [9, 3])
  equal([byName.get('Alpha Site')?.openCriticalCount, byName.get('Alpha Site')?.openHighCount], [9, 3])
})

Deno.test('date-only overdue actions and parent visibility are explicit', () => {
  const data = dataset([incident(0, { severity: 'Critical' })])
  for (const [n, due, status] of [
    [0, '2026-10-05', 'open'], [1, '2026-10-06', 'open'],
    [2, '2026-10-01', 'verified'], [3, '2026-02-30', 'assigned'],
  ] as const) data.rows.actions.push({
    id: id(300 + n), organization_id: org, incident_id: incident(0).id,
    title: 'Recorded action', status, due_date: due,
  })
  data.rows.actions.push({ id: id(400), organization_id: org, incident_id: id(999), title: 'Unreadable parent', status: 'open', due_date: '2026-10-01' })
  const result = snapshot(data)
  equal(result.locations[0].overdueActions, 1)
  equal(result.locations[0].overdueCriticalActions, 1)
  equal(result.locations[0].invalidActionDueDates, 1)
  assert(!result.evidence.some((row) => row.excerpt === 'Unreadable parent'), 'Hidden parent action leaked')
})

Deno.test('resolution uses trusted closure cohort, excludes legacy and invalid durations, compares prior window', () => {
  const data = dataset([
    incident(0, { status: 'closed', reported_at: '2026-07-01T00:00:00Z' }),
    incident(1, { status: 'closed', reported_at: '2026-04-01T00:00:00Z' }),
    incident(2, { status: 'closed' }),
    incident(3, { status: 'closed' }),
  ])
  data.rows.closures = [
    { incident_id: incident(0).id, organization_id: org, closed_at: '2026-07-10T00:00:00Z', root_cause: 'Recorded cause', corrective_action: 'Recorded action' },
    { incident_id: incident(1).id, organization_id: org, closed_at: '2026-07-01T00:00:00Z', root_cause: 'Recorded cause', corrective_action: 'Recorded action' },
    { incident_id: incident(3).id, organization_id: org, closed_at: '2026-10-01T00:00:00Z', root_cause: 'Recorded cause', corrective_action: 'Recorded action' },
  ]
  const result = snapshot(data)
  equal(result.metrics.resolution.averageDays, 9)
  equal(result.metrics.resolution.previousAverageDays, 91)
  equal(result.metrics.resolution.changeDays, -82)
  equal(result.metrics.resolution.legacyClosedWithoutEvidence, 1)
  equal(result.metrics.resolution.invalidDurations, 2)
  const legacyOnly = dataset([data.rows.incidents[2]])
  equal(snapshot(legacyOnly).metrics.resolution.invalidDurations, 1)
  const negativeOnly = dataset([data.rows.incidents[3]])
  negativeOnly.rows.closures = [data.rows.closures[2]]
  equal(snapshot(negativeOnly).metrics.resolution.invalidDurations, 1)
  const closureCoverage = data.coverage.find((row) => row.source === 'closures')
  assert(closureCoverage, 'Missing fixture closure coverage')
  closureCoverage.complete = false
  equal(snapshot(data).metrics.resolution.averageDays, null)
})

Deno.test('bounded evidence, contracts and tenant/site scope', () => {
  const data = dataset(Array.from({ length: 100 }, (_, n) => incident(n, { title: 'x'.repeat(2000) })))
  const result = snapshot(data)
  assert(result.evidence.length <= 80 && result.evidence.reduce((sum, row) => sum + row.label.length + row.excerpt.length, 0) <= 24_000, 'Evidence budget exceeded')
  assert(result.evidenceTruncated && safetySnapshotSchema.safeParse(result).success, 'Invalid bounded snapshot')
  assert(!safetyFiltersSchema.safeParse({ userId: id(2) }).success, 'Identity override accepted')
  equal(calculateSafetySnapshot(data, { ...scope, siteId: id(99) }, { days: 90, siteId: id(99) }, asOf).metrics.category.denominator, 0)
  data.rows.incidents[0].organization_id = id(99)
  let rejected = false
  try { snapshot(data) } catch { rejected = true }
  assert(rejected, 'Foreign tenant reached calculation')
})

Deno.test('calculations reject divergent site hints and foreign corrective actions', () => {
  let rejected = false
  try {
    calculateSafetySnapshot(dataset([incident(0)]), scope, { days: 90, siteId: site }, asOf)
  } catch { rejected = true }
  assert(rejected, 'A selected site filter was ignored')
  const data = dataset([incident(0)])
  data.rows.actions.push({
    id: id(500), organization_id: id(999), incident_id: incident(0).id,
    title: 'Foreign action with local parent', status: 'open', due_date: null,
  })
  rejected = false
  try { snapshot(data) } catch { rejected = true }
  assert(rejected, 'Foreign action entered authorized KPI counts')
})
