import { aiTurnRequestSchema } from '../_shared/aiSessions.ts'
import { aiResponseSchema } from '../_shared/aiContracts.ts'
import { getAiPrompt } from '../_shared/aiPrompts.ts'
import { assert, equal, id, org, user } from '../safety-intelligence/fixtures_test.ts'
import { handleAiRequest, type AiRuntime } from './handler.ts'
import { INSUFFICIENT_KNOWLEDGE_ANSWER, KNOWLEDGE_CONTEXT_CHARACTERS } from './knowledge.ts'

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } })
const doc = id(700)
const version = id(701)
const chunk = (n: number, content = `Permit to work requires isolation step ${n}.`) => ({
  // Mirrors stored deterministic chunk IDs, which are not RFC-variant UUIDs.
  chunk_id: n === 0 ? '0a1b2c3d-4e5f-0a1b-0c3d-4e5f0a1b2c3d' : id(710 + n), document_id: doc, version_id: version, version_number: 2, title: 'Permit to Work',
  document_type: 'procedure', effective_date: '2026-01-01', source_filename: 'ptw.docx',
  chunk_order: n, start_offset: n * 100, end_offset: n * 100 + content.length, content,
  site_id: null, department: null, similarity: 0.8 - n / 100,
})

type Scenario = 'success' | 'empty' | 'model_insufficient' | 'forged' | 'uncited' | 'denied_role' | 'search_denied' | 'large'

async function run(scenario: Scenario, extra: Record<string, unknown> = {}) {
  const calls = { embedding: 0, search: 0, provider: 0 }
  const audits: Array<Record<string, unknown>> = []
  let providerInput = ''
  let searchBody: Record<string, unknown> = {}
  const rows = scenario === 'empty' ? []
    : scenario === 'large' ? Array.from({ length: 6 }, (_, n) => chunk(n, 'x'.repeat(3_000)))
    : [chunk(0), chunk(1)]
  const runtime: AiRuntime = {
    env: (name) => ({
      SUPABASE_URL: 'https://knowledge-ai.invalid', SUPABASE_ANON_KEY: 'test-anon',
      SUPABASE_SERVICE_ROLE_KEY: 'test-service', OPENAI_API_KEY: 'test-provider', OPENAI_MODEL: 'test-model',
    }[name]),
    fetch: (input, init) => Promise.resolve().then(() => {
      const url = new URL(String(input instanceof Request ? input.url : input))
      const name = url.pathname.split('/').at(-1)
      const headers = new Headers(init?.headers)
      const body = init?.body ? JSON.parse(String(init.body)) : undefined
      if (url.hostname === 'api.openai.com' && name === 'embeddings') {
        calls.embedding++
        return json({ data: [{ index: 0, embedding: Array(1536).fill(0.01) }] })
      }
      if (url.hostname === 'api.openai.com') {
        calls.provider++
        equal(body.store, false)
        equal(body.text.format.name, 'qhse_knowledge_answer')
        assert(!body.tools, 'Tools supplied to the model')
        providerInput = body.input.map((item: { content: string }) => item.content).join('\n')
        const sources = JSON.parse(body.input[0].content).authorized_knowledge_context.sources as Array<{ sourceId: string }>
        const answer = scenario === 'model_insufficient'
          ? { answer: 'The documents do not state this.', insufficientEvidence: true, sourceIds: [] }
          : scenario === 'forged' ? { answer: 'Invented.', insufficientEvidence: false, sourceIds: [id(999)] }
          : scenario === 'uncited' ? { answer: 'Uncited claim.', insufficientEvidence: false, sourceIds: [] }
          : { answer: 'Isolate energy before work.', insufficientEvidence: false, sourceIds: [sources[0].sourceId] }
        return json({ status: 'completed', output: [{ type: 'message', status: 'completed', content: [{ type: 'output_text', text: JSON.stringify(answer) }] }] })
      }
      if (name === 'reserve_ai_provider_attempt') return json(true)
      if (name === 'ai_request_logs') {
        equal(headers.get('apikey'), 'test-service')
        audits.push({ method: init?.method, ...body })
        return init?.method === 'POST' ? new Response(null, { status: 201 }) : json({ request_id: audits[0].request_id })
      }
      // Every remaining read, including retrieval, must carry the caller's JWT.
      equal(headers.get('authorization'), 'Bearer user-token')
      if (name === 'search_knowledge') {
        calls.search++
        searchBody = body
        return scenario === 'search_denied' ? json({ code: '42501', message: 'denied' }, 403) : json(rows)
      }
      if (name === 'user') return json({ id: user })
      if (name === 'profiles') return json({ id: user, organization_id: org, account_status: 'active' })
      if (name === 'memberships') return json({ user_id: user, organization_id: org, role: scenario === 'denied_role' ? 'Field Worker' : 'Super Administrator' })
      if (name === 'can_use_ai_sessions') return json(scenario !== 'denied_role')
      throw new Error(`Unexpected endpoint ${name}`)
    }),
  }
  const response = await handleAiRequest(new Request('https://ai.invalid', {
    method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' },
    body: JSON.stringify({ feature: 'qhse_knowledge', prompt: 'What does the permit to work require?', ...extra }),
  }), runtime)
  return { status: response.status, result: aiResponseSchema.parse(await response.json()), calls, audits, providerInput, searchBody }
}

