import type { SupabaseClient } from '@supabase/supabase-js'

import { getOrganizationContext } from '../incidents/incidentService'

const maxUploadSize = 10 * 1024 * 1024
const allowedUploadTypes = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
const bucket = 'incident-evidence'

export type QhseSite = { id: string; name: string }
export type QhsePerson = { id: string; full_name: string }
export type EligibleIncident = { id: string; reference_number: string; title: string; status: string; is_anonymous: boolean }
export type ActionType = 'preventive' | 'corrective' | 'investigation'
export type InspectionRecord = {
  id: string
  site_id: string
  inspection_title: string
  description: string
  findings: string
  inspection_date: string
  file_storage_path: string | null
  file_name: string | null
  created_at: string
  inspected_by: string
}
export type ActionRecord = {
  id: string
  type: 'preventive' | 'corrective' | 'investigation'
  incident_id: string | null
  description: string
  site_id: string
  assignee_id: string
  created_by: string
  due_at: string
  assigned_at: string
  status: 'open' | 'resolved'
  resolved_at: string | null
  resolved_by: string | null
  resolution_notes: string | null
  proof_storage_path: string | null
  proof_file_name: string | null
  created_at: string
}

export function validateQhseFile(file?: File | null) {
  if (!file) return
  if (!allowedUploadTypes.includes(file.type)) throw new Error('Choose a JPG, PNG, WebP, or PDF file.')
  if (file.size <= 0 || file.size > maxUploadSize) throw new Error('Files must be smaller than 10 MB.')
}

