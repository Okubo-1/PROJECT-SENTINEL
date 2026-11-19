import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  Alert,
  Badge,
  Card,
  EmptyState,
  PageHeader,
  Skeleton,
  buttonVariants,
} from '../../components/ui'
import { ReportStageEvent } from './ReportStageEvent'
import { ReportStageLocation } from './ReportStageLocation'
import type { ReportFacility } from './ReportStageLocation'
import { ReportStagePeople } from './ReportStagePeople'
import type { ReportingIdentity } from './ReportStagePeople'
import { ReportStageEvidence } from './ReportStageEvidence'
import { ReportStepChips, ReportStepRail } from './ReportWizardSteps'
import { ReportWizardFooter } from './ReportWizardFooter'
import { SubmitIncidentDialogs } from './SubmitIncidentDialogs'
import { incidentFormSchema, incidentSubmissionSchema, type IncidentFormValues } from './incidentSchemas'
import { enqueueIncidentSubmission } from './incidentOfflineQueue'
import { getAnonymousDraftOwnerToken, getIncident, saveAnonymousIncidentDraft, submitAnonymousIncidentDraft } from './incidentService'
import { getOfflineAnonymousDraft, saveOfflineAnonymousDraft, syncOfflineAnonymousDrafts } from './anonymousDraftQueue'
import type { AnonymousDraftQueueItem } from './anonymousDraftQueue'
import { companySettingsEventMatchesOrganization, companySettingsUpdatedEvent } from '../../lib/companySettingsSync'
import { normalizeDepartmentSettings } from '../settings/companySettingsTypes'
import { useCreateIncidentDraft, useIncident, useIncidentOrganization, useSubmitIncident, useSubmitNewIncident, useUpdateIncidentDraft, useUploadIncidentEvidence } from './useIncidentData'
import type { IncidentDetail, IncidentDraftInput, IncidentReportType, IncidentSubmissionInput } from './incidentTypes'

const stages = ['Event', 'Location & context', 'People', 'Evidence & sign-off'] as const

type SiteOption = { id: string; name: string }
function configuredOptions(value: unknown, fallback: string[], legacyValue = '') {
  if (!Array.isArray(value)) return legacyValue ? [legacyValue] : fallback
  const options = value.flatMap((item) => {
    if (typeof item === 'string') return [item.trim()].filter(Boolean)
    if (item && typeof item === 'object' && 'name' in item && typeof item.name === 'string' && (!('active' in item) || item.active !== false) && (!('deleted' in item) || item.deleted !== true)) return [item.name.trim()].filter(Boolean)
    return []
  })
  if (legacyValue && !options.some((option) => option.toLowerCase() === legacyValue.toLowerCase())) options.push(legacyValue)
  return options.length ? options : legacyValue ? [legacyValue] : fallback
}

function configuredSiteNames(value: unknown) {
  if (!Array.isArray(value)) return []
  return value.flatMap((item) => {
    const rawName = typeof item === 'string' ? item : item && typeof item === 'object' && typeof (item as Record<string, unknown>).name === 'string' ? (item as Record<string, unknown>).name as string : ''
    if (!rawName || (typeof item === 'object' && item !== null && (
      (('active' in item) && (item as Record<string, unknown>).active === false)
      || (('deleted' in item) && (item as Record<string, unknown>).deleted === true)
    ))) return []
    return rawName.trim() ? [rawName.trim()] : []
  })
}

function configuredShiftNames(value: unknown, legacyValue = '') {
  if (!value || typeof value !== 'object') return []
  const shifts = (value as Record<string, unknown>).shifts
  if (!Array.isArray(shifts)) return []
  const names = shifts.flatMap((item: unknown) => {
    if (!item || typeof item !== 'object') return []
    const shift = item as Record<string, unknown>
    return typeof shift.name === 'string' && shift.name.trim() && shift.active !== false && shift.deleted !== true ? [shift.name.trim()] : []
  })
  if (legacyValue && !names.some((name) => name.toLowerCase() === legacyValue.toLowerCase())) names.push(legacyValue)
  return names
}

