import { createClient } from '@supabase/supabase-js'
import {
  closeIncident, getIncidentClosureAccess, getIncidentClosureCandidates, IncidentClosureAccessError,
  getIncidentClosure, incidentClosureInputSchema, searchIncidentClosureCandidates, setIncidentClosureDelegate,
} from '../src/features/incidents/incidentClosureService.ts'
import { getIncidents } from '../src/features/incidents/incidentService.ts'

const userId = 'ac000000-0000-4000-8000-000000000002'
const organizationId = 'ad000000-0000-4000-8000-000000000001'
const incidentId = 'af000000-0000-4000-8000-000000000001'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}
function clientWithFetch(fetcher: typeof fetch) {
  return createClient('https://closure-test.invalid', 'test-public-key', {
    global: { fetch: fetcher, headers: { Authorization: 'Bearer test-token' } },
    auth: { persistSession: false, autoRefreshToken: false },
  })
}

Deno.test('delegate name search hides the roster until typing and preserves permission details', () => {
  const roster = [
    { user_id: userId, full_name: 'Adaeze Nwosu', role: 'Field Worker', account_status: 'active', delegated: true },
    { user_id: incidentId, full_name: 'Adeola Adeyemi', role: 'Contractor', account_status: 'active', delegated: false },
  ]
  assert(searchIncidentClosureCandidates(roster, '').length === 0, 'Empty search displays the full roster')
  assert(searchIncidentClosureCandidates(roster, '   ').length === 0, 'Whitespace displays the roster')
  const matches = searchIncidentClosureCandidates(roster, '  NWOSU   ada ')
  assert(matches.length === 1 && matches[0] === roster[0] && matches[0].delegated, 'Name search loses match or delegation details')
  assert(searchIncidentClosureCandidates(roster, 'Ade').length === 1, 'Partial name does not match')
  assert(searchIncidentClosureCandidates(roster, 'Missing user').length === 0, 'Unknown user invented')
  assert(searchIncidentClosureCandidates([], 'Adaeze').length === 0, 'Search returns a user outside the authorized roster')
})

Deno.test('closure input rejects missing evidence or unconfirmed completion', async () => {
  for (const input of [
    { rootCause: ' ', correctiveAction: 'Repair completed', actionCompleted: true },
    { rootCause: 'Loose fitting', correctiveAction: '', actionCompleted: true },
    { rootCause: 'Loose fitting', correctiveAction: 'Repair completed', actionCompleted: false },
    { rootCause: 'x'.repeat(5001), correctiveAction: 'Repair completed', actionCompleted: true },
  ]) assert(!incidentClosureInputSchema.safeParse(input).success, 'Invalid closure input was accepted')
  let calls = 0
  const client = clientWithFetch(() => { calls++; throw new Error('Unexpected request') })
  try {
    await closeIncident(client, incidentId, { rootCause: '', correctiveAction: '', actionCompleted: true })
    throw new Error('Invalid input did not fail')
  } catch (error) {
    assert(error instanceof Error && error.message !== 'Invalid input did not fail', 'Expected validation failure')
  }
  assert(calls === 0, 'Invalid evidence reached the database')
})

Deno.test('closure and delegation clients send only target IDs and evidence, not trusted identity', async () => {
  const requests: Array<{ url: URL; body: Record<string, unknown> }> = []
  const client = clientWithFetch(async (input, init) => {
    const url = new URL(String(input))
    requests.push({ url, body: JSON.parse(String(init?.body)) })
    return new Response(JSON.stringify(url.pathname.endsWith('can_close_incidents') ? true : null), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    })
  })
  await closeIncident(client, incidentId, { rootCause: ' Loose fitting ', correctiveAction: ' Repair completed ', actionCompleted: true })
  await setIncidentClosureDelegate(client, userId, true)
  assert(await getIncidentClosureAccess(client, organizationId), 'Permission result not parsed')
  assert(JSON.stringify(requests[0].body) === JSON.stringify({
    target_incident_id: incidentId, p_root_cause: 'Loose fitting',
    p_corrective_action: 'Repair completed', p_action_completed: true,
  }), 'Closure RPC payload differs')
  assert(JSON.stringify(requests[1].body) === JSON.stringify({ p_user_id: userId, p_enabled: true }), 'Delegation payload differs')
  assert(!('closed_by' in requests[0].body) && !('organization_id' in requests[1].body), 'Client supplied trusted identity')
})

