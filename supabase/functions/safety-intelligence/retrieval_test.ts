import { createClient } from '@supabase/supabase-js'
import { resolveSafetyScope, retrieveSafetyDataset } from '../_shared/safetyIntelligenceRetrieval.ts'
import { asOf, assert, dataset, equal, id, incident, org, site, user } from './fixtures_test.ts'
import { handleSafetyRequest, type SafetyRuntime } from './handler.ts'
import { safetyResponseSchema } from '../_shared/safetyIntelligenceContracts.ts'
import { calculateSafetySnapshot } from '../_shared/safetyIntelligenceCalculations.ts'
import { buildCopilotGrounding } from '../_shared/safetyCopilotGrounding.ts'

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}
const tableForSource = {
  incidents: 'incidents', actions: 'corrective_actions', investigations: 'investigations',
  causes: 'investigation_root_causes', findings: 'investigation_findings', closures: 'incident_closures',
  sites: 'sites', facilities: 'facilities',
}
type Scenario = {
  organizationId?: string;
  role?: string; delegated?: boolean; inactive?: boolean; invalidToken?: boolean;
  wrongMembership?: boolean; denyPermission?: boolean; malformed?: boolean; failedRead?: boolean;
  foreignRow?: boolean;
  customPermissions?: string[];
  organizationPermission?: boolean;
  draftCountFailure?: boolean;
  omitAnonymityFlag?: boolean;
}
function fixtureFetch(data = dataset(), scenario: Scenario = {}, seen: URL[] = []): typeof fetch {
  const tenant = scenario.organizationId ?? org
  return (input, init) => Promise.resolve().then(() => {
    const url = new URL(String(input instanceof Request ? input.url : input))
    seen.push(url)
    assert(!url.hostname.includes('openai'), 'Unexpected paid provider call')
    assert(new Headers(init?.headers).get('authorization') === 'Bearer test-token', 'Caller token was not forwarded')
    if (url.pathname.endsWith('/user')) return json(scenario.invalidToken ? { message: 'private-details' } : { id: user }, scenario.invalidToken ? 401 : 200)
    const table = url.pathname.split('/').at(-1)
    if (table === 'profiles') return json({ id: user, organization_id: tenant, account_status: scenario.inactive ? 'suspended' : 'active' })
    if (table === 'memberships') return json({
      user_id: scenario.wrongMembership ? id(999) : user, organization_id: tenant,
      role: scenario.role ?? 'Super Administrator',
    })
    if (table === 'custom_roles') return json({ permissions: scenario.denyPermission ? [] : scenario.customPermissions ?? [] })
    if (table === 'can_close_incidents') return json(scenario.delegated ?? false)
    if (table === 'get_incident_draft_total') return scenario.draftCountFailure
      ? json({ message: 'private-database-details' }, 500)
      : json(data.rows.incidents.filter((row) => row.status === 'draft').length)
    if (url.pathname.endsWith('/rpc/has_org_permission')) {
      return json(scenario.organizationPermission
        ?? ((scenario.role ?? 'Super Administrator') === 'Super Administrator' || scenario.customPermissions?.includes('view_all_incidents') === true))
    }
    if (table === 'company_settings') {
      assert(url.searchParams.get('organization_id') === `eq.${tenant}`, 'Missing trusted settings tenant predicate')
      assert(!init?.method || init.method === 'GET', 'Settings retrieval attempted a write')
      return json(data.companySettings ?? null)
    }
    if (table === 'actions') return json([])
    const source = Object.entries(tableForSource).find(([, name]) => name === table)?.[0]
    if (!source) throw new Error(`Unexpected endpoint ${url.pathname}`)
    assert(url.searchParams.get('organization_id') === `eq.${tenant}`, 'Missing trusted tenant predicate')
    assert(!init?.method || init.method === 'GET', 'Operational retrieval attempted a write')
    if (scenario.failedRead) return json({ message: 'private-database-details' }, 500)
    if (scenario.malformed) return json([{ id: 'not-a-uuid' }])
    const key = source === 'closures' ? 'incident_id' : 'id'
    const list: unknown[] = data.rows[source as keyof typeof data.rows]
    if (source === 'incidents') assert(url.searchParams.get('status') === 'neq.draft', 'Drafts were not excluded at the database')
    const cursor = url.searchParams.get(key)?.replace('gt.', '')
    let records = list.map((row) => {
      const parsed = JSON.parse(JSON.stringify(row)) as Record<string, unknown>
      if (source === 'incidents' && scenario.omitAnonymityFlag) delete parsed.is_anonymous
      return scenario.foreignRow ? { ...parsed, organization_id: id(999) } : parsed
    }).filter((row) => (!cursor || String(row[key]) > cursor)
      && (source !== 'incidents' || row.status !== 'draft'))
    records.sort((a, b) => String(a[key]).localeCompare(String(b[key])))
    return json(records.slice(0, Number(url.searchParams.get('limit'))))
  })
}
function client(fetcher: typeof fetch) {
  return createClient('https://intelligence-test.invalid', 'test-anon', {
    global: { headers: { Authorization: 'Bearer test-token' }, fetch: fetcher },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

Deno.test('keyset pagination detects exact-cap completeness and truncation without offset skips', async () => {
  const seen: URL[] = []
  const data = dataset([incident(0), incident(1), incident(2), incident(3)])
  const caller = client(fixtureFetch(data, {}, seen))
  const context = { organizationId: org, userId: user, role: 'Super Administrator' }
  const complete = await retrieveSafetyDataset(caller, context, { days: 90 }, { pageSize: 2, maxRows: 4 })
  equal(complete.rows.incidents.length, 4)
  assert(complete.coverage.every((row) => row.complete), 'Exact-cap result marked incomplete')
  assert(seen.some((url) => url.searchParams.get('id')?.startsWith('gt.')), 'No stable cursor used')
  assert(seen.every((url) => !url.searchParams.has('offset')), 'Offset pagination used')
  const partial = await retrieveSafetyDataset(caller, context, { days: 90 }, { pageSize: 2, maxRows: 3 })
  equal(partial.rows.incidents.length, 3)
  assert(!partial.coverage.find((row) => row.source === 'incidents')?.complete, 'Cap silently reported complete')
})

Deno.test('default pagination retrieves more than one thousand eligible records without an implicit API cutoff', async () => {
  const data = dataset(Array.from({ length: 1203 }, (_, n) => incident(n)))
  const result = await retrieveSafetyDataset(client(fixtureFetch(data)),
    { organizationId: org, userId: user, role: 'Super Administrator' }, { days: 90 })
  equal(result.rows.incidents.length, 1203)
  assert(result.coverage.find((source) => source.source === 'incidents')?.complete, 'Complete paginated data marked incomplete')
})

Deno.test('approved evaluation incident retains its existing linked sources under trusted tenant predicates', async () => {
  const tenant = '25ad3a5c-514b-4097-96a6-a712c715d92b'
  const data = dataset([incident(0, {
    client_submission_id: 'MOCK-STARNET-INCIDENTS-20260929-0001',
    digital_signature: 'MOCK:MOCK-STARNET-INCIDENTS-20260929',
  })])
  data.rows.actions.push({ id: id(300), organization_id: tenant, incident_id: incident(0).id,
    title: 'Existing linked action', status: 'open', due_date: null })
  data.rows.investigations.push({ id: id(400), organization_id: tenant, incident_id: incident(0).id,
    status: 'completed', completed_at: null, findings_summary: 'Existing findings' })
  data.rows.causes.push({ id: id(500), organization_id: tenant, investigation_id: id(400),
    root_cause_statement: 'Existing cause', cause_category: null })
  data.rows.closures.push({ organization_id: tenant, incident_id: incident(0).id,
    closed_at: asOf.toISOString(), root_cause: 'Existing cause', corrective_action: 'Existing action' })
  for (const collection of Object.values(data.rows)) for (const row of collection) row.organization_id = tenant
  data.companySettings!.organization_id = tenant
  const result = await retrieveSafetyDataset(client(fixtureFetch(data, { organizationId: tenant })),
    { organizationId: tenant, userId: user, role: 'Super Administrator' }, { days: 90, trendDays: 'all' })
  for (const source of ['incidents', 'actions', 'investigations', 'causes', 'closures'] as const) {
    equal(result.rows[source].length, 1)
  }
  assert(result.coverage.every((row) => row.complete), 'Restored linked coverage incomplete')
})

Deno.test('site filters narrow real visibility; child sources require both parent and own access', async () => {
  const data = dataset([incident(0), incident(1, { site_id: id(99), facility_id: null })])
  data.rows.actions = [
    { id: id(300), organization_id: org, incident_id: incident(0).id, title: 'Visible action', status: 'open', due_date: null },
    { id: id(301), organization_id: org, incident_id: id(999), title: 'Assigned but hidden parent', status: 'open', due_date: null },
    { id: id(302), organization_id: org, incident_id: incident(1).id, title: 'Other site', status: 'open', due_date: null },
  ]
  data.rows.investigations = [
    { id: id(400), organization_id: org, incident_id: incident(0).id, status: 'completed', completed_at: null, findings_summary: null },
    { id: id(401), organization_id: org, incident_id: id(999), status: 'completed', completed_at: null, findings_summary: 'Hidden parent findings' },
  ]
  data.rows.causes = [
    { id: id(500), organization_id: org, investigation_id: id(400), root_cause_statement: 'Visible recorded cause', cause_category: null },
    { id: id(501), organization_id: org, investigation_id: id(401), root_cause_statement: 'Hidden parent cause', cause_category: null },
  ]
  const caller = client(fixtureFetch(data, { role: 'Field Worker' }))
  const context = { organizationId: org, userId: user, role: 'Field Worker' }
  const result = await retrieveSafetyDataset(caller, context, { days: 90, siteId: site })
  equal(result.rows.incidents.length, 1)
  equal(result.rows.actions.map((row) => row.title), ['Visible action'])
  equal(result.rows.causes.map((row) => row.root_cause_statement), ['Visible recorded cause'])
  assert(result.coverage.every((row) => row.access === 'caller_visible'), 'Personal reads mislabeled organization coverage')
  equal((await resolveSafetyScope(caller, context, { days: 90 })).visibility, 'personal')
  equal((await resolveSafetyScope(client(fixtureFetch(data, { role: 'Field Worker', delegated: true })), context, { days: 90 })).visibility, 'organization')
})

Deno.test('organization coverage follows database permissions and delegation instead of role names', async () => {
  const data = dataset([incident(0)])
  const context = { organizationId: org, userId: user, role: 'Custom analyst' }
  for (const [permission, delegated, expected] of [
    [false, false, 'personal'], [true, false, 'organization'], [false, true, 'organization'],
  ] as const) {
    const caller = client(fixtureFetch(data, { role: context.role, organizationPermission: permission, delegated }))
    const scope = await resolveSafetyScope(caller, context, { days: 90 })
    const result = await retrieveSafetyDataset(caller, context, { days: 90 })
    equal(scope.visibility, expected)
    equal(result.coverage.find((entry) => entry.source === 'incidents')?.access,
      expected === 'organization' ? 'organization' : 'caller_visible')
    equal(result.rows.incidents.map((row) => row.id), [incident(0).id])
  }
})

Deno.test('draft details and linked actions are excluded from all analytics and planning data', async () => {
  const draft = incident(10, { status: 'draft', report_type: 'near_miss', site_id: id(55), severity: 'Critical Risk' })
  const submitted = incident(11, { site_id: site })
  const data = dataset([draft, submitted])
  data.rows.sites.push({ id: id(55), organization_id: org, name: 'Draft planning site' })
  data.rows.actions = [
    { id: id(300), organization_id: org, incident_id: draft.id, title: 'Draft-linked action', status: 'Pending Verification', due_date: '2026-10-20' },
    { id: id(301), organization_id: org, incident_id: submitted.id, title: 'Submitted-linked action', status: 'open', due_date: '2026-10-20' },
  ]
  const result = await retrieveSafetyDataset(client(fixtureFetch(data)),
    { organizationId: org, userId: user, role: 'Super Administrator' }, { days: 90 })
  equal(result.rows.incidents.map((row) => row.id), [submitted.id])
  equal(result.planningIncidents?.map((row) => row.id), [submitted.id])
  equal(result.rows.actions.map((row) => row.title), ['Submitted-linked action'])
  equal(result.planningActions?.map((row) => row.title), ['Submitted-linked action'])
  assert(!result.planningSites?.some((row) => row.id === id(55)), 'Draft-only site leaked into planning lookup')
  assert(!result.rows.sites.some((row) => row.id === id(55)), 'Draft-only site leaked into standard snapshot rows')
  assert(!JSON.stringify(result).includes(draft.id), 'Draft details leaked into analytics data')
})

Deno.test('anonymous incident narratives never enter analytics or AI grounding', async () => {
  const marker = 'Private reporter identity marker'
  const anonymous = incident(0, { is_anonymous: true, title: marker, digital_signature: marker, client_submission_id: marker })
  const identified = incident(1, { title: 'Identified incident remains visible' })
  const draft = incident(2, { status: 'draft', is_anonymous: true, title: marker })
  const data = dataset([anonymous, identified, draft])
  data.rows.actions.push({ id: id(300), organization_id: org, incident_id: anonymous.id, title: marker, status: 'open', due_date: null })
  data.rows.investigations.push({ id: id(400), organization_id: org, incident_id: anonymous.id, status: 'completed', completed_at: null, findings_summary: marker })
  data.rows.causes.push({ id: id(500), organization_id: org, investigation_id: id(400), root_cause_statement: marker, cause_category: marker })
  data.rows.findings.push({ id: id(600), organization_id: org, investigation_id: id(400), description: marker, finding_type: marker })
  data.rows.closures.push({ incident_id: anonymous.id, organization_id: org, closed_at: asOf.toISOString(), root_cause: marker, corrective_action: marker })
  const caller = client(fixtureFetch(data))
  const context = { organizationId: org, userId: user, role: 'Super Administrator' }
  const filters = { days: 90 as const }
  const retrieved = await retrieveSafetyDataset(caller, context, filters)
  const scope = await resolveSafetyScope(caller, context, filters)
  const snapshot = calculateSafetySnapshot(retrieved, scope, filters, asOf)
  const grounding = await buildCopilotGrounding(retrieved, snapshot, 'Safety summary')
  assert(!JSON.stringify(retrieved).includes(marker), 'Anonymous narrative leaked into retrieved data')
  assert(!JSON.stringify(snapshot).includes(marker), 'Anonymous narrative leaked into analytics response')
  assert(!grounding.serialized.includes(marker), 'Anonymous narrative leaked into model input')
  assert(!grounding.serialized.includes(draft.id), 'Draft details leaked into model input')
  assert(JSON.stringify(retrieved).includes(identified.title), 'Identified incident behavior changed')
})

Deno.test('snapshot HTTP response and application logs omit anonymous narrative markers', async () => {
  const marker = 'Private reporter identity marker'
  const anonymous = incident(0, { is_anonymous: true, title: marker })
  const data = dataset([anonymous, incident(1, { title: 'Identified incident visible' })])
  data.rows.actions.push({ id: id(300), organization_id: org, incident_id: anonymous.id, title: marker, status: 'open', due_date: null })
  let authorization = ''
  await client((_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return Promise.resolve(json([]))
  }).from('test').select('id')
  const logs: unknown[] = []
  const originalError = console.error
  const originalLog = console.log
  console.error = (...args: unknown[]) => logs.push(args)
  console.log = (...args: unknown[]) => logs.push(args)
  try {
    const response = await handleSafetyRequest(new Request('https://test.invalid', {
      method: 'POST', headers: { Authorization: authorization }, body: '{}',
    }), {
      env: (name) => name === 'SUPABASE_URL' ? 'https://intelligence-test.invalid' : 'test-anon',
      now: () => asOf, fetch: fixtureFetch(data),
    })
    equal(response.status, 200)
    const text = await response.text()
    assert(!text.includes(marker), 'Anonymous narrative leaked in HTTP response')
    assert(!JSON.stringify(logs).includes(marker), 'Anonymous narrative leaked in application logs')
    safetyResponseSchema.parse(JSON.parse(text))
  } finally {
    console.error = originalError
    console.log = originalLog
  }
})

Deno.test('executive draft total is unfiltered and failed aggregate reads fail closed', async () => {
  const draft = incident(10, { status: 'draft', title: 'Private draft title', site_id: id(55) })
  const data = dataset([draft, incident(11)])
  let authorization = ''
  await client((_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return Promise.resolve(json([]))
  }).from('test').select('id')
  const testRequest = (url: string, init: RequestInit) => {
    const request = new Request(url, init)
    request.headers.set('Authorization', authorization)
    return request
  }
  for (const filters of [{ days: 30, siteId: site }, { days: 90, department: 'No matching department' }]) {
    const seen: URL[] = []
    const runtime: SafetyRuntime = {
      env: (name) => name === 'SUPABASE_URL' ? 'https://intelligence-test.invalid' : 'test-anon',
      now: () => asOf, fetch: fixtureFetch(data, {}, seen),
    }
    const response = await handleSafetyRequest(testRequest('https://test.invalid', {
      method: 'POST', headers: { Authorization: '******' }, body: JSON.stringify(filters),
    }), runtime)
    equal(response.status, 200)
    const text = await response.text()
    assert(!text.includes(draft.id) && !text.includes(draft.title), 'Draft details leaked in response')
    const result = safetyResponseSchema.parse(JSON.parse(text))
    assert(result.ok, 'Expected successful snapshot')
    equal([result.snapshot.metrics.incidentCounts?.drafts, result.snapshot.metrics.incidentCounts?.draftScope], [1, 'organization_open'])
    assert(seen.some((url) => url.pathname.endsWith('/rpc/get_incident_draft_total')), 'Aggregate RPC was not called')
  }
  const failed = await handleSafetyRequest(testRequest('https://test.invalid', {
    method: 'POST', headers: { Authorization: '******' }, body: '{}',
  }), {
    env: (name) => name === 'SUPABASE_URL' ? 'https://intelligence-test.invalid' : 'test-anon',
    now: () => asOf, fetch: fixtureFetch(data, { draftCountFailure: true }),
  })
  equal(failed.status, 503)
  assert(!(await failed.text()).includes('private-database-details'), 'Aggregate error leaked internals')
})

Deno.test('confirmed synthetic provenance excludes incident and linked evidence without filtering ordinary submission IDs', async () => {
  const data = dataset([
    incident(0, { client_submission_id: 'MOCK-COMPANY-INCIDENTS-20260929-0001', digital_signature: 'MOCK:MOCK-COMPANY-INCIDENTS-20260929' }),
    incident(1, { client_submission_id: 'MOCK-COMPANY-INCIDENTS-20260929-0002', digital_signature: 'Human signature' }),
    incident(2, { client_submission_id: null, digital_signature: null }),
  ])
  data.rows.actions = [
    { id: id(300), organization_id: org, incident_id: incident(0).id, title: 'Synthetic action', status: 'open', due_date: null },
    { id: id(301), organization_id: org, incident_id: incident(2).id, title: 'Operational action', status: 'open', due_date: null },
  ]
  const result = await retrieveSafetyDataset(client(fixtureFetch(data)),
    { organizationId: org, userId: user, role: 'Super Administrator' }, { days: 90 })
  equal(result.rows.incidents.map((row) => row.id), [incident(1).id, incident(2).id])
  equal(result.rows.actions.map((row) => row.title), ['Operational action'])
  const coverage = result.coverage.find((source) => source.source === 'incidents')!
  equal([coverage.retrieved, coverage.included, coverage.complete], [3, 2, true])
  assert(coverage.reasons.some((reason) => reason.includes('1 confirmed synthetic')), 'Synthetic exclusion not disclosed')
})

Deno.test('authenticated snapshot endpoint rejects overrides, auth/role failures and malformed sources safely', async () => {
  const scenarios = [
    { name: 'Super Administrator default', status: 200, body: {}, scenario: {} },
    { name: 'custom permission', status: 200, body: {}, scenario: { role: 'Custom analyst', customPermissions: ['view_executive_analytics'] } },
    { name: 'organization admin default denied', status: 403, body: {}, scenario: { role: 'Organization Administrator' } },
    { name: 'field worker default denied', status: 403, body: {}, scenario: { role: 'Field Worker' } },
    { name: 'inactive', status: 403, body: {}, scenario: { inactive: true } },
    { name: 'bad token', status: 401, body: {}, scenario: { invalidToken: true } },
    { name: 'wrong identity', status: 403, body: {}, scenario: { wrongMembership: true } },
    { name: 'custom permission denied', status: 403, body: {}, scenario: { role: 'Custom analyst', customPermissions: ['view_executive_analytics'], denyPermission: true } },
    { name: 'custom permission revoked', status: 403, body: {}, scenario: { role: 'Custom analyst' } },
    { name: 'client tenant override', status: 400, body: { organizationId: id(999) }, scenario: {} },
    { name: 'client scope override', status: 400, body: { visibility: 'organization' }, scenario: {} },
    { name: 'bad window', status: 400, body: { days: 31 }, scenario: {} },
    { name: 'malformed data', status: 503, body: {}, scenario: { malformed: true } },
    { name: 'database failure', status: 503, body: {}, scenario: { failedRead: true } },
    { name: 'foreign tenant data', status: 503, body: {}, scenario: { foreignRow: true } },
    { name: 'missing anonymity flag', status: 503, body: {}, scenario: { omitAnonymityFlag: true } },
  ] satisfies Array<{ name: string; status: number; body: unknown; scenario: Scenario }>
  for (const item of scenarios) {
    const seen: URL[] = []
    const runtime: SafetyRuntime = {
      env: (name) => name === 'SUPABASE_URL' ? 'https://intelligence-test.invalid' : 'test-anon',
      now: () => asOf, fetch: fixtureFetch(dataset([incident(0)]), item.scenario, seen),
    }
    const response = await handleSafetyRequest(new Request('https://test.invalid', {
      method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: JSON.stringify(item.body),
    }), runtime)
    equal(response.status, item.status)
    const text = await response.text()
    assert(!text.includes('private-'), `${item.name} exposed internal details`)
    const parsed = safetyResponseSchema.parse(JSON.parse(text))
    if (parsed.ok) {
      equal(parsed.snapshot.scope.userId, user)
      equal(parsed.snapshot.scope.visibility, item.scenario.role === 'Super Administrator' || !item.scenario.role ? 'organization' : 'personal')
      assert(parsed.snapshot.origin === 'deterministic' && !parsed.snapshot.authoritative, 'Misleading origin')
    } else {
      assert(parsed.requestId.length > 0, 'No failure trace')
      if (item.name.includes('default denied') || item.name.includes('permission denied') || item.name.includes('permission revoked')) {
        equal(parsed.error.message, 'You do not have permission to view Executive Analytics. Please ask your Super Admin to grant you access.')
      }
      if (item.status === 400 || item.status === 401 || item.status === 403) {
        assert(!seen.some((url) => url.pathname.endsWith('/incidents')), 'Rejected caller reached operational data')
      }
    }
  }
})

Deno.test('snapshot handles missing auth/config, malformed JSON and unexpected errors without provider fallback', async () => {
  const request = (authorization?: string, body = '{}') => new Request('https://test.invalid', {
    method: 'POST', headers: authorization ? { Authorization: authorization } : {}, body,
  })
  const runtime: SafetyRuntime = { env: () => undefined, now: () => asOf, fetch: () => { throw new Error('Unexpected network call') } }
  equal((await handleSafetyRequest(request(), runtime)).status, 401)
  equal((await handleSafetyRequest(request('Bearer test-token'), runtime)).status, 503)
  runtime.env = () => { throw new Error('private-configuration') }
  const unexpected = await handleSafetyRequest(request('Bearer test-token'), runtime)
  equal(unexpected.status, 500)
  assert(!(await unexpected.text()).includes('private-configuration'), 'Raw error leaked')
  runtime.env = (name) => name === 'SUPABASE_URL' ? 'https://intelligence-test.invalid' : 'test-anon'
  runtime.fetch = fixtureFetch()
  equal((await handleSafetyRequest(request('Bearer test-token', 'broken json'), runtime)).status, 400)
  equal((await handleSafetyRequest(new Request('https://test.invalid'), runtime)).status, 405)
})

Deno.test('the request deadline survives Supabase wrapping an aborted operational read', async () => {
  const baseFetch = fixtureFetch()
  const runtime: SafetyRuntime = {
    env: (name) => name === 'SUPABASE_URL' ? 'https://intelligence-test.invalid' : 'test-anon',
    now: () => asOf, deadline: () => AbortSignal.timeout(20),
    fetch: (input, init) => {
      if (!String(input).includes('/incidents?')) return baseFetch(input, init)
      const signal = init?.signal
      assert(signal, 'No read deadline')
      return new Promise<Response>((_resolve, reject) => {
        const aborted = () => reject(new DOMException('private-timeout-details', 'AbortError'))
        if (signal.aborted) aborted()
        else signal.addEventListener('abort', aborted, { once: true })
      })
    },
  }
  const response = await handleSafetyRequest(new Request('https://test.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer test-token' }, body: '{}',
  }), runtime)
  equal(response.status, 504)
  const body = safetyResponseSchema.parse(await response.json())
  assert(!body.ok && body.error.code === 'request_timeout', 'Timeout became a fake snapshot')
})
