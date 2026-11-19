import { createClient } from '@supabase/supabase-js'
import { createHandler } from './handler.ts'

const incidentId = '00000000-0000-4000-8000-000000000001'
const organizationId = '00000000-0000-4000-8000-000000000002'
const evidenceId = '00000000-0000-4000-8000-000000000003'
function assert(value: unknown, message: string): asserts value { if (!value) throw new Error(message) }

function fixture(allowed: boolean) {
  let uploadedBucket = ''
  let saved: Record<string, unknown> | null = null
  let signed = 0
  const caller = {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: 'private-user' } }, error: null }) },
    rpc: () => Promise.resolve({ data: allowed, error: null }),
  }
  const admin = {
    from(table: string) {
      return {
        select() { return this }, eq() { return this },
        maybeSingle() {
          return Promise.resolve({ error: null, data: table === 'incidents'
            ? { organization_id: organizationId, is_anonymous: true }
            : { id: evidenceId, organization_id: organizationId, incident_id: incidentId, storage_path: `${organizationId}/${incidentId}/00000000-0000-4000-8000-000000000004` } })
        },
      }
    },
    storage: { from(name: string) {
      uploadedBucket = name
      return {
        upload: () => Promise.resolve({ error: null }),
        createSignedUrl: (_path: string, seconds: number) => { signed = seconds; return Promise.resolve({ data: { signedUrl: 'https://example.test/signed' }, error: null }) },
      }
    } },
    rpc(_name: string, args: Record<string, unknown>) {
      saved = { id: evidenceId, organization_id: args.target_organization_id, incident_id: args.target_incident_id,
        storage_path: args.object_path, original_filename: 'Evidence', mime_type: args.object_type,
        file_size: args.object_size, uploaded_by: null }
      return { single: () => Promise.resolve({ data: saved, error: null }) }
    },
  }
  const factory = ((_url: string, key: string) => key === 'caller' ? caller : admin) as unknown as typeof createClient
  return {
    handle: createHandler({ url: 'https://example.test', anonKey: 'caller', serviceKey: 'service', createClient: factory }),
    bucket: () => uploadedBucket, saved: () => saved, signed: () => signed,
  }
}

Deno.test('anonymous upload stores opaque metadata in the private bucket', async () => {
  const f = fixture(true)
  const result = await f.handle(new Request('https://example.test', { method: 'POST',
    headers: { authorization: 'Bearer test', 'x-evidence-action': 'upload', 'x-incident-id': incidentId, 'x-evidence-type': 'application/pdf' }, body: 'test' }))
  const body = await result.json()
  assert(result.status === 200 && f.bucket() === 'anonymous-incident-evidence', 'Wrong upload destination')
  assert(body.sanitization === 'unverified' && body.evidence.uploaded_by === null, 'Uploader identity was recorded')
  assert(/^00000000-0000-4000-8000-000000000002\/00000000-0000-4000-8000-000000000001\/[0-9a-f-]{36}$/.test(body.evidence.storage_path), 'Path is not opaque')
  assert(!JSON.stringify(f.saved()).includes('private-user'), 'Uploader identity leaked')
})

Deno.test('signed URLs are issued only after caller authorization', async () => {
  for (const allowed of [true, false]) {
    const f = fixture(allowed)
    const result = await f.handle(new Request('https://example.test', { method: 'POST',
      headers: { authorization: 'Bearer test', 'x-evidence-action': 'download', 'content-type': 'application/json' },
      body: JSON.stringify({ evidenceId }) }))
    const body = await result.json()
    if (allowed) assert(result.status === 200 && body.signedUrl && f.signed() === 60 && f.bucket() === 'anonymous-incident-evidence', 'Authorized download failed')
    else assert(result.status === 404 && !body.signedUrl && f.signed() === 0, 'Unauthorized caller received a signed URL')
  }
})

Deno.test('unauthorized upload never reaches storage', async () => {
  const f = fixture(false)
  const result = await f.handle(new Request('https://example.test', { method: 'POST',
    headers: { authorization: 'Bearer test', 'x-evidence-action': 'upload', 'x-incident-id': incidentId, 'x-evidence-type': 'application/pdf' }, body: 'test' }))
  assert(result.status === 404 && !f.bucket() && !f.saved(), 'Unauthorized upload reached storage')
})
