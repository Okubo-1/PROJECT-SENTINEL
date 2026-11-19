import { createClient } from '@supabase/supabase-js'
import { AiAccessError, parseAiPrompt, requireAiPermission, resolveAiAccessContext } from './access.ts'

// Unit checks of trusted-context validation; these do not replace database RLS or endpoint tests.
function assertEquals<T>(actual: T, expected: T) {
  if (actual !== expected) {
    throw new Error(`Expected ${String(expected)}, received ${String(actual)}`)
  }
}

Deno.test('AI context requires an active matching profile and membership', () => {
  const userId = 'user-1'
  const organizationId = 'org-1'
  const profile = { id: userId, organization_id: organizationId, account_status: 'active' }
  const membership = { user_id: userId, organization_id: organizationId, role: 'Field Worker' }

  assertEquals(resolveAiAccessContext(userId, profile, membership)?.organizationId, organizationId)
  assertEquals(resolveAiAccessContext(userId, { ...profile, account_status: 'suspended' }, membership), null)
  assertEquals(resolveAiAccessContext(userId, profile, { ...membership, organization_id: 'org-2' }), null)
  assertEquals(resolveAiAccessContext(userId, profile, { ...membership, user_id: 'user-2' }), null)
  assertEquals(resolveAiAccessContext(userId, { ...profile, id: 'user-2' }, membership), null)
  assertEquals(resolveAiAccessContext(userId, profile, null), null)
})

Deno.test('AI permission uses the organization grant and fails closed', async () => {
  for (const [result, expected] of [[true, 200], [false, 403], [null, 503]] as const) {
    const client = createClient('https://permission-test.invalid', 'test-key', {
      global: { fetch: (_input, init) => {
        assertEquals(JSON.parse(String(init?.body)).target_organization_id, 'org-1')
        return Promise.resolve(new Response(JSON.stringify(result), { headers: { 'Content-Type': 'application/json' } }))
      } },
      auth: { persistSession: false, autoRefreshToken: false },
    })
    let status = 200
    try {
      await requireAiPermission(client, { userId: 'user-1', organizationId: 'org-1', role: 'Field Worker' })
    } catch (error) {
      if (!(error instanceof AiAccessError)) throw error
      status = error.status
    }
    assertEquals(status, expected)
  }
})

Deno.test('AI prompt body rejects client-supplied identity and organization context', () => {
  assertEquals(parseAiPrompt({ prompt: '  Explain the safety term  ' }), 'Explain the safety term')
  assertEquals(parseAiPrompt({ prompt: 'Question', organization_id: 'org-2' }), null)
  assertEquals(parseAiPrompt({ prompt: 'Question', user_id: 'user-2' }), null)
  assertEquals(parseAiPrompt({ prompt: 'Question', permissions: ['use_ai_assistant'] }), null)
  assertEquals(parseAiPrompt({ prompt: '   ' }), null)
})
