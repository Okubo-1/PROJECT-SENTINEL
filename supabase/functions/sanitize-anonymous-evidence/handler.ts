import { createClient } from '@supabase/supabase-js'
import { sanitizeEvidence } from './sanitize.ts'

const bucket = 'anonymous-incident-evidence'
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const mimePattern = /^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|webm)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/plain)$/
const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-evidence-type, x-incident-id, x-evidence-action',
  'Cache-Control': 'no-store',
}
type Options = { url?: string; anonKey?: string; serviceKey?: string; createClient: typeof createClient }
const json = (body: unknown, status = 200) => Response.json(body, { status, headers })

async function readFile(request: Request, limit: number): Promise<Uint8Array | null> {
  if (!request.body) return null
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.length
    if (size > limit) { await reader.cancel(); return null }
    chunks.push(value)
  }
  if (!size) return null
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return bytes
}

export function createHandler(options: Options) {
  return async (request: Request): Promise<Response> => {
    if (request.method === 'OPTIONS') return new Response(null, { headers })
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
    if (!options.url || !options.anonKey || !options.serviceKey) return json({ error: 'Service unavailable' }, 503)
    const authorization = request.headers.get('Authorization')
    if (!authorization) return json({ error: 'Authentication required' }, 401)
    const caller = options.createClient(options.url, options.anonKey, { global: { headers: { Authorization: authorization } } })
    const admin = options.createClient(options.url, options.serviceKey)
    try {
      const { data: { user }, error: authError } = await caller.auth.getUser()
      if (authError || !user) return json({ error: 'Authentication required' }, 401)
      const action = request.headers.get('x-evidence-action')
      let incidentId: string
      let evidence: { id: string; organization_id: string; incident_id: string; storage_path: string } | null = null
      if (action === 'upload') {
        incidentId = request.headers.get('x-incident-id') || ''
      } else if (action === 'download' || action === 'delete') {
        const body = await readFile(request, 4096)
        if (!body) return json({ error: 'Invalid request' }, 400)
        let payload: { evidenceId?: unknown }
        try { payload = JSON.parse(new TextDecoder().decode(body)) } catch { return json({ error: 'Invalid request' }, 400) }
        if (!payload || typeof payload.evidenceId !== 'string' || !uuid.test(payload.evidenceId)) return json({ error: 'Invalid request' }, 400)
        const result = await admin.from('incident_evidence').select('id,organization_id,incident_id,storage_path').eq('id', payload.evidenceId).maybeSingle()
        if (result.error) return json({ error: 'Evidence unavailable' }, 500)
        evidence = result.data
        if (!evidence) return json({ error: 'Evidence unavailable' }, 404)
        incidentId = evidence.incident_id
      } else return json({ error: 'Invalid request' }, 400)
      if (!uuid.test(incidentId)) return json({ error: 'Invalid request' }, 400)
      const { data: incident, error: incidentError } = await admin.from('incidents').select('organization_id,is_anonymous').eq('id', incidentId).maybeSingle()
      if (incidentError) return json({ error: 'Evidence unavailable' }, 500)
      if (!incident?.is_anonymous || (evidence && evidence.organization_id !== incident.organization_id)) return json({ error: 'Evidence unavailable' }, 404)
      const { data: allowed, error: accessError } = await caller.rpc('can_access_anonymous_evidence', {
        target_organization_id: incident.organization_id, target_incident_id: incidentId, for_upload: action !== 'download',
      })
      if (accessError) return json({ error: 'Evidence authorization unavailable' }, 500)
      if (allowed !== true) return json({ error: 'Evidence unavailable' }, 404)
      if (action === 'upload') {
        const mime = request.headers.get('x-evidence-type') || ''
        if (!mimePattern.test(mime)) return json({ error: 'Unsupported evidence file type' }, 400)
        const limit = (mime.startsWith('image/') ? 10 : mime.startsWith('video/') ? 100 : 15) * 1024 * 1024
        const bytes = await readFile(request, limit)
        if (!bytes) return json({ error: 'Invalid or oversized evidence file' }, 413)
        let cleaned = await sanitizeEvidence(bytes, mime)
        if (cleaned.bytes.length > limit) cleaned = { bytes, mimeType: mime, verified: false }
        const path = `${incident.organization_id}/${incidentId}/${crypto.randomUUID()}`
        const { error: uploadError } = await admin.storage.from(bucket).upload(path, cleaned.bytes, { contentType: cleaned.mimeType, upsert: false })
        if (uploadError) return json({ error: 'Unable to upload evidence' }, 500)
        const { data: saved, error: saveError } = await admin.rpc('record_anonymous_evidence', {
          target_incident_id: incidentId, target_organization_id: incident.organization_id,
          object_path: path, object_type: cleaned.mimeType, object_size: cleaned.bytes.length,
        }).single()
        if (saveError || !saved) {
          const { error: cleanupError } = await admin.storage.from(bucket).remove([path])
          if (cleanupError) console.error('Anonymous evidence cleanup failed')
          return json({ error: 'Unable to record evidence' }, 500)
        }
        return json({ evidence: saved, sanitization: cleaned.verified ? 'verified' : 'unverified' })
      }
      if (!evidence) return json({ error: 'Evidence unavailable' }, 404)
      if (action === 'download') {
        const { data, error } = await admin.storage.from(bucket).createSignedUrl(evidence.storage_path, 60)
        if (error || !data?.signedUrl) return json({ error: 'Unable to access evidence' }, 500)
        return json({ signedUrl: data.signedUrl })
      }
      const { error: removeError } = await admin.storage.from(bucket).remove([evidence.storage_path])
      if (removeError) return json({ error: 'Unable to remove evidence' }, 500)
      const { error: deleteError } = await admin.from('incident_evidence').delete().eq('id', evidence.id).eq('organization_id', evidence.organization_id)
      if (deleteError) return json({ error: 'Unable to remove evidence metadata' }, 500)
      return json({ success: true })
    } catch {
      console.error('Anonymous evidence request failed')
      return json({ error: 'Unable to process evidence' }, 500)
    }
  }
}
