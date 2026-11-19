import type { SupabaseClient } from '@supabase/supabase-js'
import { downloadIncidentEvidence, submitAnonymousIncidentDraft, submitNewAnonymousIncident, uploadIncidentEvidence } from '../../src/features/incidents/incidentService.ts'

const userId = '00000000-0000-4000-8000-000000000001'
const organizationId = '00000000-0000-4000-8000-000000000002'
const incidentId = '00000000-0000-4000-8000-000000000003'
const evidenceId = '00000000-0000-4000-8000-000000000004'

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function makeClient(anonymous: boolean, sanitizer: 'verified' | 'failed' = 'verified') {
  let evidence: Record<string, unknown> | null = null
  let submittedInput: Record<string, unknown> | null = null
  let uploadedFile: File | null = null
  let uploadedPath = ''
  let signedSeconds = 0
  let activities = 0

  function from(table: string) {
    let inserted: Record<string, unknown> | null = null
    let selection = ''
    const query = {
      select(columns: string) { selection = columns; return query },
      eq() { return query },
      insert(value: Record<string, unknown>) {
        if (table === 'activity_logs') activities++
        else inserted = value
        return query
      },
      single() {
        if (table === 'profiles') return Promise.resolve({ data: { organization_id: organizationId }, error: null })
        if (table === 'incident_evidence' && inserted) {
          evidence = { ...inserted, id: evidenceId, created_at: '2026-01-01T00:00:00Z' }
          return Promise.resolve({ data: evidence, error: null })
        }
        return Promise.resolve({ data: evidence, error: null })
      },
      maybeSingle() {
        if (table === 'memberships') return Promise.resolve({ data: { id: 'membership' }, error: null })
        if (table === 'incidents') return Promise.resolve({ data: { is_anonymous: anonymous }, error: null })
        throw new Error(`Unexpected lookup: ${table}`)
      },
      then(resolve: (result: { data: unknown; error: null }) => unknown) {
        if (table === 'incident_evidence' && selection === 'file_size') return Promise.resolve(resolve({ data: [], error: null }))
        return Promise.resolve(resolve({ data: null, error: null }))
      },
    }
    return query
  }

  const client = {
    auth: { getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }) },
    functions: {
      async invoke(_name: string, options: { body: Blob | { evidenceId: string }; headers: Record<string, string> }) {
        if (options.headers['x-evidence-action'] === 'download') {
          signedSeconds = 60
          return { data: { signedUrl: 'https://storage.example/evidence' }, error: null }
        }
        if (!(options.body instanceof Blob)) throw new Error('Expected file')
        const verified = sanitizer === 'verified' && options.headers['x-evidence-type'] === 'image/png'
        uploadedFile = new File([verified ? 'clean-image' : options.body], 'Evidence', { type: options.headers['x-evidence-type'] })
        uploadedPath = `${organizationId}/${incidentId}/${crypto.randomUUID()}`
        evidence = { id: evidenceId, organization_id: organizationId, incident_id: incidentId, storage_path: uploadedPath,
          original_filename: 'Evidence', mime_type: uploadedFile.type, file_size: uploadedFile.size,
          uploaded_by: null, created_at: '2026-01-01T00:00:00Z' }
        return { data: { evidence, sanitization: verified ? 'verified' : 'unverified' }, error: null }
      },
    },
    from,
    rpc(name: string, args: { p_input: Record<string, unknown> }) {
      if (name !== 'submit_new_anonymous_incident' && name !== 'submit_my_anonymous_draft') throw new Error(`Unexpected RPC: ${name}`)
      submittedInput = args.p_input
      return Promise.resolve({ data: { id: incidentId, referenceNumber: 'INC-1', status: 'submitted', confirmation: 'Anonymous reporter' }, error: null })
    },
    storage: {
      from() {
        return {
          upload(path: string, file: File) { uploadedPath = path; uploadedFile = file; return Promise.resolve({ error: null }) },
          remove() { return Promise.resolve({ error: null }) },
          createSignedUrl(_path: string, seconds: number) { signedSeconds = seconds; return Promise.resolve({ data: { signedUrl: 'https://storage.example/evidence' }, error: null }) },
          download() { return Promise.resolve({ data: new Blob(['identified']), error: null }) },
        }
      },
    },
  } as unknown as SupabaseClient
  return {
    client,
    getSubmittedInput: () => submittedInput,
    getUploadedFile: () => uploadedFile,
    getUploadedPath: () => uploadedPath,
    getSignedSeconds: () => signedSeconds,
    getActivities: () => activities,
  }
}