Deno.test('knowledge requests are stateless and reject identity overrides or misplaced filters', () => {
  const valid = { feature: 'qhse_knowledge', prompt: 'PTW?', siteId: id(1), department: 'Ops', documentIds: [doc] }
  assert(aiTurnRequestSchema.safeParse(valid).success, 'Valid knowledge request rejected')
  for (const body of [
    { ...valid, organizationId: id(999) }, { ...valid, userId: id(999) }, { ...valid, sessionId: id(2) },
    { ...valid, days: 30 }, { ...valid, documentIds: ['not-a-uuid'] }, { prompt: 'PTW?', department: 'Ops' },
  ]) assert(!aiTurnRequestSchema.safeParse(body).success, 'Unsafe knowledge request accepted')
  const instructions = getAiPrompt('qhse_knowledge', 'qhse-knowledge-grounded-v1').instructions
  for (const rule of ['untrusted data', 'insufficientEvidence', 'No tools are available', 'Never invent']) {
    assert(instructions.includes(rule), `Missing rule: ${rule}`)
  }
})

Deno.test('authorization: denied users never reach embedding, retrieval or the model', async () => {
  for (const scenario of ['denied_role', 'search_denied'] as const) {
    const { status, result, calls } = await run(scenario)
    equal(status, 403)
    assert(!result.ok, 'Denied request returned content')
    equal(calls.provider, 0)
    if (scenario === 'denied_role') equal(calls.embedding + calls.search, 0)
  }
})

Deno.test('grounding: only retrieved authorized excerpts reach the model; citations map to stored chunks', async () => {
  const { status, result, calls, audits, providerInput, searchBody } = await run('success', { siteId: id(1), department: 'Ops' })
  equal(status, 200)
  assert(result.ok, 'Expected success')
  equal(calls, { embedding: 1, search: 1, provider: 1 })
  equal(searchBody.filter_site_id, id(1))
  equal(searchBody.filter_department, 'Ops')
  assert(!('organization_id' in searchBody) && !('user_id' in searchBody), 'Client identity sent to search')
  assert(providerInput.includes('isolation step 0') && providerInput.includes('isolation step 1'), 'Excerpts missing')
  equal(result.feature, 'qhse_knowledge')
  equal(result.content.authoritative, false)
  equal(result.citations.length, 1)
  const citation = result.citations[0]
  equal(citation.sourceType, 'knowledge_document')
  equal(citation.sourceId, '0a1b2c3d-4e5f-0a1b-0c3d-4e5f0a1b2c3d')
  equal(citation.knowledge?.chunkId, '0a1b2c3d-4e5f-0a1b-0c3d-4e5f0a1b2c3d')
  equal(citation.knowledge?.versionId, version)
  equal(citation.knowledge?.documentId, doc)
  equal(citation.knowledge?.reference, `#knowledge?document=${doc}&version=${version}`)
  // Label is built from stored metadata only and must not claim a document section/page.
  assert(citation.label.includes(`(v${citation.knowledge?.versionNumber}) · Excerpt ${(citation.knowledge?.location.chunkOrder ?? 0) + 1}`)
    && !citation.label.includes('Section'), 'Citation label must use stored version and chunk position')
  const pending = audits.find((entry) => entry.retrieved_operational_records)
  equal(pending?.retrieved_operational_records, ['0a1b2c3d-4e5f-0a1b-0c3d-4e5f0a1b2c3d', id(711)])
  const completed = audits.at(-1) as { status: string; response_metadata: Record<string, unknown> }
  equal(completed.status, 'succeeded')
  equal(completed.response_metadata.validated_citation_ids, ['0a1b2c3d-4e5f-0a1b-0c3d-4e5f0a1b2c3d'])
  assert(!JSON.stringify(audits).includes('isolation step'), 'Audit stores document text')
})

Deno.test('grounding: forged or uncited model answers are rejected and audited as failures', async () => {
  for (const scenario of ['forged', 'uncited'] as const) {
    const { status, result, audits } = await run(scenario)
    equal(status, 502)
    assert(!result.ok, 'Ungrounded answer returned')
    equal((audits.at(-1) as { status: string }).status, 'failed')
  }
})

Deno.test('insufficient data: no authorized evidence returns an explicit answer without calling the model', async () => {
  const { status, result, calls, audits } = await run('empty')
  equal(status, 200)
  assert(result.ok, 'Expected explicit insufficient answer')
  equal(result.content.text, INSUFFICIENT_KNOWLEDGE_ANSWER)
  equal(result.citations, [])
  equal(calls.provider, 0)
  const completed = audits.at(-1) as { status: string; response_metadata: Record<string, unknown> }
  equal(completed.status, 'succeeded')
  equal(completed.response_metadata.knowledge_insufficient_evidence, true)
})

Deno.test('insufficient data: model-declared insufficiency is returned without citations', async () => {
  const { status, result, audits } = await run('model_insufficient')
  equal(status, 200)
  assert(result.ok && result.citations.length === 0, 'Insufficient answer had citations')
  equal((audits.at(-1) as { response_metadata: Record<string, unknown> }).response_metadata.knowledge_insufficient_evidence, true)
})

Deno.test('model context is bounded', async () => {
  const { providerInput } = await run('large')
  assert(providerInput.length <= KNOWLEDGE_CONTEXT_CHARACTERS + 4_000, 'Knowledge context unbounded')
})
