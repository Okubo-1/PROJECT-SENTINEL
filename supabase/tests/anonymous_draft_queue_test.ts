import type { SupabaseClient } from '@supabase/supabase-js'
import { getOfflineAnonymousDraft, listOfflineAnonymousDrafts, saveOfflineAnonymousDraft, syncOfflineAnonymousDrafts } from '../../src/features/incidents/anonymousDraftQueue.ts'
import type { IncidentDraftInput } from '../../src/features/incidents/incidentTypes.ts'

const ownerToken = 'a'.repeat(64)
const otherToken = 'b'.repeat(64)
const reporterId = '12345678-1234-4234-8234-123456789012'
const organizationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const incidentId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'

function assert(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message)
}

export async function testAnonymousDraftQueue() {
  const queueId = crypto.randomUUID()
  const raw = { reportType: 'incident', title: 'Private draft', digitalSignature: reporterId, reporter_id: reporterId, created_by: reporterId }
  const input: IncidentDraftInput = raw as IncidentDraftInput
  try {
  const queued = await saveOfflineAnonymousDraft(input, ownerToken, queueId)
  assert(!JSON.stringify(queued).includes(reporterId) && !('digitalSignature' in queued.input), 'Offline draft contains reporter identity')
  let token = otherToken
  let calls = 0
  let sent: Record<string, unknown> | undefined
  const client = {
    rpc(name: string, args: Record<string, unknown>) {
      if (name === 'anonymous_draft_owner_token') return Promise.resolve({ data: token, error: null })
      if (name !== 'save_my_anonymous_draft') throw new Error('Unexpected RPC')
      calls++
      sent = args
      return Promise.resolve({ data: {
        id: incidentId, organization_id: organizationId, reference_number: 'INC-1',
        is_anonymous: true, status: 'draft', created_by: null, reported_by: null,
      }, error: null })
    },
  } as unknown as SupabaseClient
  const otherResult = await syncOfflineAnonymousDrafts(client)
  assert(otherResult.saved.length === 0 && calls === 0, 'Another account attempted to sync the draft')
  assert(!(await listOfflineAnonymousDrafts(client)).some((item) => item.id === queueId), 'Another account can list the draft')
  let denied = false
  try { await getOfflineAnonymousDraft(queueId, otherToken) } catch { denied = true }
  assert(denied, 'Another account reopened the draft')
  token = ownerToken
  assert((await listOfflineAnonymousDrafts(client)).some((item) => item.id === queueId), 'Owner cannot discover the draft')
  assert((await getOfflineAnonymousDraft(queueId, ownerToken)).input.title === 'Private draft', 'Owner cannot recover draft content')
  const ownerResult = await syncOfflineAnonymousDrafts(client)
  assert(ownerResult.saved.length === 1 && calls === 1, 'Owner could not sync the draft')
  assert(!JSON.stringify(sent).includes(reporterId) && sent?.p_owner_token === ownerToken, 'Sync exposed reporter identity')
  const replay = await syncOfflineAnonymousDrafts(client)
  assert(replay.saved.length === 0 && calls === 1, 'Synced draft was submitted again')
  const edited = await saveOfflineAnonymousDraft(input, ownerToken, queueId)
  assert(edited.serverDraftId === incidentId, 'Offline edit lost its server draft reference')
  let rejected = false
  try { await saveOfflineAnonymousDraft(input, otherToken, queueId) } catch { rejected = true }
  assert(rejected, 'A different account overwrote the offline draft')
  } finally {
    const database = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open('sentinelqhse-anonymous-drafts', 1)
      request.onsuccess = () => resolve(request.result)
      request.onerror = () => reject(request.error)
    })
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction('drafts', 'readwrite')
      transaction.objectStore('drafts').delete(queueId)
      transaction.oncomplete = () => { database.close(); resolve() }
      transaction.onabort = () => { database.close(); reject(transaction.error) }
    })
  }
}
