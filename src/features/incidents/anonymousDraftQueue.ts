import type { SupabaseClient } from '@supabase/supabase-js'
import { anonymousDraftInput, getAnonymousDraftOwnerToken, saveAnonymousIncidentDraft } from './incidentService'
import type { IncidentDraftInput, IncidentSummary } from './incidentTypes'

export type AnonymousDraftQueueItem = {
  id: string
  ownerToken: string
  input: IncidentDraftInput
  serverDraftId: string | null
  pending: boolean
}

const databaseName = 'sentinelqhse-anonymous-drafts'
const storeName = 'drafts'
let syncInFlight: Promise<{ saved: IncidentSummary[]; failed: number }> | null = null

function openQueue(): Promise<IDBDatabase> {
  if (!('indexedDB' in window)) return Promise.reject(new Error('Offline draft storage is not supported by this browser.'))
  return new Promise((resolve, reject) => {
    const request = window.indexedDB.open(databaseName, 1)
    request.onupgradeneeded = () => request.result.createObjectStore(storeName, { keyPath: 'id' })
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error || new Error('Unable to open offline draft storage.'))
  })
}

async function queueTransaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await openQueue()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, mode)
    const request = operation(transaction.objectStore(storeName))
    transaction.oncomplete = () => { database.close(); resolve(request.result) }
    transaction.onabort = () => { database.close(); reject(transaction.error || request.error || new Error('Unable to access offline drafts.')) }
    transaction.onerror = () => { database.close(); reject(transaction.error || request.error || new Error('Unable to access offline drafts.')) }
  })
}

async function recordSyncedDraft(item: AnonymousDraftQueueItem, serverDraftId: string): Promise<void> {
  const database = await openQueue()
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.get(item.id)
    request.onsuccess = () => {
      const current = request.result as AnonymousDraftQueueItem | undefined
      if (current && current.ownerToken === item.ownerToken) {
        store.put({ ...current, serverDraftId, pending: JSON.stringify(current.input) !== JSON.stringify(item.input) })
      }
    }
    transaction.oncomplete = () => { database.close(); resolve() }
    transaction.onabort = () => { database.close(); reject(transaction.error || new Error('Unable to update offline draft status.')) }
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Unable to update offline draft status.')) }
  })
}

export async function saveOfflineAnonymousDraft(input: IncidentDraftInput, ownerToken: string, id: string = crypto.randomUUID(), serverDraftId: string | null = null) {
  if (!/^[0-9a-f]{64}$/.test(ownerToken)) throw new Error('Connect to the internet to authorize anonymous offline drafts first.')
  const cleanInput = anonymousDraftInput(input)
  const database = await openQueue()
  return new Promise<AnonymousDraftQueueItem>((resolve, reject) => {
    const transaction = database.transaction(storeName, 'readwrite')
    const store = transaction.objectStore(storeName)
    const request = store.get(id)
    let item: AnonymousDraftQueueItem
    let wrongOwner = false
    request.onsuccess = () => {
      const existing = request.result as AnonymousDraftQueueItem | undefined
      if (existing && existing.ownerToken !== ownerToken) {
        wrongOwner = true
        transaction.abort()
        return
      }
      item = { id, ownerToken, input: cleanInput, serverDraftId: existing?.serverDraftId || serverDraftId, pending: true }
      store.put(item)
    }
    transaction.oncomplete = () => { database.close(); resolve(item) }
    transaction.onabort = () => { database.close(); reject(new Error(wrongOwner ? 'This offline draft belongs to another account.' : 'Unable to save the offline draft.')) }
    transaction.onerror = () => { database.close(); reject(transaction.error || new Error('Unable to save the offline draft.')) }
  })
}

export async function getOfflineAnonymousDraft(id: string, ownerToken: string) {
  const item = await queueTransaction('readonly', (store) => store.get(id)) as AnonymousDraftQueueItem | undefined
  if (!item || item.ownerToken !== ownerToken) throw new Error('Offline draft is unavailable.')
  return item
}

export async function listOfflineAnonymousDrafts(client: SupabaseClient): Promise<AnonymousDraftQueueItem[]> {
  const entries = await queueTransaction('readonly', (store) => store.getAll()) as AnonymousDraftQueueItem[]
  if (!entries.length) return []
  const ownerToken = await getAnonymousDraftOwnerToken(client)
  if (!/^[0-9a-f]{64}$/.test(ownerToken)) throw new Error('Unable to authorize offline drafts.')
  return entries.filter((entry) => entry.ownerToken === ownerToken)
}

export async function syncOfflineAnonymousDrafts(client: SupabaseClient) {
  if (syncInFlight) return syncInFlight
  syncInFlight = syncOfflineAnonymousDraftsInternal(client)
  try { return await syncInFlight } finally { syncInFlight = null }
}

async function syncOfflineAnonymousDraftsInternal(client: SupabaseClient): Promise<{ saved: IncidentSummary[]; failed: number }> {
  if (typeof navigator !== 'undefined' && !navigator.onLine) return { saved: [], failed: 0 }
  const entries = await queueTransaction('readonly', (store) => store.getAll()) as AnonymousDraftQueueItem[]
  if (!entries.some((entry) => entry.pending)) return { saved: [], failed: 0 }
  const ownerToken = await getAnonymousDraftOwnerToken(client)
  const saved: IncidentSummary[] = []
  let failed = 0
  for (const item of entries) {
    if (!item.pending || item.ownerToken !== ownerToken) continue
    try {
      const result = await saveAnonymousIncidentDraft(client, item.serverDraftId, item.input, item.id, item.ownerToken)
      // Do not replace a newer offline edit made while the server request was in flight.
      await recordSyncedDraft(item, result.id)
      saved.push(result)
    } catch {
      failed += 1
    }
  }
  return { saved, failed }
}