function storageFilename(file: File) {
  return `${crypto.randomUUID()}-${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
}

function activeConfiguredSiteNames(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (typeof entry === 'string') return entry.trim() ? [entry.trim().toLowerCase()] : []
    if (!entry || typeof entry !== 'object') return []
    const item = entry as { name?: unknown; active?: unknown; deleted?: unknown }
    return typeof item.name === 'string' && item.name.trim() && item.active !== false && item.deleted !== true
      ? [item.name.trim().toLowerCase()]
      : []
  })
}

async function storeFile(client: SupabaseClient, path: string, file: File) {
  const { error } = await client.storage.from(bucket).upload(path, file, { upsert: false, contentType: file.type })
  if (error) throw new Error('Unable to upload the file.')
}

export async function getInspectionWorkspace(client: SupabaseClient) {
  const context = await getOrganizationContext(client)
  const [
    { data: sites, error: sitesError },
    { data: inspections, error: inspectionsError },
    { data: people, error: peopleError },
    { data: settings, error: settingsError },
  ] = await Promise.all([
    client.from('sites').select('id, name').eq('organization_id', context.organizationId).order('name'),
    client.from('inspections').select('*').eq('organization_id', context.organizationId).order('inspection_date', { ascending: false }).limit(100),
    client.from('profiles').select('id, full_name').eq('organization_id', context.organizationId),
    client.from('company_settings').select('operational_sites').eq('organization_id', context.organizationId).maybeSingle(),
  ])
  if (sitesError || inspectionsError || peopleError || settingsError) throw new Error('Unable to load inspection records and organization details.')
  const allSites = (sites || []) as QhseSite[]
  const activeSiteNames = activeConfiguredSiteNames(settings?.operational_sites)
  const activeSites = allSites.filter((site) => activeSiteNames.includes(site.name.trim().toLowerCase()))
  return { ...context, sites: allSites, activeSites, inspections: (inspections || []) as InspectionRecord[], people: (people || []) as QhsePerson[] }
}

export async function createInspection(client: SupabaseClient, input: {
  siteId: string
  title: string
  description: string
  findings: string
  inspectionDate: string
  file?: File | null
}) {
  const context = await getOrganizationContext(client)
  validateQhseFile(input.file)
  const inspectionDate = new Date(input.inspectionDate)
  if (!input.siteId || !input.title.trim() || !input.description.trim() || !input.findings.trim() || Number.isNaN(inspectionDate.getTime())) {
    throw new Error('Complete all required inspection fields with a valid inspection date.')
  }
  const { data: inspection, error } = await client.from('inspections').insert({
    organization_id: context.organizationId,
    site_id: input.siteId,
    inspection_title: input.title.trim(),
    description: input.description.trim(),
    findings: input.findings.trim(),
    inspected_by: context.userId,
    inspection_date: inspectionDate.toISOString(),
  }).select('*').single()
  if (error || !inspection) throw new Error(error?.message || 'Unable to save the inspection.')

  let uploadWarning = ''
  if (input.file) {
    const path = `${context.organizationId}/inspections/${inspection.id}/${context.userId}/${storageFilename(input.file)}`
    try {
      await storeFile(client, path, input.file)
      const { error: metadataError } = await client.from('inspections').update({
        file_storage_path: path,
        file_name: input.file.name,
        file_type: input.file.type,
        file_size: input.file.size,
      }).eq('id', inspection.id).eq('organization_id', context.organizationId)
      if (metadataError) throw metadataError
    } catch {
      await client.storage.from(bucket).remove([path])
      uploadWarning = 'Inspection saved, but the optional file could not be attached.'
    }
  }
  return { uploadWarning }
}

export async function getActionsWorkspace(client: SupabaseClient, assignedOnly = false, includeOrganizationActions = false) {
  const context = await getOrganizationContext(client)
  let actionsQuery = client.from('actions').select('*').eq('organization_id', context.organizationId).order('due_at')
  if (assignedOnly && !includeOrganizationActions) actionsQuery = actionsQuery.eq('assignee_id', context.userId)
  const [
    { data: actions, error: actionsError },
    { data: sites, error: sitesError },
    { data: people, error: peopleError },
    { data: settings, error: settingsError },
  ] = await Promise.all([
    actionsQuery,
    client.from('sites').select('id, name').eq('organization_id', context.organizationId).order('name'),
    client.from('profiles').select('id, full_name').eq('organization_id', context.organizationId).eq('account_status', 'active').order('full_name'),
    client.from('company_settings').select('operational_sites').eq('organization_id', context.organizationId).maybeSingle(),
  ])
  if (actionsError || sitesError || peopleError || settingsError) throw new Error('Unable to load organization actions.')
  const allSites = (sites || []) as QhseSite[]
  const activeSiteNames = activeConfiguredSiteNames(settings?.operational_sites)
  const activeSites = allSites.filter((site) => activeSiteNames.includes(site.name.trim().toLowerCase()))
  const incidentRows: EligibleIncident[] = []
  if (!assignedOnly) {
    for (let offset = 0; ; offset += 500) {
      const { data: page, error: incidentError } = await client.from('incidents')
        .select('id, reference_number, title, status, is_anonymous')
        .eq('organization_id', context.organizationId)
        .in('status', ['submitted', 'under_review', 'investigation', 'corrective_action', 'pending_verification'])
        .order('created_at', { ascending: false })
        .range(offset, offset + 499)
      if (incidentError) throw new Error('Unable to load eligible incidents for action assignment.')
      incidentRows.push(...(page || []) as EligibleIncident[])
      if (!page || page.length < 500) break
    }
  }
  const linkedIncidentIds = [...new Set((actions || [])
    .map((action) => (action as ActionRecord).incident_id)
    .filter((incidentId): incidentId is string => Boolean(incidentId)))]
  const eligibleIncidents = incidentRows
  let linkedIncidents: EligibleIncident[] = []
  if (linkedIncidentIds.length) {
    const { data: linkedRows, error: linkedIncidentsError } = await client.from('incidents')
      .select('id, reference_number, title, status, is_anonymous')
      .eq('organization_id', context.organizationId)
      .in('id', linkedIncidentIds)
    if (linkedIncidentsError) throw new Error('Unable to load linked incident references for actions.')
    linkedIncidents = (linkedRows || []) as EligibleIncident[]
  }
  return {
    ...context,
    actions: (actions || []) as ActionRecord[],
    sites: allSites,
    activeSites,
    people: (people || []) as QhsePerson[],
    eligibleIncidents,
    linkedIncidents,
  }
}

export async function createAction(client: SupabaseClient, input: { type: ActionType; description: string; siteId: string; assigneeId: string; dueAt: string; incidentId?: string | null }) {
  const context = await getOrganizationContext(client)
  const dueDate = new Date(input.dueAt)
  if (!input.type || !input.description.trim() || !input.siteId || !input.assigneeId || Number.isNaN(dueDate.getTime()) || dueDate.getTime() <= Date.now()) {
    throw new Error('Enter an action, site, assignee, and a future due date and time.')
  }
  const { data: action, error } = await client.from('actions').insert({
    organization_id: context.organizationId,
    type: input.type,
    description: input.description.trim(),
    site_id: input.siteId,
    assignee_id: input.assigneeId,
    created_by: context.userId,
    due_at: dueDate.toISOString(),
    status: 'open',
    incident_id: input.incidentId || null,
  }).select('id').single()
  if (error) throw new Error(error.message || 'Unable to create the action.')
  if (!action) throw new Error('The action could not be saved.')
  const notificationResult = await notifyActionAssignment(client, action.id)
  return { ...notificationResult, actionId: action.id }
}

async function notifyActionAssignment(client: SupabaseClient, actionId: string) {
  const { data, error } = await client.functions.invoke('action-assignment-notification', { body: { actionId } })
  return {
    notificationWarning: error || !data?.emailSent
      ? 'The action was saved, but its email notification could not be confirmed.'
      : '',
  }
}

export type LinkedIncidentAction = Omit<Pick<ActionRecord, 'id' | 'incident_id' | 'type' | 'description' | 'assignee_id' | 'due_at' | 'status' | 'assigned_at' | 'resolved_at' | 'resolved_by'>, 'assignee_id'> & {
  assignee_id: string | null
}

export async function getVerifierIncidentActions(client: SupabaseClient, incidentId: string): Promise<LinkedIncidentAction[]> {
  const { data, error } = await client.rpc('get_verifier_incident_actions', { target_incident_id: incidentId })
  if (error) throw new Error('Unable to load actions linked to this incident.')
  return (data || []) as LinkedIncidentAction[]
}

export async function getActionsForIncidents(client: SupabaseClient, organizationId: string, incidentIds: string[]) {
  if (!incidentIds.length) return [] as LinkedIncidentAction[]
  const { data, error } = await client.from('actions')
    .select('id, incident_id, type, description, assignee_id, due_at, status, assigned_at, resolved_at, resolved_by')
    .eq('organization_id', organizationId)
    .in('incident_id', incidentIds)
    .order('assigned_at', { ascending: false })
  if (error) throw new Error('Unable to load actions linked to these incidents.')
  return (data || []) as LinkedIncidentAction[]
}

export async function reassignAction(client: SupabaseClient, actionId: string, assigneeId: string) {
  const context = await getOrganizationContext(client)
  const { data, error } = await client.from('actions').update({ assignee_id: assigneeId })
    .eq('id', actionId).eq('organization_id', context.organizationId).eq('status', 'open').select('id').maybeSingle()
  if (error || !data) throw new Error(error?.message || 'This action is no longer open and could not be reassigned.')
  return notifyActionAssignment(client, data.id)
}

export async function resolveAction(client: SupabaseClient, action: ActionRecord, notes: string, file?: File | null) {
  const context = await getOrganizationContext(client)
  if (!notes.trim()) throw new Error('Enter resolution details before resolving this action.')
  if (!file) throw new Error('Upload a photo or document as resolution evidence.')
  validateQhseFile(file)
  let path: string | null = null
  path = `${context.organizationId}/actions/${action.id}/${context.userId}/${storageFilename(file)}`
  await storeFile(client, path, file)
  const { data, error } = await client.from('actions').update({
    status: 'resolved',
    resolution_notes: notes.trim(),
    proof_storage_path: path,
    proof_file_name: file.name,
    proof_file_type: file.type,
    proof_file_size: file.size,
  }).eq('id', action.id).eq('organization_id', context.organizationId).eq('status', 'open').select('id').maybeSingle()
  if (error || !data) {
    if (path) await client.storage.from(bucket).remove([path])
    throw new Error(error?.message || 'This action is no longer open and could not be resolved.')
  }
}

export async function downloadQhseFile(client: SupabaseClient, path: string, filename: string) {
  const { data, error } = await client.storage.from(bucket).download(path)
  if (error || !data) throw new Error('Unable to download this file.')
  const url = URL.createObjectURL(data)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  link.click()
  URL.revokeObjectURL(url)
}