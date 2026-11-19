import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { z } from 'zod'

import { Alert, Badge, Button, Card, Dialog, Field, Skeleton, Textarea } from '../../components/ui'
import { useIncidentEvidence, useUploadInvestigationEvidence } from '../incidents/useIncidentData'
import {
  fishboneHeadings,
  investigationCloseError,
  reportFileError,
  rootCauseSummary,
  type FaultTreeCause,
  type RootCauseBreakdown,
  type RootCauseMethod,
} from '../incidents/investigationRecordValidation'

const investigationDetailSchema = z.object({
  investigation: z.object({
    id: z.uuid(),
    organization_id: z.uuid(),
    incident_id: z.uuid(),
    level: z.string().nullable(),
    status: z.string(),
    due_at: z.iso.datetime({ offset: true }).nullable(),
    witness_statement: z.string().nullable(),
    immediate_causes: z.string().nullable(),
    root_cause_method: z.string().nullable(),
    root_cause_breakdown: z.unknown().nullable(),
    root_causes_summary: z.string().nullable(),
    contributing_factors: z.string().nullable(),
    closed_at: z.iso.datetime({ offset: true }).nullable(),
  }),
  incident: z.object({
    reference_number: z.string(),
    incident_category: z.string().nullable(),
    severity: z.string().nullable(),
    site_name: z.string().nullable(),
    department: z.string().nullable(),
    facility_name: z.string().nullable(),
    location: z.string().nullable(),
    occurred_at: z.iso.datetime({ offset: true }).nullable(),
    shift: z.string().nullable(),
  }),
  assigned_team: z.array(z.object({ user_id: z.uuid(), full_name: z.string() })),
  timeline: z.array(z.object({
    id: z.uuid(),
    event_type: z.string(),
    details: z.record(z.string(), z.unknown()),
    created_at: z.iso.datetime({ offset: true }),
  })),
  attachments: z.array(z.object({
    id: z.uuid(),
    original_filename: z.string(),
    mime_type: z.string(),
    file_size: z.number(),
    attachment_type: z.enum(['report', 'attachment']),
  })),
  linked_actions: z.array(z.object({
    id: z.uuid(),
    type: z.string(),
    description: z.string(),
    status: z.string(),
    due_at: z.iso.datetime({ offset: true }).nullable(),
  })),
  can_edit: z.boolean(),
})

type FishboneCategories = Extract<RootCauseBreakdown, { method: 'fishbone' }>['categories']

function emptyCategories(): FishboneCategories {
  return { People: [], Process: [], Equipment: [], Environment: [], Management: [] }
}

function emptyFaultCause(): FaultTreeCause {
  return { cause: '', gate: 'OR', is_root_cause: false, children: [] }
}

function emptyBreakdown(method: RootCauseMethod): RootCauseBreakdown {
  if (method === '5_whys') return { method, answers: [] }
  if (method === 'fishbone') return { method, categories: emptyCategories() }
  return { method, top_event: '', gate: 'OR', causes: [] }
}

