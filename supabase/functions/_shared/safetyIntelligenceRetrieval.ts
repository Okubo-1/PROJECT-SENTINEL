import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { AiAccessContext } from '../ai-service/access.ts'
import {
  safetyActionSchema, safetyCauseSchema, safetyClosureSchema, safetyFacilitySchema,
  safetyFindingSchema, safetyIncidentSchema, safetyInvestigationSchema, safetyNewActionSchema, safetySiteSchema,
  safetyCompanySettingsSchema, isExcludedSyntheticSafetyIncident,
  type SafetyCoverage, type SafetyDataset, type SafetyFilters, type SafetyScope,
} from './safetyIntelligenceContracts.ts'
import { isDraftIncidentStatus, matchesIncidentSeverity, normalizeIncidentReportType, normalizeIncidentStatus } from './incidentReportFilters.ts'

export class SafetyRetrievalError extends Error {
  constructor() {
    super('Unable to retrieve authorized operational data.')
    this.name = 'SafetyRetrievalError'
  }
}

async function canReadOrganizationIncidents(client: SupabaseClient, context: AiAccessContext) {
  const [permissionResult, closureResult] = await Promise.all([
    client.rpc('has_org_permission', {
      p_organization_id: context.organizationId,
      p_permission: 'view_all_incidents',
    }),
    client.rpc('can_close_incidents', { target_organization_id: context.organizationId }),
  ])
  if (permissionResult.error || typeof permissionResult.data !== 'boolean'
    || closureResult.error || typeof closureResult.data !== 'boolean') {
    throw new SafetyRetrievalError()
  }
  return permissionResult.data || closureResult.data
}

export async function resolveSafetyScope(client: SupabaseClient, context: AiAccessContext, filters: SafetyFilters): Promise<SafetyScope> {
  const canReadOrganization = await canReadOrganizationIncidents(client, context)
  return {
    userId: context.userId, organizationId: context.organizationId,
    visibility: canReadOrganization ? 'organization' : 'personal',
    ...(filters.siteId ? { siteId: filters.siteId } : {}),
    siteAssignmentEnforced: false,
  }
}

type ReadLimits = { pageSize: number; maxRows: number }
const defaultLimits: ReadLimits = { pageSize: 500, maxRows: 10_000 }

async function readPages<T>(
  client: SupabaseClient, organizationId: string, table: string, columns: string,
  schema: z.ZodType<T>, key: string, limits: ReadLimits, omitDrafts = false,
) {
  const rows: T[] = []
  let after: string | undefined
  while (true) {
    // Keyset pagination avoids offset shifts and probes past the cap instead of assuming completeness.
    const size = Math.min(limits.pageSize, limits.maxRows - rows.length + 1)
    let query = client.from(table).select(columns).eq('organization_id', organizationId)
      .order(key, { ascending: true }).limit(size)
    if (after) query = query.gt(key, after)
    if (omitDrafts) query = query.neq('status', 'draft')
    const { data, error } = await query
    if (error) throw new SafetyRetrievalError()
    const parsed = z.array(schema).safeParse(data)
    if (!parsed.success) throw new SafetyRetrievalError()
    const page = parsed.data
    // Validate the cursor independently without casting the schema's generic row type.
    const cursors = z.array(z.object({ [key]: z.uuid() })).safeParse(data)
    if (!cursors.success) throw new SafetyRetrievalError()
    let previous = after
    for (const row of cursors.data) {
      if (previous && row[key] <= previous) throw new SafetyRetrievalError()
      previous = row[key]
    }
    const remaining = limits.maxRows - rows.length
    rows.push(...page.slice(0, remaining))
    if (page.length > remaining) return { rows, complete: false }
    if (page.length < size) return { rows, complete: true }
    after = previous
  }
}