Deno.test('anonymous submission and evidence omit identity and use a short-lived URL', async () => {
  const fixture = makeClient(true)
  const result = await submitNewAnonymousIncident(fixture.client, {
    reportType: 'incident', occurredAt: '2026-01-01T00:00:00Z', department: 'Operations',
    severity: 'Low', incidentCategory: 'General', shift: 'Day', weatherConditions: 'Sunny',
    accuracyConfirmed: true, digitalSignature: 'Reporter name',
  }, 'stable-submission-id')
  assert(result.confirmation === 'Anonymous reporter' && !JSON.stringify(result).includes(userId), 'Submission response exposed identity')
  assert(!fixture.getSubmittedInput()?.digitalSignature, 'Submission sent the digital signature')

  const file = new File(['evidence'], 'reporter-name.pdf', { type: 'application/pdf' })
  const uploaded = await uploadIncidentEvidence(fixture.client, incidentId, file)
  assert(uploaded.uploadedBy === null && uploaded.originalFilename === 'Evidence', 'Evidence metadata exposed the uploader or filename')
  assert(uploaded.sanitization === 'unverified', 'Unsupported PDF was not marked unverifiable')
  assert(!JSON.stringify(uploaded).includes(userId) && !fixture.getUploadedPath().includes(file.name), 'Evidence response or path exposed identity')
  assert(new RegExp(`^${organizationId}/${incidentId}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).test(fixture.getUploadedPath()), 'Evidence path is not a random UUID')
  assert(fixture.getUploadedFile()?.name === 'Evidence', 'Upload sent the original filename')

  const originalFetch = globalThis.fetch
  globalThis.fetch = () => Promise.resolve(new Response('anonymous'))
  try {
    const downloaded = await downloadIncidentEvidence(fixture.client, evidenceId)
    assert(await downloaded.blob.text() === 'anonymous' && fixture.getSignedSeconds() === 60, 'Anonymous evidence did not use a 60-second signed URL')
    assert(fixture.getActivities() === 0, 'Anonymous evidence generated an identifying activity')
  } finally {
    globalThis.fetch = originalFetch
  }
})

Deno.test('anonymous uploads use sanitized output or warn and retain the original on failure', async () => {
  const file = new File(['original-image'], 'private-name.png', { type: 'image/png' })
  const verified = makeClient(true)
  const cleaned = await uploadIncidentEvidence(verified.client, incidentId, file)
  assert(cleaned.sanitization === 'verified' && await verified.getUploadedFile()?.text() === 'clean-image', 'Sanitized image was not uploaded')
  assert(cleaned.uploadedBy === null && cleaned.fileSize === 11, 'Sanitized evidence metadata is incorrect')
  const failed = makeClient(true, 'failed')
  const fallback = await uploadIncidentEvidence(failed.client, incidentId, file)
  assert(fallback.sanitization === 'unverified' && await failed.getUploadedFile()?.text() === 'original-image', 'Failed sanitization blocked or altered the upload')
  assert(fallback.uploadedBy === null && !failed.getUploadedPath().includes(file.name), 'Fallback exposed uploader identity')
})

Deno.test('anonymous draft submission strips the signature and checks the confirmation', async () => {
  const fixture = makeClient(true)
  const result = await submitAnonymousIncidentDraft(fixture.client, incidentId, {
    reportType: 'incident', occurredAt: '2026-01-01T00:00:00Z', department: 'Operations',
    severity: 'Low', incidentCategory: 'General', shift: 'Day', weatherConditions: 'Sunny',
    accuracyConfirmed: true, digitalSignature: 'Reporter name',
  })
  assert(result.id === incidentId && !fixture.getSubmittedInput()?.digitalSignature, 'Draft submission included a signature')
})

Deno.test('identified evidence retains its uploader and existing upload/download behavior', async () => {
  const fixture = makeClient(false)
  const file = new File(['evidence'], 'identified.pdf', { type: 'application/pdf' })
  const uploaded = await uploadIncidentEvidence(fixture.client, incidentId, file)
  assert(uploaded.uploadedBy === userId && uploaded.originalFilename === file.name, 'Identified evidence was changed')
  assert(fixture.getUploadedPath().includes(userId) && fixture.getUploadedFile()?.name === file.name, 'Identified upload path was changed')
  const downloaded = await downloadIncidentEvidence(fixture.client, evidenceId)
  assert(await downloaded.blob.text() === 'identified' && fixture.getSignedSeconds() === 0, 'Identified download was changed')
  assert(fixture.getActivities() === 2, 'Identified upload or download activity was changed')
})