Deno.test('closure permission denial is distinct from a technical verification failure', async () => {
  const deniedClient = clientWithFetch(() => new Response('false', {
    status: 200, headers: { 'Content-Type': 'application/json' },
  }))
  assert(await getIncidentClosureAccess(deniedClient, organizationId) === false, 'Permission denial was not preserved')

  const failedClient = clientWithFetch(() => new Response(JSON.stringify({
    code: 'PGRST202', details: null, hint: null, message: 'Function is missing from the schema cache',
  }), { status: 404, headers: { 'Content-Type': 'application/json' } }))
  const originalConsoleError = console.error
  console.error = () => {}
  try {
    await getIncidentClosureAccess(failedClient, organizationId)
    throw new Error('Technical verification failure was treated as success')
  } catch (error) {
    assert(error instanceof IncidentClosureAccessError, 'Technical failure was reported as permission denial')
    assert(error.message.includes('retry'), 'Technical failure did not provide safe retry guidance')
  } finally {
    console.error = originalConsoleError
  }
})

Deno.test('client exposes closure rejection and validates roster and closure evidence', async () => {
  const client = clientWithFetch(async (input) => {
    const path = new URL(String(input)).pathname
    if (path.endsWith('close_incident')) return new Response(JSON.stringify({
      code: 'P0001', message: 'All linked corrective actions must be verified or closed before closing this incident',
    }), { status: 400, headers: { 'Content-Type': 'application/json' } })
    const body = path.endsWith('list_incident_closure_candidates')
      ? [{ user_id: userId, full_name: 'Test delegate', role: 'Field Worker', account_status: 'active', delegated: true }]
      : { root_cause: 'Loose fitting', corrective_action: 'Repair completed', action_completed: true, closed_by: userId, closed_at: '2026-10-06T00:00:00Z' }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  })
  try {
    await closeIncident(client, incidentId, { rootCause: 'Loose fitting', correctiveAction: 'Repair completed', actionCompleted: true })
    throw new Error('Rejected closure succeeded')
  } catch (error) {
    assert(error instanceof Error && error.message.includes('linked corrective actions'), 'Closure rejection was hidden')
  }
  assert((await getIncidentClosureCandidates(client))[0].delegated, 'Roster missing delegation')
  assert((await getIncidentClosure(client, incidentId))?.closed_by === userId, 'Closure evidence missing trusted closer')
})

Deno.test('own/all incident retrieval and open/closed filtering produce the required database queries', async () => {
  const incidentQueries: URL[] = []
  const client = clientWithFetch(async (input) => {
    const url = new URL(String(input))
    let body: unknown
    if (url.pathname.endsWith('/user')) body = { id: userId }
    else if (url.pathname.endsWith('/profiles')) body = { organization_id: organizationId }
    else if (url.pathname.endsWith('/memberships')) body = { id: userId }
    else {
      incidentQueries.push(url)
      body = []
    }
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json', 'Content-Range': '*/0' } })
  })
  await getIncidents(client, { status: 'open' }, 'own')
  await getIncidents(client, { status: 'closed' }, 'organization')
  assert(incidentQueries[0].searchParams.get('or') === `(created_by.eq.${userId},reported_by.eq.${userId})`, 'Own view is not caller scoped')
  assert(JSON.stringify(incidentQueries[0].searchParams.getAll('status')) === '["neq.draft","neq.closed"]', 'Open filter misses workflow statuses')
  assert(!incidentQueries[1].searchParams.has('or'), 'All view incorrectly restricted to caller')
  assert(incidentQueries[1].searchParams.get('status') === 'eq.closed', 'Closed filter is incorrect')
  assert(incidentQueries.every((url) => url.searchParams.get('organization_id') === `eq.${organizationId}`), 'Organization filter missing')
})