export async function retrieveSafetyDataset(
  client: SupabaseClient, context: AiAccessContext, filters: SafetyFilters,
  limits: ReadLimits = defaultLimits,
): Promise<SafetyDataset> {
  if (!Number.isInteger(limits.pageSize) || limits.pageSize < 1 || limits.pageSize > 500
    || !Number.isInteger(limits.maxRows) || limits.maxRows < 1) throw new SafetyRetrievalError()
  const org = context.organizationId
  const canReadOrganization = await canReadOrganizationIncidents(client, context)
  // Only the caller's anon-key/token client is accepted. No privileged client is created here.
  const [incidents, legacyActions, newActions, investigations, causes, findings, closures, sites, facilities, settingsResult] = await Promise.all([
    readPages(client, org, 'incidents', 'id,organization_id,reference_number,title,report_type,status,occurred_at,reported_at,updated_at,site_id,facility_id,department,shift,severity,potential_severity,incident_category,client_submission_id,digital_signature,is_anonymous', safetyIncidentSchema, 'id', limits, true),
    readPages(client, org, 'corrective_actions', 'id,organization_id,incident_id,title,status,due_date', safetyActionSchema, 'id', limits),
    readPages(client, org, 'actions', 'id,organization_id,incident_id,description,type,status,due_at', safetyNewActionSchema, 'id', limits),
    readPages(client, org, 'investigations', 'id,organization_id,incident_id,status,completed_at,findings_summary', safetyInvestigationSchema, 'id', limits),
    readPages(client, org, 'investigation_root_causes', 'id,organization_id,investigation_id,root_cause_statement,cause_category', safetyCauseSchema, 'id', limits),
    readPages(client, org, 'investigation_findings', 'id,organization_id,investigation_id,description,finding_type', safetyFindingSchema, 'id', limits),
    readPages(client, org, 'incident_closures', 'incident_id,organization_id,closed_at,root_cause,corrective_action', safetyClosureSchema, 'incident_id', limits),
    readPages(client, org, 'sites', 'id,organization_id,name', safetySiteSchema, 'id', limits),
    readPages(client, org, 'facilities', 'id,organization_id,site_id,name', safetyFacilitySchema, 'id', limits),
    client.from('company_settings').select('organization_id,operational_sites,departments,severity_levels,incident_categories')
      .eq('organization_id', org).maybeSingle(),
  ])
  if (settingsResult.error) throw new SafetyRetrievalError()
  const settings = safetyCompanySettingsSchema.nullable().safeParse(settingsResult.data)
  if (!settings.success || (settings.data && settings.data.organization_id !== org)) throw new SafetyRetrievalError()
  // Union the live Actions module (corrective + preventive) with the legacy
  // corrective_actions table so historical and current actions are both counted.
  const actions = {
    rows: [
      ...legacyActions.rows.map((row) => ({
        ...row, type: row.type ?? 'corrective', source: row.source ?? 'corrective_actions',
      })),
      ...newActions.rows.map((row) => ({
        id: row.id, organization_id: row.organization_id, incident_id: row.incident_id,
        title: row.description, status: row.status,
        due_date: row.due_at ? row.due_at.slice(0, 10) : null,
        type: row.type, source: 'actions',
      })),
    ],
    complete: legacyActions.complete && newActions.complete,
  }
  const pages = { incidents, actions, investigations, causes, findings, closures, sites, facilities }
  // An organization-filter/RLS regression must fail, not silently turn foreign records into evidence.
  for (const page of Object.values(pages)) {
    if (page.rows.some((row) => row.organization_id !== org)) throw new SafetyRetrievalError()
  }
  const matchesIncidentFilters = (row: SafetyDataset['rows']['incidents'][number]) => {
    if (filters.department && row.department !== filters.department) return false
    if (filters.shift && row.shift !== filters.shift) return false
    if (filters.status && filters.status !== 'all'
      && normalizeIncidentStatus(row.status) !== normalizeIncidentStatus(filters.status)) return false
    if (filters.severity && filters.severity !== 'all'
      && !matchesIncidentSeverity(row.severity, filters.severity)
      && !matchesIncidentSeverity(row.potential_severity, filters.severity)) return false
    if (filters.reportType && filters.reportType !== 'all'
      && normalizeIncidentReportType(row.report_type) !== normalizeIncidentReportType(filters.reportType)) return false
    return true
  }
  const anonymousIds = new Set(incidents.rows.filter((row) => row.is_anonymous).map((row) => row.id))
  const safeIncident = (row: SafetyDataset['rows']['incidents'][number]) => row.is_anonymous
    ? { ...row, title: 'Anonymous incident', client_submission_id: null, digital_signature: null }
    : row
  const scopedIncidents = incidents.rows
    .filter((row) => !isDraftIncidentStatus(row.status))
    .map(safeIncident)
    .filter((row) => !filters.siteId || row.site_id === filters.siteId)
    .filter(matchesIncidentFilters)
  const syntheticCount = scopedIncidents.filter(isExcludedSyntheticSafetyIncident).length
  const visiblePlanningIncidents = scopedIncidents.filter((row) => !isExcludedSyntheticSafetyIncident(row))
  const visibleIncidents = visiblePlanningIncidents.filter((row) => !isDraftIncidentStatus(row.status))
  const incidentIds = new Set(visibleIncidents.map((row) => row.id))
  const planningIncidentIds = new Set(visiblePlanningIncidents.map((row) => row.id))
  const visibleInvestigations = investigations.rows.filter((row) => incidentIds.has(row.incident_id))
    .map((row) => anonymousIds.has(row.incident_id) ? { ...row, findings_summary: null } : row)
  const investigationIds = new Set(visibleInvestigations.map((row) => row.id))
  const anonymousInvestigationIds = new Set(visibleInvestigations.filter((row) => anonymousIds.has(row.incident_id)).map((row) => row.id))
  const siteIds = new Set(visibleIncidents.map((row) => row.site_id))
  const planningSiteIds = new Set(visiblePlanningIncidents.map((row) => row.site_id))
  const facilityIds = new Set(visibleIncidents.map((row) => row.facility_id))
  // An assigned action/investigation may be readable while its parent incident is not.
  // Intersect both permissions before any such data can enter shared/model context.
  const rows = {
    incidents: visibleIncidents,
    actions: actions.rows.filter((row) => row.incident_id !== null && incidentIds.has(row.incident_id))
      .map((row) => row.incident_id && anonymousIds.has(row.incident_id) ? { ...row, title: 'Anonymous incident action' } : row),
    investigations: visibleInvestigations,
    causes: causes.rows.filter((row) => investigationIds.has(row.investigation_id))
      .map((row) => anonymousInvestigationIds.has(row.investigation_id) ? { ...row, root_cause_statement: '', cause_category: null } : row),
    findings: findings.rows.filter((row) => investigationIds.has(row.investigation_id))
      .map((row) => anonymousInvestigationIds.has(row.investigation_id) ? { ...row, description: '', finding_type: null } : row),
    closures: closures.rows.filter((row) => incidentIds.has(row.incident_id))
      .map((row) => anonymousIds.has(row.incident_id) ? { ...row, root_cause: '', corrective_action: '' } : row),
    sites: sites.rows.filter((row) => siteIds.has(row.id)),
    facilities: facilities.rows.filter((row) => facilityIds.has(row.id)
      && (!filters.siteId || row.site_id === filters.siteId)),
  }
  const planningActions = actions.rows.filter((row) => row.incident_id !== null && planningIncidentIds.has(row.incident_id))
    .map((row) => row.incident_id && anonymousIds.has(row.incident_id) ? { ...row, title: 'Anonymous incident action' } : row)
  const coverage: SafetyCoverage[] = (Object.keys(pages) as Array<keyof typeof pages>).map((source) => ({
    source, retrieved: source === 'incidents' ? scopedIncidents.length : rows[source].length, included: rows[source].length,
    complete: pages[source].complete,
    access: canReadOrganization ? 'organization' : 'caller_visible',
    reasons: [
      ...(pages[source].complete ? [] : ['Authorized source exceeded the retrieval limit.']),
      ...(source === 'incidents' && syntheticCount ? [`${syntheticCount} confirmed synthetic incident records are excluded from operational analytics.`] : []),
    ],
  }))
  const planningSites = sites.rows.filter((row) => planningSiteIds.has(row.id))
  return { rows, incidentList: scopedIncidents, planningIncidents: visiblePlanningIncidents, planningActions, planningSites, coverage, companySettings: settings.data }
}
