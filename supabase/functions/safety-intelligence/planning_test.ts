import { buildSafetyPlanningIndicators } from '../_shared/safetyPlanningIndicators.ts'
import { calculateSafetySnapshot } from '../_shared/safetyIntelligenceCalculations.ts'
import { asOf, assert, dataset, equal, id, incident, org, scope, site } from './fixtures_test.ts'

Deno.test('planning metrics include submitted report types but exclude drafts', () => {
  const reports = [
    incident(0, { severity: 'Critical', status: 'submitted', site_id: site }),
    incident(1, { severity: 'High', status: 'under_review', report_type: 'near_miss', site_id: site }),
    incident(2, { severity: 'HIGH', status: 'pending_verification', report_type: 'unsafe_act', site_id: site }),
    incident(3, { severity: 'Critical', status: 'closed', site_id: site }),
  ]
  const draft = incident(4, { severity: 'critical', status: 'draft', report_type: 'unsafe_condition', site_id: site })
  const data = dataset(reports)
  data.planningIncidents = [...reports, draft]
  data.draftTotal = 1
  data.planningActions = [
    { id: id(300), organization_id: org, incident_id: reports[0].id, title: 'Critical due today', status: 'pending_verification', due_date: '2026-10-06' },
    { id: id(301), organization_id: org, incident_id: reports[0].id, title: 'Critical overdue', status: 'open', due_date: '2026-10-05' },
    { id: id(302), organization_id: org, incident_id: reports[0].id, title: 'Critical missing due date', status: 'assigned', due_date: null },
    { id: id(303), organization_id: org, incident_id: reports[1].id, title: 'High due future', status: 'in_progress', due_date: '2026-10-07' },
    { id: id(304), organization_id: org, incident_id: reports[2].id, title: 'High completed', status: 'completed', due_date: '2026-10-07' },
    { id: id(305), organization_id: org, incident_id: draft.id, title: 'Draft-linked due future', status: 'open', due_date: '2026-10-08' },
  ]
  const result = calculateSafetySnapshot(data, scope, { days: 30 }, asOf)
  const siteSnapshot = result.planningSites!.find((entry) => entry.id === site)!
  equal([
    siteSnapshot.openCritical, siteSnapshot.openHigh,
    siteSnapshot.nonOverdueUnfinishedActions, siteSnapshot.criticalLinkedUnfinishedActions,
  ], [1, 2, 2, 3])
  equal(result.metrics.incidentCounts?.total, 4)
  equal(result.metrics.incidentCounts?.open, 3)
  equal(result.metrics.incidentCounts?.closed, 1)
  equal(result.metrics.incidentCounts?.drafts, 1)
  equal(result.metrics.incidentCounts?.nearMiss, 1)
  const outlook = buildSafetyPlanningIndicators(result)
  equal(outlook.locations[0].drivers.map((item) => item.observation), [
    '1 open Critical reports.',
    '3 unfinished actions linked to open Critical reports.',
    '2 open High reports.',
    '2 non-overdue unfinished corrective actions.',
  ])
  assert(outlook.locations[0].drivers[0].advice.includes('control effectiveness'), 'Critical advice omits control verification')
  assert(outlook.locations[0].drivers[0].advice.includes('elimination, substitution or engineering controls'),
    'Critical advice omits hierarchy-of-controls options')
  assert(outlook.locations[0].drivers[0].advice.includes('management review'), 'Critical advice omits management review')
  assert(outlook.locations[0].drivers[1].advice.includes('continual improvement'), 'Action advice omits continual improvement')
  assert(outlook.locations[1] === undefined, 'Unexpected additional site row')
  assert(outlook.locations[0].reasons.some((reason) => reason.includes('missing or invalid due dates')),
    'Missing action due date was not disclosed')
  equal(outlook.planningEnd, '2026-10-20T12:00:00.000Z')
  assert(!JSON.stringify(outlook).includes('indicator'), 'Planning indicator output remains')
})

Deno.test('planning includes older open reports, excludes closed reports, and keeps site scoping', () => {
  const oldCritical = incident(0, { severity: 'Critical', status: 'investigation', reported_at: '2025-01-01T00:00:00Z' })
  const oldClosed = incident(1, { severity: 'Critical', status: 'closed', reported_at: '2025-01-01T00:00:00Z' })
  const otherSite = incident(2, { severity: 'Critical', site_id: id(99) })
  const data = dataset([oldCritical, oldClosed, otherSite])
  data.planningIncidents = data.rows.incidents
  data.planningActions = []
  const result = calculateSafetySnapshot(data, { ...scope, siteId: site }, { days: 90, siteId: site }, asOf)
  equal(result.planningSites?.find((entry) => entry.id === site)?.openCritical, 1)
  assert(!JSON.stringify(buildSafetyPlanningIndicators(result)).includes('Excluded'), 'Foreign site was included')
})

Deno.test('planning reports incomplete authorization and source coverage without an indicator band', () => {
  const data = calculateSafetySnapshot(dataset(Array.from({ length: 10 }, (_, n) => incident(n))), scope, { days: 90 }, asOf)
  for (const source of ['incidents', 'actions', 'sites'] as const) {
    const copy = structuredClone(data)
    copy.coverage.find((item) => item.source === source)!.complete = false
    const item = buildSafetyPlanningIndicators(copy).locations[0]
    equal(item.state, 'incomplete')
    assert(item.reasons.length > 0, 'Missing source limitation')
  }
  const callerVisible = structuredClone(data)
  callerVisible.coverage.find((item) => item.source === 'actions')!.access = 'caller_visible'
  assert(buildSafetyPlanningIndicators(callerVisible).locations[0].reasons.some((reason) => reason.includes('hidden actions')),
    'Action access limitation concealed')
})
Deno.test('legacy snapshots still render planning rows from site metrics instead of the unavailable message', () => {
  const data = calculateSafetySnapshot(dataset(Array.from({ length: 10 }, (_, n) => incident(n))), scope, { days: 90 }, asOf)
  delete data.planningSites
  const outlook = buildSafetyPlanningIndicators(data)
  assert(outlook.state === 'available', 'Legacy site counts still blocked planning rendering')
  assert(outlook.locations.length > 0, 'Legacy site fallback did not generate planning rows')
  assert(!JSON.stringify(outlook).includes('does not provide planning counts'), 'Legacy planner fallback still reported deployment unavailability')
})