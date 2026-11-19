import type { SupabaseClient } from '@supabase/supabase-js'

import { incidentDraftSchema, incidentEvidenceMetadataSchema, incidentSubmissionSchema } from './incidentSchemas'
import type { IncidentDetail, IncidentDraftInput, IncidentEvidence, IncidentListFilters, IncidentListScope, IncidentPerson, IncidentStatus, IncidentSummary, IncidentSubmissionInput } from './incidentTypes'
import { incidentReportTypes } from './incidentTypes'
import { incidentSeverityFilterPatterns, openIncidentStatuses } from '../../../supabase/functions/_shared/incidentReportFilters'

const defaultPageSize = 25
const megabyte = 1024 * 1024
const totalEvidenceLimit = 250 * megabyte
const photoLimit = 10 * megabyte
const videoLimit = 100 * megabyte
const documentLimit = 15 * megabyte

type OrganizationContext = {
  userId: string
  organizationId: string
}

type IncidentRow = {
  id: string
  organization_id: string
  reference_number: string
  report_type: IncidentSummary['reportType']
  status: IncidentStatus
  title: string
  description: string | null
  occurred_at: string | null
  reported_at: string | null
  site_id: string | null
  facility_id: string | null
  location: string | null
  department: string | null
  shift: string | null
  work_activity_context: string | null
  is_anonymous: boolean
  reported_by: string | null
  created_by: string | null
  contractor_involved: boolean
  contractor_organization: string | null
  severity: string | null
  potential_severity: string | null
  incident_category: string | null
  priority: string | null
  gps_coordinates: string | null
  weather_conditions: string | null
  equipment_involved: string | null
  people_involved: string | null
  witnesses: string | null
  potential_root_cause: string | null
  digital_signature: string | null
  accuracy_confirmed: boolean
  environmental_impact: boolean
  injury_or_illness: boolean
  property_damage: boolean
  work_related: boolean
  immediate_correction: string | null
  created_at: string
  updated_at: string
  draft_stage: number
}

type IncidentPersonRow = {
  id: string
  organization_id: string
  incident_id: string
  person_type: IncidentPerson['personType']
  profile_id: string | null
  full_name: string
  organization_name: string | null
  contact_details: string | null
  created_at: string
}

type IncidentEvidenceRow = {
  id: string
  organization_id: string
  incident_id: string
  storage_path: string
  original_filename: string
  mime_type: string
  file_size: number
  uploaded_by: string | null
  created_at: string
}

export type IncidentListResult = {
  items: IncidentSummary[]
  page: number
  pageSize: number
  total: number
}

export type IncidentActivity = {
  id: string
  activity: string
  metadata: Record<string, unknown>
  userId: string | null
  createdAt: string
  location: string | null
}

