import { z } from 'zod'

import { incidentReportTypes, incidentSeverities, incidentStatuses } from './incidentTypes'

const optionalText = z.string().trim().optional()
const uuid = z.string().uuid()

// Draft fields stay optional so a user can save an incomplete report and return to it later.
const incidentDraftFields = z.object({
  reportType: z.enum(incidentReportTypes),
  title: z.string().trim().max(240, 'Title must be 240 characters or fewer.').optional(),
  description: z.string().trim().max(10000, 'Description must be 10,000 characters or fewer.').optional(),
  occurredAt: z.string().datetime({ offset: true }).optional(),
  siteId: uuid.optional(),
  facilityId: uuid.optional(),
  location: optionalText,
  department: optionalText,
  shift: z.string().trim().max(120).optional(),
  workActivityContext: z.string().trim().max(2000).optional(),
  severity: z.string().trim().max(80).optional(),
  potentialSeverity: z.string().trim().max(80).optional(),
  incidentCategory: z.string().trim().max(120).optional(),
  contractorInvolved: z.boolean().optional(),
  contractorOrganization: z.string().trim().max(240).optional(),
  environmentalImpact: z.boolean().optional(),
  injuryOrIllness: z.boolean().optional(),
  propertyDamage: z.boolean().optional(),
  workRelated: z.boolean().optional(),
  immediateCorrection: z.string().trim().max(5000).optional(),
  priority: z.string().trim().max(80).optional(),
  gpsCoordinates: z.string().trim().max(120).optional(),
  weatherConditions: z.string().trim().max(240).optional(),
  equipmentInvolved: z.string().trim().max(240).optional(),
  peopleInvolved: z.string().trim().max(5000).optional(),
  witnesses: z.string().trim().max(5000).optional(),
  potentialRootCause: z.string().trim().max(5000).optional(),
  digitalSignature: z.string().trim().max(240).optional(),
  accuracyConfirmed: z.boolean().optional(),
})

// These cross-field checks prevent contradictory combinations in both saved drafts and final submissions.
function addCommonIncidentRules(data: { reportType: string; environmentalImpact?: boolean }, context: z.RefinementCtx) {
  if (data.reportType === 'environmental_incident' && !data.environmentalImpact) {
    context.addIssue({ code: 'custom', path: ['environmentalImpact'], message: 'Environmental incidents must identify environmental impact.' })
  }
}

export const incidentDraftSchema = incidentDraftFields.superRefine(addCommonIncidentRules)

// Final submission reuses the draft fields but makes the information needed to process a report mandatory.
export const incidentSubmissionSchema = incidentDraftFields.extend({
  occurredAt: z.string().datetime({ offset: true, message: 'Occurrence date and time is required.' }),
  location: z.string().trim().max(240).optional(),
  severity: z.string().trim().min(1, 'Severity is required.').max(80),
  incidentCategory: z.string().trim().min(1, 'Incident category is required.').max(120),
  accuracyConfirmed: z.literal(true, { error: 'Confirm that the report is accurate before submitting.' }),
}).superRefine((data, context) => {
  addCommonIncidentRules(data, context)
  if (!data.siteId && !data.department?.trim()) {
    context.addIssue({ code: 'custom', path: ['siteId'], message: 'Select a site or department.' })
  }
  if (data.siteId && data.department?.trim()) {
    context.addIssue({ code: 'custom', path: ['department'], message: 'Select either a site or a department.' })
  }
  if (!data.weatherConditions?.trim()) {
    context.addIssue({ code: 'custom', path: ['weatherConditions'], message: 'Select a weather condition.' })
  }
  if (!data.shift?.trim()) {
    context.addIssue({ code: 'custom', path: ['shift'], message: 'Select a shift.' })
  }
  if ((data.reportType === 'incident' || data.reportType === 'environmental_incident') && !data.severity) {
    context.addIssue({ code: 'custom', path: ['severity'], message: 'Actual severity is required for this report type.' })
  }
})

// Browser date and time inputs are separate; the form keeps them separate until IncidentReportForm combines them.
export const incidentFormSchema = incidentDraftFields.omit({ equipmentInvolved: true }).extend({
  locationType: z.enum(['site', 'department']).optional(),
  occurrenceDate: z.string().optional(),
  occurrenceTime: z.string().optional(),
  affectedPersonName: z.string().trim().max(240).optional(),
  affectedPersonOrganization: z.string().trim().max(240).optional(),
  witnessName: z.string().trim().max(240).optional(),
  witnessOrganization: z.string().trim().max(240).optional(),
  witnessContactDetails: z.string().trim().max(500).optional(),
}).superRefine(addCommonIncidentRules)

// This allow-list validates evidence metadata; incidentService applies stricter per-file and per-incident size limits.
export const incidentEvidenceMetadataSchema = z.object({
  incidentId: uuid,
  originalFilename: z.string().trim().min(1).max(255),
  mimeType: z.string().regex(/^(image\/(jpeg|png|webp)|video\/(mp4|webm|quicktime)|audio\/(mpeg|mp4|wav|webm)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document|application\/vnd\.openxmlformats-officedocument\.spreadsheetml\.sheet|text\/plain)$/, 'Unsupported evidence file type.'),
  fileSize: z.number().int().positive().max(100 * 1024 * 1024, 'Evidence must be 100 MB or smaller.'),
})

export const incidentPersonSchema = z.object({
  incidentId: uuid,
  personType: z.enum(['affected_person', 'witness']),
  profileId: uuid.nullable().optional(),
  fullName: z.string().trim().min(2, 'Name is required.').max(240),
  organizationName: optionalText,
  contactDetails: z.string().trim().max(500).optional(),
})

// Defaults give list queries stable filter values, and the final check rejects a reversed date range.
export const incidentListFiltersSchema = z.object({
  search: z.string().trim().max(120).optional(),
  status: z.enum([...incidentStatuses, 'all', 'open'] as const).optional().default('all'),
  reportType: z.enum([...incidentReportTypes, 'all'] as const).optional().default('all'),
  incidentCategory: z.string().trim().max(120).optional().default('all'),
  severity: z.string().trim().max(80).optional().default('all'),
  siteId: uuid.or(z.literal('all')).optional().default('all'),
  department: z.string().trim().max(120).optional().default('all'),
  dateFrom: z.string().date().optional(),
  dateTo: z.string().date().optional(),
  page: z.number().int().min(1).optional().default(1),
  pageSize: z.number().int().min(1).max(100).optional().default(25),
}).refine((data) => !data.dateFrom || !data.dateTo || data.dateFrom <= data.dateTo, {
  message: 'Start date must be before end date.',
  path: ['dateTo'],
})

export type IncidentDraftFormValues = z.infer<typeof incidentDraftSchema>
export type IncidentSubmissionFormValues = z.infer<typeof incidentSubmissionSchema>
export type IncidentFormValues = z.infer<typeof incidentFormSchema>
export type IncidentEvidenceMetadata = z.infer<typeof incidentEvidenceMetadataSchema>
export type IncidentPersonFormValues = z.infer<typeof incidentPersonSchema>
export type IncidentListFiltersValues = z.infer<typeof incidentListFiltersSchema>

export { incidentSeverities }