function readBreakdown(method: string | null, input: unknown): RootCauseBreakdown | null {
  if (!method || !input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (method === '5_whys' && Array.isArray(value.answers) && value.answers.every((answer) => typeof answer === 'string')) {
    return { method, answers: value.answers }
  }
  if (method === 'fishbone' && value.categories && typeof value.categories === 'object') {
    const categories = value.categories as Record<string, unknown>
    const parsed = emptyCategories()
    for (const heading of fishboneHeadings) {
      const causes = categories[heading]
      if (!Array.isArray(causes)) return null
      parsed[heading] = causes.flatMap((item) => {
        if (!item || typeof item !== 'object') return []
        const cause = item as Record<string, unknown>
        return typeof cause.cause === 'string' && typeof cause.is_root_cause === 'boolean'
          ? [{ cause: cause.cause, is_root_cause: cause.is_root_cause }]
          : []
      })
    }
    return { method, categories: parsed }
  }
  if (method === 'fault_tree' && typeof value.top_event === 'string'
    && (value.gate === 'AND' || value.gate === 'OR') && Array.isArray(value.causes)) {
    const parseNode = (node: unknown): FaultTreeCause | null => {
      if (!node || typeof node !== 'object') return null
      const item = node as Record<string, unknown>
      if (typeof item.cause !== 'string' || (item.gate !== 'AND' && item.gate !== 'OR')
        || typeof item.is_root_cause !== 'boolean' || !Array.isArray(item.children)) return null
      const children = item.children.map(parseNode)
      if (children.some((child) => child === null)) return null
      return { cause: item.cause, gate: item.gate, is_root_cause: item.is_root_cause, children: children as FaultTreeCause[] }
    }
    const causes = value.causes.map(parseNode)
    if (causes.some((cause) => cause === null)) return null
    return { method, top_event: value.top_event, gate: value.gate, causes: causes as FaultTreeCause[] }
  }
  return null
}

function formatTime(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString()
}

function formatDate(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleDateString()
}

function formatClockTime(value: string | null | undefined) {
  if (!value) return 'Not recorded'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleTimeString()
}

function FaultTreeEditor({ cause, onChange, onRemove }: {
  cause: FaultTreeCause
  onChange: (value: FaultTreeCause) => void
  onRemove: () => void
}) {
  return (
    <div className="grid gap-3 rounded-xl border border-line p-3">
      <Field label="Cause">
        <Textarea value={cause.cause} onChange={(event) => onChange({ ...cause, cause: event.target.value })} rows={2} />
      </Field>
      <div className="flex flex-wrap items-center gap-3">
        {cause.children.length > 0 && (
          <Field label="Gate">
            <select
              value={cause.gate}
              onChange={(event) => onChange({ ...cause, gate: event.target.value as 'AND' | 'OR' })}
              className="rounded-lg border border-line bg-surface px-3 py-2 text-sm text-foreground"
            >
              <option value="AND">AND</option>
              <option value="OR">OR</option>
            </select>
          </Field>
        )}
        {cause.children.length === 0 && (
          <label className="flex items-center gap-2 text-sm text-foreground">
            <input
              type="checkbox"
              checked={cause.is_root_cause}
              onChange={(event) => onChange({ ...cause, is_root_cause: event.target.checked })}
            />
            Root cause
          </label>
        )}
        <Button variant="outline" size="sm" onClick={() => onChange({
          ...cause,
          is_root_cause: false,
          children: [...cause.children, emptyFaultCause()],
        })}>
          Add sub-cause
        </Button>
        <Button variant="ghost" size="sm" className="text-danger" onClick={onRemove}>Remove</Button>
      </div>
      {cause.children.map((child, index) => (
        <div key={index} className="ml-4 border-l border-line pl-3">
          <FaultTreeEditor
            cause={child}
            onChange={(next) => onChange({ ...cause, children: cause.children.map((item, i) => i === index ? next : item) })}
            onRemove={() => onChange({ ...cause, children: cause.children.filter((_, i) => i !== index) })}
          />
        </div>
      ))}
    </div>
  )
}

export function InvestigationDialog({ client, investigationId, onClose, onVerificationViewed }: {
  client: SupabaseClient
  investigationId: string
  onClose: () => void
  onVerificationViewed?: () => void
}) {
  const queryClient = useQueryClient()
  const initialized = useRef(false)
  const viewedInvestigation = useRef('')
  const detail = useQuery({
    queryKey: ['investigation-detail', investigationId],
    queryFn: async () => {
      const { data, error } = await client.rpc('get_investigation_record', { target_investigation_id: investigationId })
      if (error) throw new Error(error.message)
      return investigationDetailSchema.parse(data)
    },
  })
  const incidentId = detail.data?.investigation.incident_id || null
  const evidence = useIncidentEvidence(client, incidentId)
  const uploadEvidence = useUploadInvestigationEvidence(client)
  const [witnessStatement, setWitnessStatement] = useState('')
  const [immediateCauses, setImmediateCauses] = useState('')
  const [method, setMethod] = useState<RootCauseMethod | ''>('')
  const [breakdown, setBreakdown] = useState<RootCauseBreakdown | null>(null)
  const [contributingFactors, setContributingFactors] = useState('')
  const [reportEvidenceId, setReportEvidenceId] = useState('')
  const [attachmentIds, setAttachmentIds] = useState<string[]>([])
  const [formError, setFormError] = useState('')
  const [formMessage, setFormMessage] = useState('')
  const [savingAction, setSavingAction] = useState<'progress' | 'close' | null>(null)
  const saving = savingAction !== null

  useEffect(() => {
    if (!detail.data || initialized.current) return
    const record = detail.data.investigation
    const savedMethod = record.root_cause_method as RootCauseMethod | null
    setWitnessStatement(record.witness_statement || '')
    setImmediateCauses(record.immediate_causes || '')
    setContributingFactors(record.contributing_factors || '')
    setMethod(savedMethod || '')
    setBreakdown(readBreakdown(savedMethod, record.root_cause_breakdown))
    setReportEvidenceId(detail.data.attachments.find((item) => item.attachment_type === 'report')?.id || '')
    setAttachmentIds(detail.data.attachments.filter((item) => item.attachment_type === 'attachment').map((item) => item.id))
    initialized.current = true
  }, [detail.data])

  useEffect(() => {
    if (detail.data?.incident && detail.data.investigation.status === 'completed'
      && onVerificationViewed && viewedInvestigation.current !== investigationId) {
      viewedInvestigation.current = investigationId
      void client.rpc('acknowledge_investigation_view', {
        target_investigation_id: investigationId,
      }).then(({ error }) => {
        if (error) {
          viewedInvestigation.current = ''
          setFormError(error.message)
          return
        }
        onVerificationViewed()
      }, (error: unknown) => {
        viewedInvestigation.current = ''
        setFormError(error instanceof Error ? error.message : 'Unable to record the investigation review.')
      })
    }
  }, [client, detail.data, investigationId, onVerificationViewed])

  const currentBreakdown = breakdown || (method ? emptyBreakdown(method) : null)
  const report = detail.data?.attachments.find((item) => item.id === reportEvidenceId)
    || evidence.data?.find((item) => item.id === reportEvidenceId)
    || null
  const reportMetadata = report
    ? 'mime_type' in report
      ? { name: report.original_filename, mime_type: report.mime_type, file_size: report.file_size }
      : { name: report.originalFilename, mime_type: report.mimeType, file_size: report.fileSize }
    : null
  const reportError = reportMetadata
    ? reportFileError({ name: reportMetadata.name, type: reportMetadata.mime_type, size: reportMetadata.file_size })
    : null
  const canEdit = Boolean(detail.data?.can_edit && detail.data.investigation.status !== 'completed')
  const closeError = investigationCloseError({
    immediateCauses,
    breakdown: currentBreakdown,
    report: reportMetadata,
  })

  const setMethodValue = (value: RootCauseMethod | '') => {
    setMethod(value)
    setBreakdown(value ? (currentBreakdown?.method === value ? currentBreakdown : emptyBreakdown(value)) : null)
  }

  const uploadSelectedFile = async (event: ChangeEvent<HTMLInputElement>, asReport: boolean) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file || !incidentId) return
    if (asReport) {
      const error = reportFileError(file)
      if (error) {
        setFormError(error)
        return
      }
    }
    setFormError('')
    try {
      const uploaded = await uploadEvidence.mutateAsync({ incidentId, file })
      if (asReport) setReportEvidenceId(uploaded.id)
      else setAttachmentIds((current) => [...new Set([...current, uploaded.id])])
      setFormMessage('Attachment uploaded securely.')
      await evidence.refetch()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to upload the attachment.')
    }
  }

  const downloadFile = async (evidenceId: string) => {
    setFormError('')
    try {
      const evidenceRows = evidence.data || (await evidence.refetch()).data || []
      const file = evidenceRows.find((item) => item.id === evidenceId)
      if (!file) throw new Error('The attachment is not available for this investigation.')
      const { data, error } = await client.storage.from('incident-evidence')
        .createSignedUrl(file.storagePath, 60, { download: file.originalFilename })
      if (error || !data?.signedUrl) throw new Error(error?.message || 'Unable to create a secure download link.')
      const link = document.createElement('a')
      link.href = data.signedUrl
      link.target = '_blank'
      link.rel = 'noopener noreferrer'
      link.click()
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to download the attachment.')
    }
  }

  const save = async (close: boolean) => {
    if (!detail.data || !canEdit) return
    if (close && closeError) {
      setFormError(closeError)
      return
    }
    setSavingAction(close ? 'close' : 'progress')
    setFormError('')
    setFormMessage('')
    const record = {
      witness_statement: witnessStatement,
      immediate_causes: immediateCauses,
      root_cause_method: method || null,
      root_cause_breakdown: currentBreakdown,
      contributing_factors: contributingFactors,
      report_evidence_id: reportEvidenceId || null,
      attachment_ids: attachmentIds,
    }
    try {
      const { data, error } = await client.rpc('save_investigation_record', {
        target_investigation_id: investigationId,
        p_record: record,
        close_investigation: close,
      })
      if (error) throw new Error(error.message)
      const saved = investigationDetailSchema.parse(data)
      queryClient.setQueryData(['investigation-detail', investigationId], saved)
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['investigation-register'] }),
        ...(close ? [
          queryClient.invalidateQueries({ queryKey: ['incidents'] }),
          queryClient.invalidateQueries({ queryKey: ['dashboard', saved.investigation.organization_id] }),
          queryClient.invalidateQueries({ queryKey: ['incident-workflow-notifications'] }),
        ] : []),
      ])
      if (close) onClose()
      else setFormMessage('Investigation progress saved.')
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Unable to save the investigation.')
    } finally {
      setSavingAction(null)
    }
  }

  const updateFishboneCause = (heading: typeof fishboneHeadings[number], index: number, patch: Partial<{ cause: string; is_root_cause: boolean }>) => {
    if (!currentBreakdown || currentBreakdown.method !== 'fishbone') return
    setBreakdown({
      ...currentBreakdown,
      categories: {
        ...currentBreakdown.categories,
        [heading]: currentBreakdown.categories[heading].map((cause, causeIndex) => causeIndex === index ? { ...cause, ...patch } : cause),
      },
    })
  }

  const updateFaultCause = (index: number, next: FaultTreeCause) => {
    if (!currentBreakdown || currentBreakdown.method !== 'fault_tree') return
    setBreakdown({ ...currentBreakdown, causes: currentBreakdown.causes.map((cause, causeIndex) => causeIndex === index ? next : cause) })
  }

  return (
    <Dialog
      open
      onClose={onClose}
      closeOnEscape={!saving}
      closeOnBackdrop={!saving}
      className="max-w-4xl"
      title={`Investigate ${detail.data?.incident.reference_number || ''}`}
      description="Save progress at any time. Closing this investigation does not close the incident."
    >
      {detail.isPending ? <Skeleton className="h-72" /> : detail.isError ? (
        <Alert tone="danger">{detail.error.message}</Alert>
      ) : detail.data ? (
        <div className="grid gap-5">
          <fieldset disabled={!canEdit || saving} className="grid gap-5">
          <Card className="grid gap-3 p-4 shadow-none">
            <h3 className="font-semibold text-foreground">Incident summary</h3>
            <dl className="grid gap-3 sm:grid-cols-3">
              <SummaryItem label="Category" value={detail.data.incident.incident_category} />
              <SummaryItem label="Severity" value={detail.data.incident.severity} />
              <SummaryItem
                label="Site or department"
                value={[detail.data.incident.site_name, detail.data.incident.department].filter(Boolean).join(' · ')}
              />
              <SummaryItem
                label="Facility or area"
                value={[detail.data.incident.facility_name, detail.data.incident.location].filter(Boolean).join(' · ')}
              />
              <SummaryItem label="Date" value={formatDate(detail.data.incident.occurred_at)} />
              <SummaryItem label="Time" value={formatClockTime(detail.data.incident.occurred_at)} />
              <SummaryItem label="Shift" value={detail.data.incident.shift} />
            </dl>
          </Card>

          <Card className="grid gap-3 p-4 shadow-none">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-semibold text-foreground">Assigned team and deadline</h3>
              {detail.data.investigation.due_at && <Badge tone="warning">Due {formatTime(detail.data.investigation.due_at)}</Badge>}
            </div>
            <p className="text-sm text-foreground">{detail.data.assigned_team.map((member) => member.full_name).join(', ') || 'No team assigned'}</p>
          </Card>

          <Card className="grid gap-3 p-4 shadow-none">
            <h3 className="font-semibold text-foreground">Investigation timeline</h3>
            {detail.data.timeline.length ? detail.data.timeline.map((event) => (
              <div key={event.id} className="flex flex-wrap justify-between gap-2 border-b border-line py-2 last:border-0">
                <span className="text-sm text-foreground">{event.event_type.replaceAll('_', ' ')}</span>
                <time className="text-xs text-muted">{formatTime(event.created_at)}</time>
              </div>
            )) : <p className="text-sm text-muted">No activity recorded.</p>}
          </Card>

          <Field label="Witness statement (optional)">
            <Textarea value={witnessStatement} onChange={(event) => setWitnessStatement(event.target.value)} rows={4} maxLength={10000} />
          </Field>

          <Field label="Immediate causes (required)">
            <Textarea value={immediateCauses} onChange={(event) => setImmediateCauses(event.target.value)} rows={4} maxLength={5000} />
          </Field>

          <Card className="grid gap-4 p-4 shadow-none">
            <Field label="Root Cause Method (required)">
              <select
                value={method}
                onChange={(event) => setMethodValue(event.target.value as RootCauseMethod | '')}
                className="w-full rounded-lg border border-line bg-surface px-3 py-2 text-sm text-foreground"
              >
                <option value="">Select a root cause method</option>
                <option value="5_whys">5 Whys</option>
                <option value="fishbone">Fishbone</option>
                <option value="fault_tree">Fault Tree</option>
              </select>
            </Field>
            {currentBreakdown?.method === '5_whys' && (
              <div className="grid gap-3">
                <p className="text-xs text-muted">Enter each answer yourself; stop at any point, up to five linked questions.</p>
                {currentBreakdown.answers.map((answer, index) => (
                  <div key={index} className="flex items-end gap-2">
                    <Field label={`Why? ${index + 1}`} className="flex-1">
                      <Textarea value={answer} onChange={(event) => setBreakdown({
                        ...currentBreakdown,
                        answers: currentBreakdown.answers.map((value, i) => i === index ? event.target.value : value),
                      })} rows={2} />
                    </Field>
                    <Button variant="ghost" size="sm" className="text-danger" onClick={() => setBreakdown({
                      ...currentBreakdown,
                      answers: currentBreakdown.answers.filter((_, i) => i !== index),
                    })}>Remove</Button>
                  </div>
                ))}
                {currentBreakdown.answers.length < 5 && (
                  <Button variant="outline" size="sm" onClick={() => setBreakdown({
                    ...currentBreakdown,
                    answers: [...currentBreakdown.answers, ''],
                  })}>Add Why?</Button>
                )}
              </div>
            )}
            {currentBreakdown?.method === 'fishbone' && (
              <div className="grid gap-4">
                {fishboneHeadings.map((heading) => (
                  <section key={heading} className="grid gap-2">
                    <h4 className="text-sm font-semibold text-foreground">{heading}</h4>
                    {currentBreakdown.categories[heading].map((cause, index) => (
                      <div key={index} className="flex flex-wrap items-center gap-2">
                        <input
                          value={cause.cause}
                          onChange={(event) => updateFishboneCause(heading, index, { cause: event.target.value })}
                          aria-label={`${heading} cause ${index + 1}`}
                          className="min-w-[220px] flex-1 rounded-lg border border-line bg-surface px-3 py-2 text-sm text-foreground"
                        />
                        <label className="flex items-center gap-2 text-sm text-foreground">
                          <input type="checkbox" checked={cause.is_root_cause}
                            onChange={(event) => updateFishboneCause(heading, index, { is_root_cause: event.target.checked })} />
                          Root cause
                        </label>
                        <Button variant="ghost" size="sm" className="text-danger" onClick={() => setBreakdown({
                          ...currentBreakdown,
                          categories: {
                            ...currentBreakdown.categories,
                            [heading]: currentBreakdown.categories[heading].filter((_, i) => i !== index),
                          },
                        })}>Remove</Button>
                      </div>
                    ))}
                    <Button variant="outline" size="sm" onClick={() => setBreakdown({
                      ...currentBreakdown,
                      categories: {
                        ...currentBreakdown.categories,
                        [heading]: [...currentBreakdown.categories[heading], { cause: '', is_root_cause: false }],
                      },
                    })}>Add {heading} cause</Button>
                  </section>
                ))}
              </div>
            )}
            {currentBreakdown?.method === 'fault_tree' && (
              <div className="grid gap-3">
                <Field label="Top event">
                  <Textarea value={currentBreakdown.top_event} onChange={(event) => setBreakdown({ ...currentBreakdown, top_event: event.target.value })} rows={2} />
                </Field>
                <Field label="Top event gate">
                  <select value={currentBreakdown.gate} onChange={(event) => setBreakdown({
                    ...currentBreakdown, gate: event.target.value as 'AND' | 'OR',
                  })} className="w-fit rounded-lg border border-line bg-surface px-3 py-2 text-sm text-foreground">
                    <option value="AND">AND</option>
                    <option value="OR">OR</option>
                  </select>
                </Field>
                {currentBreakdown.causes.map((cause, index) => (
                  <FaultTreeEditor key={index} cause={cause}
                    onChange={(next) => updateFaultCause(index, next)}
                    onRemove={() => setBreakdown({
                      ...currentBreakdown,
                      causes: currentBreakdown.causes.filter((_, i) => i !== index),
                    })} />
                ))}
                <Button variant="outline" size="sm" onClick={() => setBreakdown({
                  ...currentBreakdown,
                  causes: [...currentBreakdown.causes, emptyFaultCause()],
                })}>Add cause</Button>
              </div>
            )}
            {currentBreakdown && (
              <p className="text-sm text-muted">
                Root cause: {(() => {
                  try { return rootCauseSummary(currentBreakdown) } catch { return 'Complete the analysis to determine the root cause.' }
                })()}
              </p>
            )}
          </Card>

          <Field label="Contributing management and system factors (optional)">
            <Textarea value={contributingFactors} onChange={(event) => setContributingFactors(event.target.value)} rows={4} maxLength={10000} />
          </Field>
          </fieldset>

          <Card className="grid gap-3 p-4 shadow-none">
            <h3 className="font-semibold text-foreground">Attachments</h3>
            <div className="grid gap-2">
              <p className="text-sm text-foreground">Investigation report (required: PDF or Word)</p>
              <input type="file" accept=".pdf,.doc,.docx,application/pdf,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                disabled={!canEdit || saving || uploadEvidence.isPending}
                onChange={(event) => void uploadSelectedFile(event, true)} />
              {report && (
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <span>{reportMetadata?.name}</span>
                  <Button variant="outline" size="sm" onClick={() => void downloadFile(report.id)}>Download</Button>
                  <Button variant="ghost" size="sm" disabled={!canEdit || saving} onClick={() => setReportEvidenceId('')}>Remove</Button>
                  {reportError && <span className="text-danger">{reportError}</span>}
                </div>
              )}
            </div>
            <div className="grid gap-2">
              <p className="text-sm text-foreground">Other attachments (optional)</p>
              <input type="file" disabled={!canEdit || saving || uploadEvidence.isPending}
                onChange={(event) => void uploadSelectedFile(event, false)} />
              {attachmentIds.map((id) => {
                const file = detail.data.attachments.find((item) => item.id === id)
                  || evidence.data?.find((item) => item.id === id)
                return file ? (
                  <div key={id} className="flex items-center gap-2 text-sm">
                    <span>{'original_filename' in file ? file.original_filename : file.originalFilename}</span>
                    <Button variant="outline" size="sm" onClick={() => void downloadFile(id)}>Download</Button>
                    <Button variant="ghost" size="sm" disabled={!canEdit || saving} onClick={() => setAttachmentIds((ids) => ids.filter((item) => item !== id))}>Remove</Button>
                  </div>
                ) : null
              })}
            </div>
          </Card>

          <Card className="grid gap-3 p-4 shadow-none">
            <h3 className="font-semibold text-foreground">Linked actions</h3>
            {detail.data.linked_actions.length ? detail.data.linked_actions.map((action) => (
              <div key={action.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-line py-2 last:border-0">
                <div><p className="text-sm font-medium">{action.description}</p><p className="text-xs text-muted">{action.type}</p></div>
                <Badge tone={action.status === 'resolved' || action.status === 'closed' ? 'success' : 'neutral'}>{action.status}</Badge>
              </div>
            )) : <p className="text-sm text-muted">No linked actions.</p>}
          </Card>

          {!canEdit && <Alert tone="warning">{detail.data.investigation.status === 'completed'
            ? 'This investigation is closed and read-only.'
            : 'You can view this investigation but are not a member of its assigned team.'}</Alert>}
          {formError && <Alert tone="danger">{formError}</Alert>}
          {formMessage && <Alert tone="success">{formMessage}</Alert>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="outline" disabled={saving} onClick={onClose}>Cancel</Button>
            <Button variant="outline" disabled={!canEdit || saving || uploadEvidence.isPending}
              loading={savingAction === 'progress'} onClick={() => void save(false)}>Save progress</Button>
            <Button disabled={!canEdit || saving || uploadEvidence.isPending || Boolean(closeError) || Boolean(reportError)}
              loading={savingAction === 'close'} onClick={() => void save(true)}>Close investigation</Button>
          </div>
        </div>
      ) : null}
    </Dialog>
  )
}

function SummaryItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted">{label}</dt>
      <dd className="mt-1 text-sm text-foreground">{value || 'Not recorded'}</dd>
    </div>
  )
}
