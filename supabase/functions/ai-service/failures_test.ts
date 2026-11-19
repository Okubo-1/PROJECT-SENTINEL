import { aiResponseSchema } from '../_shared/aiContracts.ts'
import { type AiRuntime, handleAiRequest } from './handler.ts'
import { isRecord } from './access.ts'

const userId = 'aaf49808-1c33-4d9c-98e6-2377a87ce619'
const organizationId = '5c6e1199-6cc7-47d4-ae28-1b895cc7de71'

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
}

type Scenario = {
  name: string
  status: number
  code: string
  auditCode?: string
  missingConfig?: boolean
  missingToken?: boolean
  invalidToken?: boolean
  denied?: boolean
  invalidBody?: boolean
  provider?: 'http' | 'rate_limit' | 'timeout' | 'body_timeout' | 'malformed' | 'invalid_json' | 'network' | 'success'
  unexpected?: boolean
  auditUnavailable?: boolean
  auditCompletionUnavailable?: boolean
  wrongOrganization?: boolean
  wrongUser?: boolean
  inactive?: boolean
  missingMembership?: boolean
  session?: boolean
  sessionDenied?: boolean
}

// Fake HTTP responses exercise the real Supabase client and handler without external calls or credentials.
Deno.test('AI handler fails safely and audits attributable failures', async () => {
  const scenarios: Scenario[] = [
    {
      name: 'missing AI configuration',
      status: 503,
      code: 'service_unavailable',
      missingConfig: true,
      auditCode: 'ai_configuration_missing',
    },
    { name: 'missing token', status: 401, code: 'authentication_required', missingToken: true },
    { name: 'invalid token', status: 401, code: 'authentication_required', invalidToken: true },
    { name: 'cross-organization membership', status: 403, code: 'access_denied', wrongOrganization: true },
    { name: 'wrong membership identity', status: 403, code: 'access_denied', wrongUser: true },
    { name: 'suspended account', status: 403, code: 'access_denied', inactive: true },
    { name: 'missing membership', status: 403, code: 'access_denied', missingMembership: true },
    { name: 'AI permission denied', status: 403, code: 'access_denied', denied: true, auditCode: 'access_denied' },
    {
      name: 'invalid request body',
      status: 400,
      code: 'invalid_request',
      invalidBody: true,
      auditCode: 'invalid_request',
    },
    {
      name: 'provider failure',
      status: 502,
      code: 'provider_error',
      provider: 'http',
      auditCode: 'provider_http_error',
    },
    {
      name: 'rate limited',
      status: 429,
      code: 'rate_limited',
      provider: 'rate_limit',
      auditCode: 'provider_rate_limited',
    },
    {
      name: 'request timeout',
      status: 504,
      code: 'request_timeout',
      provider: 'timeout',
      auditCode: 'provider_timeout',
    },
    {
      name: 'body timeout',
      status: 504,
      code: 'request_timeout',
      provider: 'body_timeout',
      auditCode: 'provider_timeout',
    },
    {
      name: 'malformed output',
      status: 502,
      code: 'provider_error',
      provider: 'malformed',
      auditCode: 'invalid_provider_response',
    },
    {
      name: 'invalid provider JSON',
      status: 502,
      code: 'provider_error',
      provider: 'invalid_json',
      auditCode: 'invalid_provider_json',
    },
    {
      name: 'provider network failure',
      status: 502,
      code: 'provider_error',
      provider: 'network',
      auditCode: 'provider_unavailable',
    },
    { name: 'unexpected server error', status: 500, code: 'internal_error', unexpected: true },
    { name: 'audit unavailable', status: 503, code: 'service_unavailable', auditUnavailable: true },
    {
      name: 'audit completion unavailable',
      status: 503,
      code: 'service_unavailable',
      provider: 'success',
      auditCompletionUnavailable: true,
    },
    { name: 'normal success remains valid', status: 200, code: '', provider: 'success' },
    { name: 'session continues with audited history', status: 200, code: '', provider: 'success', session: true },
    { name: 'unowned session rejected', status: 403, code: 'access_denied', session: true, sessionDenied: true, auditCode: 'access_denied' },
  ]

  for (const scenario of scenarios) {
    const auditWrites: Record<string, unknown>[] = []
    let providerCalls = 0
    const runtime: AiRuntime = {
      env: (name) => {
        if (scenario.unexpected) throw new Error('private-server-details')
        if (name === 'OPENAI_API_KEY' && scenario.missingConfig) return undefined
        if (name === 'OPENAI_MODEL') return 'test-model'
        return name === 'SUPABASE_URL' ? 'https://test.supabase.co' : 'test-config-value'
      },
      fetch: (input, init) =>
        Promise.resolve().then(() => {
          const url = String(input instanceof Request ? input.url : input)
          if (url.includes('api.openai.com')) {
            providerCalls += 1
            if (!init?.signal) throw new Error('Provider request must have a deadline')
            if (scenario.session) {
              const sent = JSON.parse(String(init?.body))
              if (sent.input.length !== 3 || sent.input[0].content !== 'Earlier question'
                || sent.input[1].content !== 'Earlier answer') {
                throw new Error('Same-session history was not supplied to the provider')
              }
            }
            if (scenario.provider === 'timeout') throw new DOMException('private-details', 'TimeoutError')
            if (scenario.provider === 'network') throw new Error('private-provider-details')
            if (scenario.provider === 'body_timeout') {
              return new Response(
                new ReadableStream({
                  start(controller) {
                    controller.error(new DOMException('private-details', 'AbortError'))
                  },
                }),
              )
            }
            if (scenario.provider === 'rate_limit') return json({ error: 'private-provider-details' }, 429)
            if (scenario.provider === 'http') return json({ error: 'private-provider-details' }, 500)
            if (scenario.provider === 'invalid_json') return new Response('not JSON')
            if (scenario.provider === 'success') {
              return json({
                status: 'completed',
                output: [{
                  type: 'message',
                  status: 'completed',
                  content: [{ type: 'output_text', text: 'Test output' }],
                }],
                usage: { input_tokens: 4, output_tokens: 2 },
              })
            }
            return json({ malformed: true })
          }
          if (url.includes('/auth/v1/user')) {
            return scenario.invalidToken ? json({ message: 'private-auth-details' }, 401) : json({ id: userId })
          }
          if (url.includes('/rpc/reserve_ai_provider_attempt')) return json(true)
          if (url.includes('/rest/v1/profiles')) {
            return json([{ id: userId, organization_id: organizationId, account_status: scenario.inactive ? 'suspended' : 'active' }])
          }
          if (url.includes('/rest/v1/memberships')) {
            // The actual query must be bound to the verified identity and profile tenant.
            const query = new URL(url).searchParams
            if (query.get('user_id') !== `eq.${userId}` || query.get('organization_id') !== `eq.${organizationId}`) {
              throw new Error('Membership query must enforce trusted user and organization filters')
            }
            if (scenario.missingMembership) return json([])
            return json([{
              user_id: scenario.wrongUser ? 'other-user' : userId,
              organization_id: scenario.wrongOrganization ? 'other-org' : organizationId,
              role: scenario.denied ? 'Custom Role' : 'Field Worker',
            }])
          }
          if (url.includes('/rest/v1/rpc/can_use_ai_sessions')) {
            return json(!scenario.denied)
          }
          if (url.includes('/rpc/begin_ai_session_turn')) {
            if (scenario.sessionDenied) return json({ code: '42501', message: 'private-session-details' }, 403)
            const args = JSON.parse(String(init?.body))
            if (args.p_request_id !== auditWrites[0]?.request_id) throw new Error('Turn must link to its audit')
            return json([
              { role: 'user', content: 'Earlier question', request_id: 'ee000000-0000-4000-8000-000000000001' },
              { role: 'assistant', content: 'Earlier answer', request_id: 'ee000000-0000-4000-8000-000000000001' },
            ])
          }
          if (url.includes('/rpc/finish_ai_session_turn')) {
            const args = JSON.parse(String(init?.body))
            if (args.p_text !== 'Test output' || args.p_request_id !== auditWrites[0]?.request_id) {
              throw new Error('Persisted assistant message must match its audited request')
            }
            auditWrites.push(args.p_completion)
            return json(true)
          }
          if (url.includes('/rest/v1/ai_request_logs')) {
            if (scenario.auditUnavailable) return json({ message: 'private-database-details' }, 500)
            if (scenario.auditCompletionUnavailable && init?.method === 'PATCH') {
              return json({ message: 'private-database-details' }, 500)
            }
            const body: unknown = JSON.parse(String(init?.body))
            if (!isRecord(body)) throw new Error('Audit write must be an object')
            auditWrites.push(body)
            return init?.method === 'PATCH'
              ? json([{ request_id: auditWrites[0].request_id }])
              : new Response(null, { status: 201 })
          }
          throw new Error(`Unexpected test request: ${url}`)
        }),
    }
    const response = await handleAiRequest(
      new Request('https://test/ai-service', {
        method: 'POST',
        headers: scenario.missingToken ? {} : { Authorization: 'Bearer test-token' },
        body: JSON.stringify(
          scenario.invalidBody ? { prompt: '', organization_id: 'other-org' } : {
            prompt: 'Test question',
            ...(scenario.session ? { sessionId: 'ff000000-0000-4000-8000-000000000001' } : {}),
          },
        ),
      }),
      runtime,
    )
    const raw = await response.text()
    const result = aiResponseSchema.parse(JSON.parse(raw))
    if (scenario.status === 200) {
      if (
        !result.ok || result.content.text !== 'Test output' ||
        result.requestId !== auditWrites[0]?.request_id || auditWrites[1]?.status !== 'succeeded'
      ) {
        throw new Error('Normal success must still be validated and audited')
      }
    } else if (response.status !== scenario.status || result.ok || result.error.code !== scenario.code) {
      throw new Error(`${scenario.name}: unexpected failure envelope ${raw}`)
    }
    if (raw.includes('private-') || raw.includes('test-config-value')) {
      throw new Error(`${scenario.name}: internal details leaked`)
    }
    if (scenario.auditCode) {
      const start = auditWrites[0]
      const end = auditWrites[1]
      if (
        start?.request_id !== result.requestId ||
        start?.user_id !== userId || start?.organization_id !== organizationId ||
        end?.status !== 'failed' || end?.error_code !== scenario.auditCode
      ) {
        throw new Error(`${scenario.name}: failure was not attributed and audited`)
      }
    }
    if (!scenario.provider && providerCalls !== 0) {
      throw new Error(`${scenario.name}: provider must not be called after an early failure`)
    }
    if (scenario.provider && providerCalls !== 1) {
      throw new Error(`${scenario.name}: provider must not be silently retried`)
    }
  }
})