// The browser collects date and time separately; the database field stores one timezone-aware timestamp.
function combineOccurrenceDateTime(values: IncidentFormValues) {
  if (!values.occurrenceDate || !values.occurrenceTime) return undefined
  const date = new Date(`${values.occurrenceDate}T${values.occurrenceTime}`)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function formatLocalDate(date: Date | null) {
  if (!date || Number.isNaN(date.getTime())) return ''
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

// Save only incident-domain values plus the current wizard stage, leaving browser-only date/time fields out of the payload.
function toDraftInput(values: IncidentFormValues, draftStage: number, existingEquipment?: string | null): IncidentDraftInput {
  const contractorOrganization = values.contractorOrganization?.trim() || undefined
  return {
    reportType: values.reportType,
    draftStage,
    title: values.title,
    description: values.description,
    occurredAt: combineOccurrenceDateTime(values),
    siteId: values.locationType === 'department' ? undefined : values.siteId,
    facilityId: values.facilityId,
    location: values.location,
    department: values.locationType === 'site' ? undefined : values.department,
    shift: values.shift,
    workActivityContext: values.workActivityContext,
    severity: values.severity,
    potentialSeverity: values.potentialSeverity,
    incidentCategory: values.incidentCategory,
    contractorInvolved: Boolean(contractorOrganization),
    contractorOrganization,
    environmentalImpact: values.environmentalImpact,
    injuryOrIllness: values.injuryOrIllness,
    propertyDamage: values.propertyDamage,
    workRelated: values.workRelated,
    immediateCorrection: values.immediateCorrection,
    priority: values.priority,
    gpsCoordinates: values.gpsCoordinates,
    weatherConditions: values.weatherConditions,
    equipmentInvolved: existingEquipment || undefined,
    peopleInvolved: values.peopleInvolved,
    witnesses: values.witnesses,
    potentialRootCause: values.potentialRootCause,
    digitalSignature: values.digitalSignature,
    accuracyConfirmed: values.accuracyConfirmed,
  }
}

const submissionFieldForPath: Record<string, keyof IncidentFormValues> = {
  title: 'title',
  description: 'description',
  siteId: 'siteId',
  facilityId: 'facilityId',
  severity: 'severity',
  potentialSeverity: 'potentialSeverity',
  incidentCategory: 'incidentCategory',
  immediateCorrection: 'immediateCorrection',
  accuracyConfirmed: 'accuracyConfirmed',
  environmentalImpact: 'environmentalImpact',
}

const submissionStageByField: Partial<Record<keyof IncidentFormValues, number>> = {
  title: 0,
  incidentCategory: 0,
  severity: 0,
  potentialSeverity: 0,
  occurrenceDate: 0,
  occurrenceTime: 0,
  description: 0,
  environmentalImpact: 0,
  siteId: 1,
  facilityId: 1,
  immediateCorrection: 2,
  accuracyConfirmed: 3,
}

// One editor handles both new reports and drafts reopened from My Reports.
// It keeps the staged form data together while the user saves a draft, adds evidence, or submits the report.
export function IncidentReportForm({ supabase, reportType, initialTitle, initialCategory, initialEnvironmentalImpact, draftId: existingDraftId, initialIncident, offlineDraft }: { supabase: SupabaseClient; reportType: IncidentReportType; initialTitle?: string; initialCategory?: string; initialEnvironmentalImpact?: boolean; draftId?: string; initialIncident?: IncidentDetail; offlineDraft?: AnonymousDraftQueueItem }) {
  const organization = useIncidentOrganization(supabase)
  const [draftId, setDraftId] = useState<string | null>(existingDraftId || null)
  const existingDraft = useIncident(supabase, draftId || null)
  const loadedIncident = existingDraft.data || initialIncident
  const [sites, setSites] = useState<SiteOption[]>([])
  const [facilities, setFacilities] = useState<ReportFacility[]>([])
  const [facilitiesAvailable, setFacilitiesAvailable] = useState(true)
  const [settings, setSettings] = useState<Record<string, unknown>>({})
  const [settingsLoading, setSettingsLoading] = useState(true)
  const [settingsLoaded, setSettingsLoaded] = useState(false)
  const settingsLoadedRef = useRef(false)
  const [settingsError, setSettingsError] = useState('')
  const [submitMessage, setSubmitMessage] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [draftReference, setDraftReference] = useState(existingDraftId ? (initialIncident?.referenceNumber || '') : '')
  const [draftType, setDraftType] = useState<'manual' | 'offline-pending' | null>(offlineDraft ? 'offline-pending' : existingDraftId ? 'manual' : null)
  const [identity, setIdentity] = useState<ReportingIdentity | null>(offlineDraft ? 'anonymous' : existingDraftId ? 'me' : null)
  const [anonymousOwnerToken, setAnonymousOwnerToken] = useState<string | null>(offlineDraft?.ownerToken || null)
  const [anonymousSaving, setAnonymousSaving] = useState(false)
  const anonymousSubmissionId = useRef(offlineDraft?.id || crypto.randomUUID())
  const [activeStage, setActiveStage] = useState(() => Math.max(0, Math.min(offlineDraft?.input.draftStage || 0, stages.length - 1)))
  const [submitConfirmationOpen, setSubmitConfirmationOpen] = useState(false)
  const [submissionSuccessOpen, setSubmissionSuccessOpen] = useState(false)
  const autoConfirmDraftSubmission = useRef(new URLSearchParams(window.location.hash.split('?')[1] || '').get('submit') === '1')
  const hydratedDraftId = useRef<string | null>(null)
  const createDraft = useCreateIncidentDraft(supabase)
  const updateDraft = useUpdateIncidentDraft(supabase)
  const submitIncident = useSubmitIncident(supabase)
  const submitNewIncident = useSubmitNewIncident(supabase)
  const uploadEvidence = useUploadIncidentEvidence(supabase)
  const form = useForm<IncidentFormValues>({
    resolver: zodResolver(incidentFormSchema),
    defaultValues: {
      reportType,
      title: initialTitle || '',
      incidentCategory: initialCategory || '',
      contractorInvolved: false,
      environmentalImpact: initialEnvironmentalImpact !== undefined ? initialEnvironmentalImpact : (reportType === 'environmental_incident'),
      injuryOrIllness: false,
      propertyDamage: false,
      workRelated: true,
      priority: '',
      gpsCoordinates: '',
      weatherConditions: '',
      peopleInvolved: '',
      witnesses: '',
      potentialRootCause: '',
      accuracyConfirmed: false,
      affectedPersonName: '',
      affectedPersonOrganization: '',
      witnessName: '',
      witnessOrganization: '',
      witnessContactDetails: '',
      ...offlineDraft?.input,
      locationType: offlineDraft?.input.siteId ? 'site' : offlineDraft?.input.department ? 'department' : undefined,
      occurrenceDate: formatLocalDate(offlineDraft?.input.occurredAt ? new Date(offlineDraft.input.occurredAt) : null),
      occurrenceTime: offlineDraft?.input.occurredAt ? new Date(offlineDraft.input.occurredAt).toTimeString().slice(0, 5) : '',
      digitalSignature: '',
    },
  })
  const [reporter, setReporter] = useState<{ userId: string; name: string } | null>(null)
  const reporterName = reporter && reporter.userId === organization.data?.userId ? reporter.name : 'Authenticated user'
  useEffect(() => {
    const userId = organization.data?.userId
    if (!userId) return

    let active = true
    void supabase
      .from('profiles')
      .select('full_name')
      .eq('id', userId)
      .maybeSingle()
      .then(({ data, error }) => {
        if (!active) return
        const nextName = typeof data?.full_name === 'string' && data.full_name.trim() ? data.full_name.trim() : 'Authenticated user'
        setReporter({ userId, name: error ? 'Authenticated user' : nextName })
      })

    return () => {
      active = false
    }
  }, [organization.data?.userId, supabase])

  useEffect(() => {
    if (!loadedIncident || hydratedDraftId.current === loadedIncident.id) return
    hydratedDraftId.current = loadedIncident.id
    setDraftId(loadedIncident.id)
    setDraftReference(loadedIncident.referenceNumber)
    setDraftType('manual')
    setIdentity(loadedIncident.isAnonymous ? 'anonymous' : 'me')
    const occurred = loadedIncident.occurredAt ? new Date(loadedIncident.occurredAt) : null
    form.reset({
      reportType: loadedIncident.reportType,
      locationType: loadedIncident.siteId ? 'site' : loadedIncident.department ? 'department' : undefined,
      title: loadedIncident.title === 'Untitled draft' ? '' : loadedIncident.title,
      description: loadedIncident.description || '',
      occurrenceDate: formatLocalDate(occurred),
      occurrenceTime: occurred && !Number.isNaN(occurred.getTime()) ? occurred.toTimeString().slice(0, 5) : '',
      siteId: loadedIncident.siteId || undefined,
      facilityId: loadedIncident.facilityId || undefined,
      location: loadedIncident.location || '',
      department: loadedIncident.department || '',
      shift: loadedIncident.shift || '',
      workActivityContext: loadedIncident.workActivityContext || '',
      severity: loadedIncident.severity || '',
      potentialSeverity: loadedIncident.potentialSeverity || '',
      incidentCategory: loadedIncident.incidentCategory || '',
      contractorInvolved: loadedIncident.contractorInvolved,
      contractorOrganization: loadedIncident.contractorOrganization || '',
      environmentalImpact: loadedIncident.environmentalImpact,
      injuryOrIllness: loadedIncident.injuryOrIllness,
      propertyDamage: loadedIncident.propertyDamage,
      workRelated: loadedIncident.workRelated,
      immediateCorrection: loadedIncident.immediateCorrection || '',
      priority: loadedIncident.priority || '',
      gpsCoordinates: loadedIncident.gpsCoordinates || '',
      weatherConditions: loadedIncident.weatherConditions || '',
      peopleInvolved: loadedIncident.peopleInvolved || '',
      witnesses: loadedIncident.witnesses || '',
      potentialRootCause: loadedIncident.potentialRootCause || '',
      digitalSignature: loadedIncident.digitalSignature || '',
      accuracyConfirmed: loadedIncident.accuracyConfirmed,
    })
    setActiveStage(Math.max(0, Math.min(loadedIncident.draftStage || 0, stages.length - 1)))
  }, [form, loadedIncident])

  useEffect(() => {
    if (identity !== 'anonymous') return
    let active = true
    void getAnonymousDraftOwnerToken(supabase).then((token) => {
      if (active) setAnonymousOwnerToken(token)
    }).catch(() => {
      if (active) setSubmitError('Connect to the internet to authorize anonymous draft saving.')
    })
    return () => { active = false; setAnonymousOwnerToken(null) }
  }, [identity, supabase])

  useEffect(() => {
    if (identity !== 'anonymous') return
    const sync = () => {
      void syncOfflineAnonymousDrafts(supabase).then((result) => {
        if (result.failed) setSubmitError('Some anonymous drafts could not be synchronized. They remain on this device.')
      }).catch(() => setSubmitError('Unable to synchronize anonymous drafts. They remain on this device.'))
    }
    if (navigator.onLine) sync()
    window.addEventListener('online', sync)
    return () => window.removeEventListener('online', sync)
  }, [identity, supabase])

  useEffect(() => {
    if (!autoConfirmDraftSubmission.current || !loadedIncident) return
    autoConfirmDraftSubmission.current = false
    setSubmitConfirmationOpen(true)
  }, [loadedIncident])

  useEffect(() => {
    if (!organization.data?.organizationId) return
    let active = true
    const organizationId = organization.data.organizationId
    settingsLoadedRef.current = false
    setSettingsLoaded(false)
    const loadSettings = async () => {
      const initialLoad = !settingsLoadedRef.current
      if (initialLoad) {
        setSettingsLoading(true)
        setSettingsError('')
      }
      try {
        const [siteResult, settingsResult, facilityResult] = await Promise.all([
          supabase.from('sites').select('id, name').eq('organization_id', organizationId).order('name'),
          supabase.from('company_settings').select('departments, operational_sites, incident_categories, severity_levels, working_hours, weather_conditions').eq('organization_id', organizationId).maybeSingle(),
          supabase.from('facilities').select('id, name, site_id, department_key').eq('organization_id', organizationId).eq('active', true).is('archived_at', null).order('name'),
        ])
        if (!active) return
        const facilitySchemaMissing = facilityResult.error?.code === '42703' || facilityResult.error?.code === 'PGRST204'
        if (siteResult.error || settingsResult.error || (facilityResult.error && !facilitySchemaMissing)) {
          throw siteResult.error || settingsResult.error || facilityResult.error
        }
        setSites(siteResult.data || [])
        setFacilities(facilityResult.data || [])
        setFacilitiesAvailable(!facilitySchemaMissing)
        setSettings(settingsResult.data || {})
        settingsLoadedRef.current = true
        setSettingsLoaded(true)
      } catch (caught) {
        if (!active) return
        if (initialLoad) {
          setSettingsError('Unable to load company configuration. Please try again before reporting an incident.')
          setSites([])
          setFacilities([])
          setSettings({})
        } else {
          // A background settings refresh must never replace an in-progress report.
          console.warn('Unable to refresh company configuration; keeping the last loaded configuration.', caught)
        }
      } finally {
        if (active && initialLoad) setSettingsLoading(false)
      }
    }
    const handleSettingsUpdated = (event: Event) => {
      if (companySettingsEventMatchesOrganization(event, organizationId)) void loadSettings()
    }
    void loadSettings()
    window.addEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    return () => {
      active = false
      window.removeEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    }
  }, [organization.data?.organizationId, supabase])

  if (existingDraftId && existingDraft.isLoading) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Report incident" title="Report an incident" description="Restoring the draft." />
        <Skeleton className="h-[320px] rounded-card" />
      </div>
    )
  }
  if (existingDraftId && (existingDraft.isError || !loadedIncident || loadedIncident.status !== 'draft')) {
    return (
      <EmptyState
        icon="incidents"
        title="Draft unavailable"
        description="This draft could not be loaded or is no longer editable."
        action={<a href="#my-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Return to My Reports</a>}
      />
    )
  }
  if (settingsLoading && !settingsLoaded) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Report incident" title="Report an incident" description="Loading company configuration." />
        <Skeleton className="h-[320px] rounded-card" />
      </div>
    )
  }
  if (settingsError && !settingsLoaded) {
    return (
      <EmptyState
        icon="settings"
        title="Configuration unavailable"
        description={settingsError}
        action={<a href="#dashboard" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Return to dashboard</a>}
      />
    )
  }
  const configuredSites = sites.filter((site) => configuredSiteNames(settings.operational_sites).some((name) => name.toLowerCase() === site.name.toLowerCase()))
  const departments = normalizeDepartmentSettings(settings.departments).filter((department) => department.active && !department.deleted)
  const shifts = configuredShiftNames(settings.working_hours)
  const weatherOptions = configuredOptions(settings.weather_conditions, [])
  const categories = configuredOptions(settings.incident_categories, [], loadedIncident?.incidentCategory || '')
  const severities = configuredOptions(settings.severity_levels, [], loadedIncident?.severity || '')

  const isSaving = createDraft.isPending || updateDraft.isPending || anonymousSaving
  const isSubmitting = submitIncident.isPending || submitNewIncident.isPending
  const isBusy = isSaving || isSubmitting

  // A new form creates a manual draft; reopening one updates that same draft and preserves its reference for later edits.
  const saveDraft = async () => {
    setSubmitError('')
    setSubmitMessage('')
    if (!identity) {
      setActiveStage(2)
      setSubmitError('Choose a reporting identity before saving the draft.')
      return
    }
    try {
      const input = toDraftInput(form.getValues(), activeStage, loadedIncident?.equipmentInvolved)
      if (identity === 'anonymous') {
        if (!anonymousOwnerToken) throw new Error('Connect to the internet to authorize anonymous draft saving first.')
        setAnonymousSaving(true)
        if (!navigator.onLine) {
          await saveOfflineAnonymousDraft(input, anonymousOwnerToken, anonymousSubmissionId.current, draftId || offlineDraft?.serverDraftId || null)
          setDraftType('offline-pending')
          setSubmitMessage('Anonymous draft saved on this device and will sync when you reconnect.')
          return
        }
        let saved
        if (draftType === 'offline-pending') {
          await saveOfflineAnonymousDraft(input, anonymousOwnerToken, anonymousSubmissionId.current, draftId)
          const result = await syncOfflineAnonymousDrafts(supabase)
          const queued = await getOfflineAnonymousDraft(anonymousSubmissionId.current, anonymousOwnerToken)
          if (!queued.serverDraftId || queued.pending) throw new Error('The anonymous draft remains on this device. Please retry synchronization.')
          saved = result.saved.find((item) => item.id === queued.serverDraftId) || await getIncident(supabase, queued.serverDraftId)
        } else {
          saved = await saveAnonymousIncidentDraft(supabase, draftId, input, anonymousSubmissionId.current, anonymousOwnerToken)
        }
        hydratedDraftId.current = saved.id
        setDraftId(saved.id)
        setDraftReference(saved.referenceNumber)
        setDraftType('manual')
        setSubmitMessage(`Anonymous draft ${saved.referenceNumber} saved.`)
        return
      }
      const saved = draftId ? await updateDraft.mutateAsync({ incidentId: draftId, input }) : await createDraft.mutateAsync(input)
      hydratedDraftId.current = saved.id
      setDraftId(saved.id)
      setDraftReference(saved.referenceNumber)
      setDraftType('manual')
      setSubmitMessage(`Draft ${saved.referenceNumber} saved as a manual draft. You can continue it later.`)
      window.setTimeout(() => { window.location.hash = '#my-reports' }, 1500)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to save the draft.')
    } finally {
      setAnonymousSaving(false)
    }
  }

  const submitReport = form.handleSubmit(async (values) => {
    setSubmitError('')
    setSubmitMessage('')
    if (!identity) {
      setSubmitError('Choose a reporting identity before submitting.')
      setActiveStage(2)
      return
    }
    if (!validateLocation(values)) {
      setActiveStage(1)
      setSubmitError('Complete the location fields before submitting.')
      return
    }
    const candidate: IncidentSubmissionInput = {
      ...toDraftInput(values, activeStage, loadedIncident?.equipmentInvolved),
      title: values.title || values.incidentCategory || 'Incident',
      potentialSeverity: values.potentialSeverity || (values.reportType === 'near_miss' ? values.severity : undefined),
      occurredAt: combineOccurrenceDateTime(values) || '',
      siteId: values.locationType === 'site' ? values.siteId : undefined,
      location: values.location || '',
      severity: values.severity || '',
      incidentCategory: values.incidentCategory || '',
    }
    const validated = incidentSubmissionSchema.safeParse(candidate)
    if (!validated.success) {
      form.clearErrors()
      const invalidStages: number[] = []
      for (const issue of validated.error.issues) {
        const path = issue.path[0]
        const field = path === 'occurredAt'
          ? (values.occurrenceDate ? 'occurrenceTime' : 'occurrenceDate')
          : typeof path === 'string' ? submissionFieldForPath[path] : undefined
        if (!field) continue
        form.setError(field, { type: 'validate', message: issue.message })
        const stage = submissionStageByField[field]
        if (stage !== undefined) invalidStages.push(stage)
      }
      if (invalidStages.length) setActiveStage(Math.min(...invalidStages))
      setSubmitError(validated.error.issues[0]?.message || 'Please complete the required fields before submitting.')
      return
    }

    if (identity === 'anonymous') {
      if (!navigator.onLine || !draftId || draftType !== 'manual') {
        setSubmitError('Save and sync your anonymous draft online before submitting.')
        return
      }
      setAnonymousSaving(true)
      try {
        const submitted = await submitAnonymousIncidentDraft(supabase, draftId, validated.data)
        setSubmitMessage(`Report ${submitted.referenceNumber} submitted successfully. Anonymous reporter.`)
        setSubmissionSuccessOpen(true)
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to submit the anonymous incident.')
      } finally {
        setAnonymousSaving(false)
      }
      return
    }

    // Unsaved reports can queue for later sync, but a manual server draft is submitted only while online.
    if (!navigator.onLine) {
      if (draftId && draftType === 'manual') {
        setSubmitError('Manual drafts can only be submitted while online. Your draft remains unchanged.')
        return
      }
      try {
        const queued = await enqueueIncidentSubmission(validated.data)
        setDraftType('offline-pending')
        setDraftReference(`OFFLINE-${queued.id.slice(0, 8).toUpperCase()}`)
        setSubmitMessage('Report queued for automatic submission when connectivity returns. Your data remains on this device.')
      } catch (error) {
        setSubmitError(error instanceof Error ? error.message : 'Unable to queue the incident for offline submission.')
      }
      return
    }

    try {
      let activeDraftId = draftId
      if (!activeDraftId) {
        const submitted = await submitNewIncident.mutateAsync(validated.data)
        setSubmitMessage(`Report ${submitted.referenceNumber} submitted successfully.`)
        setSubmissionSuccessOpen(true)
        return
      }

      const submitted = await submitIncident.mutateAsync({ incidentId: activeDraftId, input: validated.data })
      setSubmitMessage(`Report ${submitted.referenceNumber} submitted successfully.`)
      setSubmissionSuccessOpen(true)
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to submit the incident report.')
    }
  }, (errors) => {
    const invalidFields = Object.keys(errors).filter((field): field is keyof IncidentFormValues => field in submissionStageByField)
    const invalidStages = invalidFields.flatMap((field) => {
      const stage = submissionStageByField[field]
      return stage === undefined ? [] : [stage]
    })
    if (invalidStages.length) setActiveStage(Math.min(...invalidStages))
    const firstError = Object.values(errors).find((error) => typeof error?.message === 'string')
    setSubmitError(typeof firstError?.message === 'string' ? firstError.message : 'Please correct the highlighted fields before submitting.')
    setSubmitMessage('')
  })

  const stageFields: Array<Array<keyof IncidentFormValues>> = [
    ['incidentCategory', 'severity', 'occurrenceDate', 'occurrenceTime'],
    ['locationType', 'siteId', 'department'],
    [],
    ['accuracyConfirmed'],
  ]

  const validateLocation = (values: IncidentFormValues) => {
    let valid = true
    const invalid = (field: keyof IncidentFormValues, message: string) => {
      form.setError(field, { type: 'validate', message })
      valid = false
    }
    if (!values.locationType) invalid('locationType', 'Select a location type.')
    if (values.locationType === 'site' && !values.siteId) invalid('siteId', 'Select a site.')
    if (values.locationType === 'department' && !values.department) invalid('department', 'Select a department.')
    if (values.locationType === 'site' && values.siteId && !configuredSites.some((site) => site.id === values.siteId)) invalid('siteId', 'Select an active site.')
    if (values.locationType === 'department' && values.department && !departments.some((department) => department.name === values.department)) invalid('department', 'Select an active department.')
    if (values.locationType === 'department' && !facilitiesAvailable) invalid('department', 'Department reporting is unavailable until the database migration is applied.')
    const departmentId = departments.find((department) => department.name === values.department)?.id
    const matching = facilities.filter((facility) => values.locationType === 'site'
      ? Boolean(values.siteId && facility.site_id === values.siteId)
      : Boolean(departmentId && facility.department_key === departmentId))
    if (facilitiesAvailable && ((values.facilityId && !matching.some((facility) => facility.id === values.facilityId)) || (matching.length && !values.facilityId))) {
      invalid('facilityId', 'Select an active facility for this location.')
    }
    if (!values.weatherConditions) invalid('weatherConditions', 'Select a weather condition.')
    else if (!weatherOptions.includes(values.weatherConditions)) invalid('weatherConditions', 'Select an active weather condition.')
    if (!values.shift) invalid('shift', 'Select a shift.')
    else if (!shifts.includes(values.shift)) invalid('shift', 'Select an active shift.')
    return valid
  }

  const continueStage = async () => {
    const valid = await form.trigger(stageFields[activeStage])
    if (!valid) return
    if (activeStage === 0) {
      const values = form.getValues()
      let complete = true
      for (const [field, message] of [
        ['incidentCategory', 'Event category is required.'],
        ['severity', 'Severity is required.'],
        ['occurrenceDate', 'Date is required.'],
        ['occurrenceTime', 'Time is required.'],
      ] as const) {
        if (!values[field]?.trim()) {
          form.setError(field, { type: 'required', message })
          complete = false
        }
      }
      if (!complete) return
    }
    if (activeStage === 1 && !validateLocation(form.getValues())) return
    setActiveStage((stage) => Math.min(stage + 1, stages.length - 1))
  }

  const handleEvidence = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    if (!draftId) {
      setSubmitError('Save the draft before adding evidence.')
      return
    }
    try {
      setSubmitError('')
      setSubmitMessage('')
      const evidence = await uploadEvidence.mutateAsync({ incidentId: draftId, file })
      setSubmitMessage(evidence.sanitization === 'unverified'
        ? 'Evidence uploaded privately. It may contain identifying details; sanitization could not be verified.'
        : 'Evidence uploaded securely.')
    } catch (error) {
      setSubmitError(error instanceof Error ? error.message : 'Unable to upload evidence.')
    }
  }

  const requestSubmitConfirmation = () => {
    if (!isBusy) setSubmitConfirmationOpen(true)
  }



  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Report incident"
        title="Report an incident"
        description="Progressive form — drafts are auto-saved and can be submitted offline; they sync when connectivity returns."
        actions={
          <>
            <Badge tone={draftType === 'offline-pending' ? 'warning' : 'neutral'}>
              {draftType === 'offline-pending' ? 'Offline pending' : draftReference ? `Draft ${draftReference}` : 'New report'}
            </Badge>
            <a href="#my-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>My reports</a>
          </>
        }
      />

      <form
        className="grid gap-5 lg:grid-cols-[220px_minmax(0,1fr)]"
        onSubmit={(event) => { event.preventDefault(); requestSubmitConfirmation() }}
      >
        <ReportStepRail stages={stages} activeStage={activeStage} onSelect={setActiveStage} />

        <div className="grid min-w-0 gap-5">
          <ReportStepChips stages={stages} activeStage={activeStage} onSelect={setActiveStage} />

          <Card className="p-5 shadow-none">
            {activeStage === 0 && (
              <ReportStageEvent form={form} categories={categories} severities={severities} />
            )}
            {activeStage === 1 && (
              <ReportStageLocation form={form} configuredSites={configuredSites} departments={departments} shifts={shifts} weatherOptions={weatherOptions} facilities={facilities} facilitiesAvailable={facilitiesAvailable} />
            )}
            {activeStage === 2 && (
              <ReportStagePeople reporterName={reporterName} identity={identity} onChange={setIdentity} locked={Boolean(draftId || draftType === 'offline-pending' || isSaving)} anonymousEnabled />
            )}
            {activeStage === 3 && (
              <ReportStageEvidence form={form} loadedIncident={loadedIncident} isBusy={isBusy} onEvidence={handleEvidence} />
            )}
          </Card>

          {submitError && <Alert tone="danger">{submitError}</Alert>}
          {submitMessage && <Alert tone="success">{submitMessage}</Alert>}

          <ReportWizardFooter
            activeStage={activeStage}
            stageCount={stages.length}
            isBusy={isBusy}
            isSaving={isSaving}
            isSubmitting={isSubmitting}
            draftReference={draftReference}
            draftType={draftType}
            onBack={() => setActiveStage(activeStage - 1)}
            onSaveDraft={() => void saveDraft()}
            onContinue={() => void continueStage()}
          />
        </div>
      </form>

      <SubmitIncidentDialogs
        confirmationOpen={submitConfirmationOpen}
        successOpen={submissionSuccessOpen}
        isSubmitting={isSubmitting}
        draftReference={draftReference}
        submitMessage={submitMessage}
        onCloseConfirmation={() => setSubmitConfirmationOpen(false)}
        onCloseSuccess={() => setSubmissionSuccessOpen(false)}
        onSubmit={() => { setSubmitConfirmationOpen(false); void submitReport() }}
        onViewIncidents={() => { setSubmissionSuccessOpen(false); window.location.hash = '#incidents' }}
      />
    </div>
  )
}