function toIncidentSummary(row: IncidentRow): IncidentSummary {
  const createdBy = row.is_anonymous ? 'Anonymous reporter' : row.created_by
  if (!createdBy) throw new Error('Incident reporter information is unavailable.')
  return {
    id: row.id,
    organizationId: row.organization_id,
    referenceNumber: row.reference_number,
    reportType: row.report_type,
    status: row.status,
    title: row.title,
    occurredAt: row.occurred_at,
    reportedAt: row.reported_at,
    siteId: row.site_id,
    facilityId: row.facility_id,
    location: row.location,
    department: row.department,
    shift: row.shift,
    severity: row.severity,
    potentialSeverity: row.potential_severity,
    incidentCategory: row.incident_category,
    siteName: null,
    isAnonymous: row.is_anonymous,
    createdBy,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toIncidentEvidence(row: IncidentEvidenceRow): IncidentEvidence {
  return {
    id: row.id,
    organizationId: row.organization_id,
    incidentId: row.incident_id,
    storagePath: row.storage_path,
    originalFilename: row.original_filename,
    mimeType: row.mime_type,
    fileSize: row.file_size,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  }
}

function toIncidentPerson(row: IncidentPersonRow): IncidentPerson {
  return {
    id: row.id,
    organizationId: row.organization_id,
    incidentId: row.incident_id,
    personType: row.person_type,
    profileId: row.profile_id,
    fullName: row.full_name,
    organizationName: row.organization_name,
    contactDetails: row.contact_details,
    createdAt: row.created_at,
  }
}

function escapeSearch(value: string) {
  return value.replace(/[%,().]/g, (character) => `\\${character}`)
}

export async function getOrganizationContext(client: SupabaseClient): Promise<OrganizationContext> {
  const { data: { user }, error: userError } = await client.auth.getUser()
  if (userError || !user) throw new Error('Your session is no longer valid.')

  const { data: profile, error: profileError } = await client
    .from('profiles')
    .select('organization_id')
    .eq('id', user.id)
    .single()
  if (profileError || !profile?.organization_id) throw new Error('Your account is not assigned to an organization.')

  const { data: membership, error: membershipError } = await client
    .from('memberships')
    .select('id')
    .eq('user_id', user.id)
    .eq('organization_id', profile.organization_id)
    .maybeSingle()
  if (membershipError || !membership) throw new Error('You do not have access to this organization.')

  return { userId: user.id, organizationId: profile.organization_id }
}

export async function getIncidents(client: SupabaseClient, filters: IncidentListFilters = {}, scope: IncidentListScope = 'organization'): Promise<IncidentListResult> {
  const context = await getOrganizationContext(client)
  const page = filters.page || 1
  const pageSize = filters.pageSize || defaultPageSize
  const from = (page - 1) * pageSize
  const to = from + pageSize - 1
  let query = (scope === 'own'
    ? client.rpc('get_my_incidents', undefined, { count: 'exact' })
    : client.from('incidents'))
    .select('id, organization_id, reference_number, report_type, status, title, description, occurred_at, reported_at, site_id, facility_id, location, department, shift, work_activity_context, is_anonymous, reported_by, created_by, contractor_involved, contractor_organization, severity, potential_severity, incident_category, environmental_impact, injury_or_illness, property_damage, work_related, immediate_correction, priority, gps_coordinates, weather_conditions, equipment_involved, people_involved, witnesses, potential_root_cause, digital_signature, accuracy_confirmed, draft_stage, created_at, updated_at', { count: 'exact' })
    .eq('organization_id', context.organizationId)
    .order('created_at', { ascending: false })
    .range(from, to)

  if (filters.incidentFilter === 'draft') {
    query = query.eq('status', 'draft')
    if (scope !== 'own') query = query.eq('created_by', context.userId)
  } else {
    if (scope !== 'own') query = query.neq('status', 'draft')
    if (filters.incidentFilter === 'submitted' || filters.incidentFilter === 'closed') query = query.eq('status', filters.incidentFilter)
  }

  if (filters.status === 'open') query = query.in('status', openIncidentStatuses())
  else if (filters.status && filters.status !== 'all') query = query.eq('status', filters.status)
  if (filters.reportType && filters.reportType !== 'all') query = query.eq('report_type', filters.reportType)
  if (filters.incidentCategory && filters.incidentCategory !== 'all') query = query.eq('incident_category', filters.incidentCategory)
  if (filters.severity && filters.severity !== 'all') {
    const patterns = incidentSeverityFilterPatterns(filters.severity)
    // Effective severity: match either the actual or the potential severity
    // column, matching Executive Analytics and the dashboard.
    const orPatterns = patterns.flatMap((pattern) => [`severity.ilike.${pattern}`, `potential_severity.ilike.${pattern}`])
    if (orPatterns.length) query = query.or(orPatterns.join(','))
  }
  if (filters.siteId && filters.siteId !== 'all') query = query.eq('site_id', filters.siteId)
  if (filters.department && filters.department !== 'all') query = query.eq('department', filters.department)
  if (filters.search) {
    const search = escapeSearch(filters.search)
    query = query.or(`reference_number.ilike.%${search}%,title.ilike.%${search}%,location.ilike.%${search}%`)
  }
  if (filters.dateFrom) query = query.gte('occurred_at', `${filters.dateFrom}T00:00:00.000Z`)
  if (filters.dateTo) query = query.lte('occurred_at', `${filters.dateTo}T23:59:59.999Z`)

  if (filters.incidentFilter === 'investigation' || filters.incidentFilter === 'corrective_action' || filters.incidentFilter === 'preventive_action') {
    let actionQuery = client.from('actions')
      .select('incident_id')
      .eq('organization_id', context.organizationId)
      .not('incident_id', 'is', null)
      .eq('type', filters.incidentFilter === 'corrective_action' ? 'corrective' : filters.incidentFilter === 'preventive_action' ? 'preventive' : 'investigation')
    actionQuery = actionQuery.order('incident_id')
    const linkedIncidentIds = new Set<string>()
    for (let offset = 0; ; offset += 500) {
      const { data: linkedActions, error: linkedActionsError } = await actionQuery.range(offset, offset + 499)
      if (linkedActionsError) throw new Error('Unable to filter incidents by their assigned actions.')
      for (const action of linkedActions || []) {
        if (action.incident_id) linkedIncidentIds.add(action.incident_id)
      }
      if (!linkedActions || linkedActions.length < 500) break
    }
    const incidentIds = [...linkedIncidentIds]
    if (!incidentIds.length) return { items: [], page, pageSize, total: 0 }
    query = query.in('id', incidentIds)
  }

  const { data, error, count } = await query
  if (error) throw new Error('Unable to load incident reports.')
  if (data !== null && !Array.isArray(data)) throw new Error('Invalid incident report response.')
  return { items: (data || []).map(toIncidentSummary), page, pageSize, total: count || 0 }
}

// Fetch every incident matching the current filters/scope (not just one page).
// Used by exports so a register always reflects the full filtered dataset.
// Pages at 500 to stay under PostgREST's row cap while reusing getIncidents, so
// all filter, scope, and RLS behaviour is identical to the table view.
export async function getAllMatchingIncidents(
  client: SupabaseClient,
  filters: IncidentListFilters = {},
  scope: IncidentListScope = 'organization',
): Promise<IncidentSummary[]> {
  const exportPageSize = 500
  const all: IncidentSummary[] = []
  for (let page = 1; ; page += 1) {
    const result = await getIncidents(client, { ...filters, page, pageSize: exportPageSize }, scope)
    all.push(...result.items)
    if (all.length >= result.total || result.items.length < exportPageSize) break
  }
  return all
}

// Counts per report type for the current filters, plus the status-closed total.
// Ignores the reportType filter itself so the split stays visible while one type
// is selected. Uses pageSize 1 count queries rather than loading every row.
export async function getIncidentTypeCounts(
  client: SupabaseClient,
  filters: IncidentListFilters = {},
  scope: IncidentListScope = 'organization',
): Promise<{ byType: Record<string, number>; open: number; closed: number }> {
  const base = { ...filters, page: 1, pageSize: 1 }
  const [typeEntries, openResult, closedResult] = await Promise.all([
    Promise.all(incidentReportTypes.map(async (reportType) => {
      const result = await getIncidents(client, { ...base, reportType }, scope)
      return [reportType, result.total] as const
    })),
    getIncidents(client, { ...base, status: 'open' }, scope),
    getIncidents(client, { ...base, status: 'closed' }, scope),
  ])
  return { byType: Object.fromEntries(typeEntries), open: openResult.total, closed: closedResult.total }
}

// Offline sync checks this organization-scoped server record before retrying a saved draft's submission.
export async function getIncidentSummary(client: SupabaseClient, incidentId: string): Promise<IncidentSummary> {
  const context = await getOrganizationContext(client)
  const { data, error } = await client
    .from('incidents')
    .select('*')
    .eq('id', incidentId)
    .eq('organization_id', context.organizationId)
    .single()
  if (error || !data) throw new Error('Incident report not found.')
  return toIncidentSummary(data as IncidentRow)
}

export async function getIncident(client: SupabaseClient, incidentId: string): Promise<IncidentDetail> {
  const context = await getOrganizationContext(client)
  const { data: visibleIncident, error: incidentError } = await client
    .from('incidents')
    .select('*')
    .eq('id', incidentId)
    .eq('organization_id', context.organizationId)
    .maybeSingle()
  if (incidentError) throw new Error('Unable to load the incident report.')
  let incident = visibleIncident
  if (!incident) {
    const { data, error } = await client.rpc('get_my_anonymous_draft', { p_incident_id: incidentId })
    if (error || !data || data.is_anonymous !== true || data.organization_id !== context.organizationId) throw new Error('Incident report not found.')
    incident = data
  }

  const [{ data: people, error: peopleError }, { data: evidence, error: evidenceError }] = await Promise.all([
    client.from('incident_people').select('*').eq('incident_id', incidentId).eq('organization_id', context.organizationId).order('created_at'),
    client.from('incident_evidence').select('*').eq('incident_id', incidentId).eq('organization_id', context.organizationId).order('created_at'),
  ])
  if (peopleError || evidenceError) throw new Error('Unable to load incident details.')

  return {
    ...toIncidentSummary(incident as IncidentRow),
    description: incident.description,
    workActivityContext: incident.work_activity_context,
    shift: incident.shift,
    reportedBy: incident.is_anonymous ? 'Anonymous reporter' : incident.reported_by,
    contractorInvolved: incident.contractor_involved,
    contractorOrganization: incident.contractor_organization,
    environmentalImpact: incident.environmental_impact,
    injuryOrIllness: incident.injury_or_illness,
    propertyDamage: incident.property_damage,
    workRelated: incident.work_related,
    immediateCorrection: incident.immediate_correction,
    priority: incident.priority,
    gpsCoordinates: incident.gps_coordinates,
    weatherConditions: incident.weather_conditions,
    equipmentInvolved: incident.equipment_involved,
    peopleInvolved: incident.people_involved,
    witnesses: incident.witnesses,
    potentialRootCause: incident.potential_root_cause,
    digitalSignature: incident.is_anonymous ? null : incident.digital_signature,
    accuracyConfirmed: incident.accuracy_confirmed,
    draftStage: incident.draft_stage,
    evidence: (evidence || []).map(toIncidentEvidence),
    people: (people || []).map(toIncidentPerson),
  }
}

// Translate the form's camelCase fields to database column names; empty optional values become SQL nulls.
function toIncidentPayload(input: IncidentDraftInput) {
  const contractorOrganization = input.contractorOrganization?.trim() || null
  return {
    report_type: input.reportType,
    draft_stage: input.draftStage ?? 0,
    title: input.title || 'Untitled draft',
    description: input.description || null,
    occurred_at: input.occurredAt || null,
    site_id: input.siteId || null,
    facility_id: input.facilityId || null,
    location: input.location || null,
    department: input.department || null,
    shift: input.shift || null,
    work_activity_context: input.workActivityContext || null,
    contractor_involved: Boolean(contractorOrganization),
    contractor_organization: contractorOrganization,
    severity: input.severity || null,
    potential_severity: input.potentialSeverity || null,
    incident_category: input.incidentCategory || null,
    environmental_impact: input.environmentalImpact || false,
    injury_or_illness: input.injuryOrIllness || false,
    property_damage: input.propertyDamage || false,
    work_related: input.workRelated ?? true,
    immediate_correction: input.immediateCorrection || null,
    priority: input.priority || null,
    gps_coordinates: input.gpsCoordinates || null,
    weather_conditions: input.weatherConditions || null,
    equipment_involved: input.equipmentInvolved || null,
    people_involved: input.peopleInvolved || null,
    witnesses: input.witnesses || null,
    potential_root_cause: input.potentialRootCause || null,
    digital_signature: input.digitalSignature || null,
    accuracy_confirmed: input.accuracyConfirmed || false,
  }
}

function normalizeContractorDetails<T extends IncidentDraftInput>(input: T): T {
  const contractorOrganization = input.contractorOrganization?.trim() || undefined
  return {
    ...input,
    contractorInvolved: Boolean(contractorOrganization),
    contractorOrganization,
  }
}

function normalizeSubmission(input: IncidentSubmissionInput): IncidentSubmissionInput {
  return {
    ...normalizeContractorDetails(input),
    title: input.title?.trim() || input.incidentCategory?.trim() || 'Incident',
    potentialSeverity: input.potentialSeverity || (input.reportType === 'near_miss' ? input.severity : undefined),
  }
}

// Offline sync supplies a stable clientSubmissionId so a retry can receive the draft created by an earlier attempt.
export async function createIncidentDraft(client: SupabaseClient, input: IncidentDraftInput, options: { clientSubmissionId?: string } = {}): Promise<IncidentSummary> {
  const normalizedInput = normalizeContractorDetails(input)
  const { data, error } = await client.rpc('save_incident_draft', {
    p_incident_id: null,
    p_input: normalizedInput,
    p_client_submission_id: options.clientSubmissionId || null,
  }).single()
  if (error || !data) throw new Error(error?.message || 'Unable to save the incident draft.')
  return toIncidentSummary(data as IncidentRow)
}

export function anonymousDraftInput(input: IncidentDraftInput): IncidentDraftInput {
  const { digitalSignature: _signature, ...withoutSignature } = input
  const validated = incidentDraftSchema.safeParse(withoutSignature)
  if (!validated.success) throw new Error(validated.error.issues[0]?.message || 'Draft is invalid.')
  return { ...validated.data, draftStage: input.draftStage }
}

export async function getAnonymousDraftOwnerToken(client: SupabaseClient): Promise<string> {
  const { data, error } = await client.rpc('anonymous_draft_owner_token')
  if (error || typeof data !== 'string' || !/^[0-9a-f]{64}$/.test(data)) throw new Error('Unable to authorize anonymous draft saving. Connect to the internet and try again.')
  return data
}

export async function saveAnonymousIncidentDraft(client: SupabaseClient, incidentId: string | null, input: IncidentDraftInput, clientSubmissionId: string, ownerToken: string): Promise<IncidentSummary> {
  const { data, error } = await client.rpc('save_my_anonymous_draft', {
    p_incident_id: incidentId,
    p_input: anonymousDraftInput(input),
    p_client_submission_id: clientSubmissionId,
    p_owner_token: ownerToken,
  })
  if (error || !data) throw new Error(error?.message || 'Unable to save the anonymous draft.')
  if (data.is_anonymous !== true || data.status !== 'draft' || data.reported_by != null || data.created_by != null || data.digital_signature != null) {
    throw new Error('The server returned an invalid anonymous draft.')
  }
  return toIncidentSummary(data as IncidentRow)
}

export async function submitAnonymousIncidentDraft(client: SupabaseClient, incidentId: string, input: IncidentSubmissionInput): Promise<{ id: string; referenceNumber: string }> {
  const validated = incidentSubmissionSchema.safeParse(normalizeSubmission({ ...input, digitalSignature: undefined }))
  if (!validated.success) throw new Error(validated.error.issues[0]?.message || 'Incident submission is invalid.')
  const { data, error } = await client.rpc('submit_my_anonymous_draft', { p_incident_id: incidentId, p_input: validated.data })
  if (error || !data) throw new Error(error?.message || 'Unable to submit the anonymous incident.')
  if (data.id !== incidentId || typeof data.referenceNumber !== 'string' || data.status !== 'submitted' || data.confirmation !== 'Anonymous reporter') {
    throw new Error('The server did not confirm the anonymous incident submission.')
  }
  return { id: data.id, referenceNumber: data.referenceNumber }
}

export async function updateIncidentDraft(client: SupabaseClient, incidentId: string, input: IncidentDraftInput): Promise<IncidentSummary> {
  const normalizedInput = normalizeContractorDetails(input)
  const { data, error } = await client.rpc('save_incident_draft', {
    p_incident_id: incidentId,
    p_input: normalizedInput,
    p_client_submission_id: null,
  }).single()
  if (error || !data) throw new Error(error?.message || 'Unable to update the incident draft.')
  return toIncidentSummary(data as IncidentRow)
}

// Submit an existing manual draft only after applying the stricter final-submission schema.
export async function submitIncident(client: SupabaseClient, incidentId: string, input: IncidentSubmissionInput): Promise<IncidentSummary> {
  const validated = incidentSubmissionSchema.safeParse(normalizeSubmission(input))
  if (!validated.success) throw new Error(validated.error.issues[0]?.message || 'Incident submission is invalid.')
  const context = await getOrganizationContext(client)
  const { data, error } = await client.from('incidents').update({ ...toIncidentPayload(validated.data), status: 'submitted', reported_at: new Date().toISOString() }).eq('id', incidentId).eq('organization_id', context.organizationId).eq('created_by', context.userId).eq('status', 'draft').select('*').single()
  if (error || !data) throw new Error(error?.message || 'Unable to submit the incident report.')
  await client.from('activity_logs').insert({ organization_id: context.organizationId, user_id: context.userId, activity: 'Incident submitted', metadata: { incident_id: incidentId, report_type: validated.data.reportType } })
  await client.from('activity_logs').insert({ organization_id: context.organizationId, user_id: context.userId, activity: 'Incident status changed', metadata: { incident_id: incidentId, from_status: 'draft', to_status: 'submitted' } })
  return toIncidentSummary(data as IncidentRow)
}

// A new online report with no saved draft is submitted directly through the database RPC.
export async function submitNewIncident(client: SupabaseClient, input: IncidentSubmissionInput): Promise<IncidentSummary> {
  const validated = incidentSubmissionSchema.safeParse(normalizeSubmission(input))
  if (!validated.success) throw new Error(validated.error.issues[0]?.message || 'Incident submission is invalid.')
  const { data, error } = await client.rpc('submit_new_incident', { p_input: validated.data }).single()
  if (error || !data) throw new Error(error?.message || 'Unable to submit the incident report.')
  return toIncidentSummary(data as IncidentRow)
}

export async function submitNewAnonymousIncident(client: SupabaseClient, input: IncidentSubmissionInput, submissionId: string): Promise<{ id: string; referenceNumber: string; status: string; confirmation: string }> {
  const validated = incidentSubmissionSchema.safeParse(normalizeSubmission({ ...input, digitalSignature: undefined }))
  if (!validated.success) throw new Error(validated.error.issues[0]?.message || 'Incident submission is invalid.')
  const { data, error } = await client.rpc('submit_new_anonymous_incident', { p_input: validated.data, p_client_submission_id: submissionId })
  if (error || !data) throw new Error(error?.message || 'Unable to submit the incident report.')
  if (typeof data.id !== 'string' || typeof data.referenceNumber !== 'string' || data.status !== 'submitted' || data.confirmation !== 'Anonymous reporter') {
    throw new Error('The server did not confirm the anonymous incident submission.')
  }
  return { id: data.id, referenceNumber: data.referenceNumber, status: data.status, confirmation: data.confirmation }
}

async function isAnonymousEvidenceIncident(client: SupabaseClient, incidentId: string, organizationId: string): Promise<boolean> {
  const { data, error } = await client.from('incidents').select('is_anonymous').eq('id', incidentId).eq('organization_id', organizationId).maybeSingle()
  if (error) throw new Error('Unable to verify incident evidence access.')
  if (data) {
    if (typeof data.is_anonymous !== 'boolean') throw new Error('Unable to verify incident evidence privacy.')
    return data.is_anonymous
  }
  const { data: investigationContext, error: investigationContextError } = await client.rpc(
    'get_investigation_evidence_context',
    { target_incident_id: incidentId },
  )
  if (!investigationContextError && investigationContext?.organization_id === organizationId
    && typeof investigationContext.is_anonymous === 'boolean') {
    return investigationContext.is_anonymous
  }
  const { data: context, error: contextError } = await client.rpc('anonymous_evidence_context', { target_incident_id: incidentId })
  if (contextError || context?.organizationId !== organizationId) throw new Error('Incident evidence is unavailable.')
  return true
}

// Check file type and size before uploading the object, then add its database metadata; remove the object if metadata insertion fails.
export async function uploadIncidentEvidence(client: SupabaseClient, incidentId: string, file: File): Promise<IncidentEvidence & { sanitization?: 'verified' | 'unverified' }> {
  const context = await getOrganizationContext(client)
  const anonymous = await isAnonymousEvidenceIncident(client, incidentId, context.organizationId)
  const metadata = incidentEvidenceMetadataSchema.safeParse({ incidentId, originalFilename: anonymous ? 'Evidence' : file.name, mimeType: file.type, fileSize: file.size })
  if (!metadata.success) throw new Error(metadata.error.issues[0]?.message || 'Evidence file is invalid.')
  const fileLimit = file.type.startsWith('image/') ? photoLimit : file.type.startsWith('video/') ? videoLimit : documentLimit
  const fileLimitLabel = file.type.startsWith('image/') ? '10 MB' : file.type.startsWith('video/') ? '100 MB' : '15 MB'
  if (file.size > fileLimit) throw new Error(`This file is too large. ${file.type.startsWith('image/') ? 'Photos' : file.type.startsWith('video/') ? 'Videos' : 'Documents'} must be ${fileLimitLabel} or smaller.`)
  const { data: existingEvidence, error: evidenceLookupError } = await client
    .from('incident_evidence')
    .select('file_size')
    .eq('incident_id', incidentId)
    .eq('organization_id', context.organizationId)
  if (evidenceLookupError) throw new Error('Unable to verify the incident attachment limit.')
  const existingTotal = (existingEvidence || []).reduce((total, evidence) => total + Number(evidence.file_size || 0), 0)
  if (existingTotal + file.size > totalEvidenceLimit) throw new Error('This upload would exceed the 250 MB total attachment limit for this incident.')
  if (anonymous) {
    const { data, error } = await client.functions.invoke<{ evidence: IncidentEvidenceRow; sanitization: 'verified' | 'unverified' }>('sanitize-anonymous-evidence', {
      body: new Blob([file], { type: 'application/octet-stream' }),
      headers: { 'x-evidence-action': 'upload', 'x-incident-id': incidentId, 'x-evidence-type': file.type },
      timeout: 150_000,
    })
    if (error || !data?.evidence || !['verified', 'unverified'].includes(data.sanitization)) throw new Error('Unable to upload incident evidence.')
    return { ...toIncidentEvidence(data.evidence), sanitization: data.sanitization }
  }
  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storagePath = `${context.organizationId}/${incidentId}/${context.userId}/${crypto.randomUUID()}-${safeFilename}`
  const { error: uploadError } = await client.storage.from('incident-evidence').upload(storagePath, file, { upsert: false, contentType: file.type })
  if (uploadError) throw new Error('Unable to upload incident evidence.')
  const { data, error } = await client.from('incident_evidence').insert({ organization_id: context.organizationId, incident_id: incidentId, storage_path: storagePath, original_filename: file.name, mime_type: file.type, file_size: file.size, uploaded_by: context.userId }).select('*').single()
  if (error || !data) {
    const { error: cleanupError } = await client.storage.from('incident-evidence').remove([storagePath])
    if (cleanupError) throw new Error('Unable to record incident evidence or remove the uploaded file.')
    throw new Error('Unable to record incident evidence.')
  }
  await client.from('activity_logs').insert({ organization_id: context.organizationId, user_id: context.userId, activity: 'Incident evidence uploaded', metadata: { incident_id: incidentId, evidence_id: data.id } })
  return toIncidentEvidence(data as IncidentEvidenceRow)
}

export async function uploadInvestigationEvidence(client: SupabaseClient, incidentId: string, file: File): Promise<IncidentEvidence> {
  const context = await getOrganizationContext(client)
  const { data: investigationContext, error: contextError } = await client.rpc(
    'get_investigation_evidence_context',
    { target_incident_id: incidentId },
  )
  if (contextError || investigationContext?.organization_id !== context.organizationId) {
    throw new Error('Investigation evidence is unavailable.')
  }

  const metadata = incidentEvidenceMetadataSchema.safeParse({
    incidentId,
    originalFilename: file.name,
    mimeType: file.type,
    fileSize: file.size,
  })
  if (!metadata.success) throw new Error(metadata.error.issues[0]?.message || 'Investigation evidence is invalid.')
  if (file.size > documentLimit) throw new Error('Investigation documents must be 15 MB or smaller.')

  const { data: existingEvidence, error: evidenceLookupError } = await client
    .from('incident_evidence')
    .select('file_size')
    .eq('incident_id', incidentId)
    .eq('organization_id', context.organizationId)
  if (evidenceLookupError) throw new Error('Unable to verify the investigation attachment limit.')
  const existingTotal = (existingEvidence || []).reduce((total, evidence) => total + Number(evidence.file_size || 0), 0)
  if (existingTotal + file.size > totalEvidenceLimit) {
    throw new Error('This upload would exceed the 250 MB total attachment limit for this incident.')
  }

  const safeFilename = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
  const storagePath = investigationContext.is_anonymous
    ? `${context.organizationId}/${incidentId}/${crypto.randomUUID()}`
    : `${context.organizationId}/${incidentId}/${context.userId}/${crypto.randomUUID()}-${safeFilename}`
  const { error: uploadError } = await client.storage.from('incident-evidence').upload(storagePath, file, {
    upsert: false,
    contentType: file.type,
  })
  if (uploadError) throw new Error('Unable to upload investigation evidence.')

  const { data, error } = await client.from('incident_evidence').insert({
    organization_id: context.organizationId,
    incident_id: incidentId,
    storage_path: storagePath,
    original_filename: file.name,
    mime_type: file.type,
    file_size: file.size,
    uploaded_by: context.userId,
  }).select('*').single()
  if (error || !data) {
    const { error: cleanupError } = await client.storage.from('incident-evidence').remove([storagePath])
    if (cleanupError) throw new Error('Unable to record investigation evidence or remove the uploaded file.')
    throw new Error('Unable to record investigation evidence.')
  }
  await client.from('activity_logs').insert({
    organization_id: context.organizationId,
    user_id: context.userId,
    activity: 'Investigation evidence uploaded',
    metadata: { incident_id: incidentId, evidence_id: data.id },
  })
  return toIncidentEvidence(data as IncidentEvidenceRow)
}

export async function deleteIncidentEvidence(client: SupabaseClient, evidenceId: string): Promise<void> {
  const context = await getOrganizationContext(client)
  const { data: evidence, error: evidenceError } = await client.from('incident_evidence').select('id, incident_id, storage_path').eq('id', evidenceId).eq('organization_id', context.organizationId).single()
  if (evidenceError || !evidence) throw new Error('Evidence not found.')
  const anonymous = await isAnonymousEvidenceIncident(client, evidence.incident_id, context.organizationId)
  if (anonymous) {
    const { data, error } = await client.functions.invoke<{ success: boolean }>('sanitize-anonymous-evidence', {
      body: { evidenceId }, headers: { 'x-evidence-action': 'delete' },
    })
    if (error || !data?.success) throw new Error('Unable to remove evidence.')
    return
  }
  // Storage and metadata are separate operations: if the row delete fails after this succeeds, its file reference is stale.
  const { error: storageError } = await client.storage.from('incident-evidence').remove([evidence.storage_path])
  if (storageError) throw new Error('Unable to remove evidence file.')
  const { error: deleteError } = await client.from('incident_evidence').delete().eq('id', evidenceId).eq('organization_id', context.organizationId)
  if (deleteError) throw new Error('Unable to remove evidence metadata.')
  await client.from('activity_logs').insert({ organization_id: context.organizationId, user_id: context.userId, activity: 'Incident evidence removed', metadata: { incident_id: evidence.incident_id, evidence_id: evidenceId } })
}

export async function downloadIncidentEvidence(client: SupabaseClient, evidenceId: string): Promise<{ blob: Blob; filename: string }> {
  const context = await getOrganizationContext(client)
  const { data: evidence, error: evidenceError } = await client
    .from('incident_evidence')
    .select('storage_path, original_filename, incident_id')
    .eq('id', evidenceId)
    .eq('organization_id', context.organizationId)
    .single()
  if (evidenceError || !evidence) throw new Error('Evidence not found or unavailable.')
  const anonymous = await isAnonymousEvidenceIncident(client, evidence.incident_id, context.organizationId)
  if (anonymous) {
    const { data: signed, error: signedError } = await client.functions.invoke<{ signedUrl: string }>('sanitize-anonymous-evidence', {
      body: { evidenceId }, headers: { 'x-evidence-action': 'download' },
    })
    if (signedError || !signed?.signedUrl) throw new Error('Unable to access evidence.')
    const response = await fetch(signed.signedUrl)
    if (!response.ok) throw new Error('Unable to download evidence.')
    return { blob: await response.blob(), filename: evidence.original_filename }
  }
  const { data, error: downloadError } = await client.storage.from('incident-evidence').download(evidence.storage_path)
  if (downloadError || !data) throw new Error('Unable to download evidence.')
  await client.from('activity_logs').insert({ organization_id: context.organizationId, user_id: context.userId, activity: 'Incident evidence downloaded', metadata: { incident_id: evidence.incident_id, evidence_id: evidenceId } })
  return { blob: data, filename: evidence.original_filename }
}

export async function getIncidentEvidence(client: SupabaseClient, incidentId: string): Promise<IncidentEvidence[]> {
  const context = await getOrganizationContext(client)
  const { data, error } = await client.from('incident_evidence').select('*').eq('incident_id', incidentId).eq('organization_id', context.organizationId).order('created_at')
  if (error) throw new Error('Unable to load incident evidence.')
  return (data || []).map(toIncidentEvidence)
}

export async function getIncidentActivity(client: SupabaseClient, incidentId: string): Promise<IncidentActivity[]> {
  const context = await getOrganizationContext(client)
  const { data, error } = await client.from('activity_logs').select('id, activity, metadata, user_id, created_at, location').eq('organization_id', context.organizationId).contains('metadata', { incident_id: incidentId }).order('created_at', { ascending: false }).limit(100)
  if (error) throw new Error('Unable to load incident activity.')
  return (data || []).map((item) => ({ id: item.id, activity: item.activity, metadata: item.metadata as Record<string, unknown>, userId: item.user_id, createdAt: item.created_at, location: item.location }))
}
