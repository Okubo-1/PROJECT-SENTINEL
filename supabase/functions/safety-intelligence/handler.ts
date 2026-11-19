import { createClient } from '@supabase/supabase-js'
import { AiAccessError, authenticateOrganization, requireExecutiveAnalyticsPermission } from '../ai-service/access.ts'
import { isAiTimeout } from '../ai-service/failures.ts'
import { safetyFiltersSchema, safetyResponseSchema } from '../_shared/safetyIntelligenceContracts.ts'
import { resolveSafetyScope, retrieveSafetyDataset, SafetyRetrievalError } from '../_shared/safetyIntelligenceRetrieval.ts'
import { calculateSafetySnapshot } from '../_shared/safetyIntelligenceCalculations.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
export type SafetyRuntime = {
  env: (name: string) => string | undefined
  fetch: typeof fetch
  now: () => Date
  deadline?: () => AbortSignal
}

export async function handleSafetyRequest(request: Request, runtime: SafetyRuntime = {
  env: (name) => Deno.env.get(name), fetch, now: () => new Date(),
}): Promise<Response> {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  const requestId = crypto.randomUUID()
  const respond = (body: unknown, status: number) => new Response(JSON.stringify(safetyResponseSchema.parse(body)), {
    status, headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })
  const fail = (status: number, code: string, message: string) => {
    console.error('Safety intelligence request failed', { requestId, code })
    return respond({ ok: false, requestId, error: { code, message } }, status)
  }
  let deadline: AbortSignal | undefined
  try {
    if (request.method !== 'POST') return fail(405, 'invalid_request', 'POST is required.')
    const authorization = request.headers.get('Authorization')
    if (!authorization?.match(/^Bearer\s+\S+$/i)) return fail(401, 'authentication_required', 'Authentication is required.')
    const url = runtime.env('SUPABASE_URL')
    const key = runtime.env('SUPABASE_ANON_KEY')
    if (!url || !key) return fail(503, 'service_unavailable', 'Safety intelligence is not configured.')
    // One deadline covers auth plus all reads. No OpenAI key or privileged data client is used.
    const readDeadline = runtime.deadline?.() ?? AbortSignal.timeout(20_000)
    deadline = readDeadline
    const client = createClient(url, key, {
      global: {
        headers: { Authorization: authorization },
        fetch: (input, init) => runtime.fetch(input, {
          ...init, signal: init?.signal ? AbortSignal.any([readDeadline, init.signal]) : readDeadline,
        }),
      },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    const context = await authenticateOrganization(client)
    await requireExecutiveAnalyticsPermission(client, context)
    let body: unknown
    try { body = await request.json() } catch { return fail(400, 'invalid_request', 'A valid JSON request body is required.') }
    const filters = safetyFiltersSchema.safeParse(body)
    if (!filters.success) return fail(400, 'invalid_request', 'Invalid analytics filters. Use a 30/90/all period, a window basis, and optional site, department, shift, status, severity, report type and trend period.')
    const scope = await resolveSafetyScope(client, context, filters.data)
    const asOf = runtime.now()
    const dataset = await retrieveSafetyDataset(client, context, filters.data)
    const draftResult = await client.rpc('get_incident_draft_total')
    if (draftResult.error || !Number.isSafeInteger(draftResult.data) || draftResult.data < 0) throw new SafetyRetrievalError()
    dataset.draftTotal = draftResult.data
    const snapshot = calculateSafetySnapshot(dataset, scope, filters.data, asOf, runtime.now())
    if (readDeadline.aborted) return fail(504, 'request_timeout', 'Safety intelligence retrieval timed out.')
    return respond({ ok: true, requestId, snapshot }, 200)
  } catch (error) {
    if (deadline?.aborted || isAiTimeout(error)) return fail(504, 'request_timeout', 'Safety intelligence retrieval timed out.')
    if (error instanceof AiAccessError) return fail(error.status,
      error.status === 401 ? 'authentication_required' : error.status === 403 ? 'access_denied' : 'service_unavailable', error.message)
    if (error instanceof SafetyRetrievalError) return fail(503, 'service_unavailable', error.message)
    return fail(500, 'internal_error', 'Unable to complete the safety intelligence request.')
  }
}
