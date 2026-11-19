import { useEffect, useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useQuery, useQueryClient } from '@tanstack/react-query'

import {
  Alert,
  Avatar,
  Button,
  Card,
  ConfirmDialog,
  DetailList,
  Dialog,
  EmptyState,
  Icon,
  PageHeader,
  SeverityBadge,
  Skeleton,
  StatusBadge,
  Textarea,
  Timeline,
  buttonVariants,
} from '../../components/ui'
import {
  useDeleteIncidentEvidence,
  useDownloadIncidentEvidence,
  useIncident,
  useIncidentOrganization,
  useIncidentActivity,
  useIncidentEvidence,
  useUploadIncidentEvidence,
} from './useIncidentData'
import type { IncidentEvidence } from './incidentTypes'
import { getIncidentClosure } from './incidentClosureService'
import { getActionsForIncidents, getVerifierIncidentActions } from '../qhse/inspectionActionService'
import { InvestigationDialog } from '../qhse/InvestigationDialog'
import { effectiveIncidentSeverityLabel } from '../../../supabase/functions/_shared/incidentReportFilters'
import { BooleanBadge, SectionTitle } from './IncidentDetailSection'
import { IncidentEvidenceCard } from './IncidentEvidenceCard'
import { IncidentLinkedActionsCard } from './IncidentLinkedActionsCard'
import { formatDate, formatLabel } from './incidentDetailFormatting'

// This screen brings together the incident record, its activity history, and its evidence files.
// Closure evidence is read separately so older records are not given invented closure details.
export function IncidentDetailPage({ supabase, incidentId, canClose = false, canReopen = false }: {
  supabase: SupabaseClient
  incidentId: string | null
  canClose?: boolean
  canReopen?: boolean
}) {
  const queryClient = useQueryClient()
  const incident = useIncident(supabase, incidentId)
  const organization = useIncidentOrganization(supabase)
  const activity = useIncidentActivity(supabase, incidentId)
  const evidence = useIncidentEvidence(supabase, incidentId)
  const uploadEvidence = useUploadIncidentEvidence(supabase)
  const deleteEvidence = useDeleteIncidentEvidence(supabase)
  const downloadEvidence = useDownloadIncidentEvidence(supabase)
  const [evidenceMessage, setEvidenceMessage] = useState('')
  const [evidenceError, setEvidenceError] = useState('')
  const [investigationOpen, setInvestigationOpen] = useState(false)
  const [viewedIncidentId, setViewedIncidentId] = useState<string | null>(null)
  const investigationViewed = incidentId !== null && viewedIncidentId === incidentId
  const [closeoutBusy, setCloseoutBusy] = useState(false)
  const [closeoutError, setCloseoutError] = useState('')
  const [reopenOpen, setReopenOpen] = useState(false)
  const [reopenHandlerId, setReopenHandlerId] = useState('')
  const [reopenReason, setReopenReason] = useState('')
  const [reopenBusy, setReopenBusy] = useState(false)
  const [reopenError, setReopenError] = useState('')
  const [pendingDelete, setPendingDelete] = useState<IncidentEvidence | null>(null)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const investigation = useQuery({
    queryKey: ['incident-investigation', incident.data?.organizationId || 'pending', incidentId || 'pending'],
    queryFn: async () => {
      const { data, error } = await supabase.from('investigations')
        .select('id, status')
        .eq('organization_id', incident.data!.organizationId)
        .eq('incident_id', incidentId!)
        .maybeSingle()
      if (error) throw new Error('Unable to load the investigation for this incident.')
      return data
    },
    enabled: Boolean((canClose || canReopen) && incident.data?.organizationId && incidentId),
  })
  const reopenHandlers = useQuery({
    queryKey: ['incident-reopen-handlers', incident.data?.organizationId || 'pending'],
    queryFn: async () => {
      const { data, error } = await supabase.from('profiles')
        .select('id, full_name')
        .eq('organization_id', incident.data!.organizationId)
        .eq('account_status', 'active')
        .order('full_name')
      if (error) throw new Error('Unable to load active incident handlers.')
      return data || []
    },
    enabled: Boolean(canReopen && incident.data?.organizationId),
  })
  const closure = useQuery({
    queryKey: ['incident-closure', incident.data?.organizationId, incidentId, organization.data?.userId],
    queryFn: () => getIncidentClosure(supabase, incidentId!),
    enabled: Boolean(organization.data?.userId && incidentId && incident.data?.status === 'closed'),
  })
  const linkedActions = useQuery({
    queryKey: ['incident-linked-actions', incident.data?.organizationId || 'pending', organization.data?.userId || 'pending', incidentId || 'pending', canClose],
    queryFn: () => canClose
      ? getVerifierIncidentActions(supabase, incidentId!)
      : getActionsForIncidents(supabase, incident.data!.organizationId, [incidentId!]),
    enabled: Boolean(incident.data?.organizationId && incidentId),
  })
  const currentUserResolvedAction = Boolean(linkedActions.data?.some((action) =>
    action.resolved_by === organization.data?.userId))

  const refreshWorkflow = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['incidents'] }),
      queryClient.invalidateQueries({ queryKey: ['dashboard', incident.data?.organizationId] }),
      queryClient.invalidateQueries({ queryKey: ['investigation-register'] }),
      queryClient.invalidateQueries({ queryKey: ['incident-workflow-notifications'] }),
      queryClient.invalidateQueries({ queryKey: ['incident-investigation'] }),
    ])
    if (incident.data?.organizationId && incidentId) {
      await queryClient.invalidateQueries({
        queryKey: ['incidents', 'detail', incident.data.organizationId, incidentId],
      })
    }
  }

  const confirmCloseout = async () => {
    if (!incidentId || !investigationViewed || currentUserResolvedAction) return
    setCloseoutBusy(true)
    setCloseoutError('')
    try {
      const { error } = await supabase.rpc('confirm_incident_closeout', {
        target_incident_id: incidentId,
      })
      if (error) throw new Error(error.message)
      setViewedIncidentId(null)
      await refreshWorkflow()
    } catch (error) {
      setCloseoutError(error instanceof Error ? error.message : 'Unable to confirm incident close-out.')
    } finally {
      setCloseoutBusy(false)
    }
  }

  const reopenIncident = async () => {
    if (!incidentId || !reopenHandlerId) return
    setReopenBusy(true)
    setReopenError('')
    try {
      const { error } = await supabase.rpc('reopen_incident', {
        target_incident_id: incidentId,
        p_assigned_to: reopenHandlerId,
        p_reason: reopenReason.trim() || null,
      })
      if (error) throw new Error(error.message)
      setReopenOpen(false)
      setViewedIncidentId(null)
      setReopenReason('')
      setReopenHandlerId('')
      await refreshWorkflow()
    } catch (error) {
      setReopenError(error instanceof Error ? error.message : 'Unable to reopen this incident.')
    } finally {
      setReopenBusy(false)
    }
  }

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  if (!incidentId) {
    return (
      <EmptyState
        icon="incidents"
        title="No incident selected"
        description="Open an incident from My Reports or Incident Management."
        action={<a href="#my-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Return to My Reports</a>}
      />
    )
  }

  if (organization.isLoading || incident.isLoading) {
    return (
      <div className="grid gap-5">
        <PageHeader eyebrow="Incident detail" title="Loading incident" description="Fetching the record, evidence, and activity." />
        <div className="grid gap-5 xl:grid-cols-12">
          <Skeleton className="h-[260px] rounded-card xl:col-span-4" />
          <Skeleton className="h-[260px] rounded-card xl:col-span-8" />
          <Skeleton className="h-[220px] rounded-card xl:col-span-6" />
          <Skeleton className="h-[220px] rounded-card xl:col-span-6" />
        </div>
      </div>
    )
  }

  if (incident.isError || !incident.data) {
    return (
      <EmptyState
        icon="incidents"
        title="Incident unavailable"
        description="It may not exist, or you may not have access to it."
        action={<a href="#my-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Return to My Reports</a>}
      />
    )
  }

  const data = incident.data
  const evidenceFiles = evidence.data || data.evidence
  const effectiveSeverity = effectiveIncidentSeverityLabel(data.severity, data.potentialSeverity)

  const handleUploadFile = async (file: File) => {
    if (!incidentId) return
    setEvidenceError('')
    setEvidenceMessage('')
    try {
      const evidence = await uploadEvidence.mutateAsync({ incidentId, file })
      setEvidenceMessage(evidence.sanitization === 'unverified'
        ? 'Evidence uploaded privately. It may contain identifying details; sanitization could not be verified.'
        : 'Evidence uploaded securely.')
    } catch (error) {
      setEvidenceError(error instanceof Error ? error.message : 'Unable to upload evidence.')
    }
  }

  const handleDownload = async (evidenceId: string) => {
    setEvidenceError('')
    try {
      const result = await downloadEvidence.mutateAsync(evidenceId)
      const url = URL.createObjectURL(result.blob)
      const link = document.createElement('a')
      link.href = url
      link.download = result.filename
      link.click()
      URL.revokeObjectURL(url)
    } catch (error) {
      setEvidenceError(error instanceof Error ? error.message : 'Unable to download evidence.')
    }
  }

  const confirmDelete = async () => {
    if (!incidentId || !pendingDelete) return
    setEvidenceError('')
    try {
      await deleteEvidence.mutateAsync({ evidenceId: pendingDelete.id, organizationId: data.organizationId, incidentId })
      setEvidenceMessage('Evidence removed.')
      setPendingDelete(null)
    } catch (error) {
      setEvidenceError(error instanceof Error ? error.message : 'You are not authorized to remove this evidence.')
    }
  }

  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Incident detail"
        title={data.title}
        description={`${data.referenceNumber} · ${formatLabel(data.reportType)}`}
        actions={
          <>
            {canClose && investigation.data && (
              <Button variant="outline" size="sm" onClick={() => setInvestigationOpen(true)}>
                Investigation
              </Button>
            )}
            {canClose && data.status === 'pending_verification' && (
              <Button
                variant="danger"
                size="sm"
                disabled={!investigationViewed || currentUserResolvedAction || linkedActions.isLoading || linkedActions.isError || closeoutBusy}
                loading={closeoutBusy}
                onClick={() => void confirmCloseout()}
              >
                Confirm close-out
              </Button>
            )}
            {canReopen && (data.status === 'closed' || investigation.data?.status === 'completed') && (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setReopenHandlerId(reopenHandlers.data?.[0]?.id || '')
                  setReopenOpen(true)
                }}
              >
                Reopen
              </Button>
            )}
            <a href="#my-reports" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
              <Icon name="arrowLeft" size={15} />My reports
            </a>
            <a href="#incidents" className={buttonVariants({ variant: 'outline', size: 'sm' })}>Incident management</a>
          </>
        }
      />

      <div className="grid gap-5 xl:grid-cols-12">
        <Card className="h-full p-5 shadow-none xl:col-span-4">
          <SectionTitle title="At a glance" />
          <div className="mt-4 flex flex-wrap items-center gap-2">
            <StatusBadge
              status={data.status}
              label={data.status === 'pending_verification' ? 'Resolved, awaiting verification' : undefined}
            />
            <SeverityBadge severity={effectiveSeverity.toLowerCase()} />
          </div>
          <DetailList
            className="mt-4"
            columns={2}
            items={[
              { label: 'Reference', value: data.referenceNumber },
              { label: 'Occurred', value: formatDate(data.occurredAt) },
              { label: 'Reported', value: formatDate(data.reportedAt) },
              { label: 'Site', value: data.siteName || 'Not available' },
              { label: 'Department', value: data.department || 'Not available' },
              { label: 'Shift', value: data.shift || 'Not available' },
              { label: 'Reporter', value: data.reportedBy },
            ]}
          />
        </Card>

        <Card className="h-full p-5 shadow-none xl:col-span-8">
          <SectionTitle title="Event information" />
          <p className="mt-4 text-sm leading-relaxed text-foreground">{data.description || 'No description recorded.'}</p>
          <DetailList
            className="mt-4"
            columns={2}
            items={[
              { label: 'Occurrence', value: formatDate(data.occurredAt) },
              { label: 'Reported', value: formatDate(data.reportedAt) },
              { label: 'Location', value: data.location || 'Not available' },
              { label: 'Department', value: data.department || 'Not available' },
              { label: 'Shift', value: data.shift || 'Not available' },
              { label: 'Work/activity context', value: data.workActivityContext || 'Not available' },
            ]}
          />
        </Card>

        <Card className="h-full p-5 shadow-none xl:col-span-6">
          <SectionTitle title="Classification" />
          <DetailList
            className="mt-4"
            columns={2}
            items={[
              { label: 'Report type', value: formatLabel(data.reportType) },
              { label: 'Status', value: (
                <StatusBadge
                  status={data.status}
                  label={data.status === 'pending_verification' ? 'Resolved, awaiting verification' : undefined}
                />
              ) },
              { label: 'Actual severity', value: <SeverityBadge severity={data.severity?.toLowerCase()} /> },
              { label: 'Potential severity', value: <SeverityBadge severity={data.potentialSeverity?.toLowerCase()} /> },
              { label: 'Incident category', value: data.incidentCategory || 'Not available' },
              { label: 'Environmental impact', value: <BooleanBadge value={data.environmentalImpact} /> },
              { label: 'Injury or illness', value: <BooleanBadge value={data.injuryOrIllness} /> },
              { label: 'Property damage', value: <BooleanBadge value={data.propertyDamage} /> },
              { label: 'Work-related', value: <BooleanBadge value={data.workRelated} /> },
            ]}
          />
        </Card>

        <Card className="h-full p-5 shadow-none xl:col-span-6">
          <SectionTitle title="People and involvement" />
          <DetailList
            className="mt-4"
            columns={2}
            items={[
              { label: 'Reporter', value: data.reportedBy },
              { label: 'Contractor involved', value: <BooleanBadge value={data.contractorInvolved} /> },
              { label: 'Contractor organization', value: data.contractorOrganization || 'Not available' },
            ]}
          />
          {data.people.length ? (
            <div className="mt-4 grid gap-2">
              {data.people.map((person) => (
                <div key={person.id} className="flex items-center gap-3 rounded-xl border border-line bg-surface px-3 py-2">
                  <Avatar name={person.fullName} size="sm" />
                  <div className="grid min-w-0">
                    <span className="truncate text-sm font-medium text-foreground">{person.fullName}</span>
                    <span className="truncate text-xs text-muted">
                      {formatLabel(person.personType)}{person.organizationName ? ` · ${person.organizationName}` : ''}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-4 text-sm text-muted">No affected person or witness records.</p>
          )}
        </Card>

        <Card className="h-full p-5 shadow-none xl:col-span-6">
          <SectionTitle title="Immediate correction" />
          <p className="mt-4 text-sm leading-relaxed text-foreground">
            {data.immediateCorrection || 'No immediate correction has been recorded.'}
          </p>
          <p className="mt-3 text-xs text-muted">Corrective and preventive actions are tracked in the Action register.</p>
        </Card>

        <IncidentLinkedActionsCard
          className="xl:col-span-6"
          actions={linkedActions.data}
          loading={linkedActions.isLoading}
          error={linkedActions.isError ? linkedActions.error.message : null}
          currentTime={currentTime}
        />

        <IncidentEvidenceCard
          className={data.status === 'closed' ? 'xl:col-span-7' : 'xl:col-span-12'}
          files={evidenceFiles}
          loading={evidence.isLoading}
          loadError={evidence.isError}
          message={evidenceMessage}
          error={evidenceError}
          uploadPending={uploadEvidence.isPending}
          downloadPending={downloadEvidence.isPending}
          deletePending={deleteEvidence.isPending}
          onUpload={(file) => void handleUploadFile(file)}
          onDownload={(id) => void handleDownload(id)}
          onRemove={(file) => setPendingDelete(file)}
        />

        {data.status === 'closed' && (
          <Card className="h-full p-5 shadow-none xl:col-span-5">
            <SectionTitle title="Closure" />
            {closure.isPending ? (
              <Skeleton className="mt-4 h-24" />
            ) : closure.isError ? (
              <Alert tone="danger" className="mt-4">{closure.error.message}</Alert>
            ) : closure.data ? (
              <DetailList
                className="mt-4"
                columns={1}
                items={[
                  { label: 'Root cause', value: closure.data.root_cause },
                  { label: 'Completed corrective action', value: closure.data.corrective_action },
                  { label: 'Closed at', value: formatDate(closure.data.closed_at) },
                  { label: 'Closed by (user ID)', value: closure.data.closed_by },
                ]}
              />
            ) : (
              <p className="mt-4 text-sm text-muted">This incident was closed before the structured closure form was introduced. No closure details are available in the new record.</p>
            )}
          </Card>
        )}

        <Card className="p-5 shadow-none xl:col-span-12">
          <SectionTitle title="Activity" />
          {activity.isLoading ? (
            <Skeleton className="mt-4 h-24" />
          ) : activity.isError ? (
            <Alert tone="danger" className="mt-4">Unable to load incident history.</Alert>
          ) : activity.data?.length ? (
            <Timeline
              className="mt-4"
              items={activity.data.map((item) => ({
                time: formatDate(item.createdAt),
                title: item.activity,
                meta: item.location || 'Organization workspace',
              }))}
            />
          ) : (
            <p className="mt-4 text-sm text-muted">No incident activity has been recorded.</p>
          )}
        </Card>
      </div>

      {closeoutError && <Alert tone="danger">{closeoutError}</Alert>}
      {data.status === 'pending_verification' && canClose && (
        <p className="text-sm text-muted">
          {currentUserResolvedAction
            ? 'A person who resolved an action on this incident cannot verify its close-out.'
            : investigationViewed
              ? 'Investigation viewed. You may confirm close-out.'
              : 'Open the investigation before confirming close-out.'}
        </p>
      )}
      {investigation.isError && canClose && <Alert tone="danger">{investigation.error.message}</Alert>}
      {investigationOpen && investigation.data?.id && (
        <InvestigationDialog
          client={supabase}
          investigationId={investigation.data.id}
          onClose={() => setInvestigationOpen(false)}
          onVerificationViewed={data.status === 'pending_verification'
            ? () => setViewedIncidentId(incidentId)
            : undefined}
        />
      )}

      {reopenOpen && canReopen && (
        <Dialog
          open
          onClose={() => !reopenBusy && setReopenOpen(false)}
          title={`Reopen incident ${data.referenceNumber}`}
          description="Choose the handler. The selected handler and investigation team will be notified."
        >
          <div className="grid gap-4">
            {reopenHandlers.isLoading ? (
              <Skeleton className="h-10" />
            ) : reopenHandlers.isError ? (
              <Alert tone="danger">{reopenHandlers.error.message}</Alert>
            ) : (
              <label className="grid gap-1 text-sm font-medium text-foreground">
                Assigned handler
                <select
                  className="rounded-lg border border-line bg-surface px-3 py-2"
                  value={reopenHandlerId}
                  onChange={(event) => setReopenHandlerId(event.target.value)}
                  disabled={reopenBusy}
                >
                  <option value="">Select a handler</option>
                  {reopenHandlers.data?.map((person) => (
                    <option key={person.id} value={person.id}>{person.full_name}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="grid gap-1 text-sm font-medium text-foreground">
              Reason (optional)
              <Textarea
                value={reopenReason}
                onChange={(event) => setReopenReason(event.target.value)}
                maxLength={5000}
                rows={3}
                disabled={reopenBusy}
              />
            </label>
            {reopenError && <Alert tone="danger">{reopenError}</Alert>}
            <div className="flex justify-end gap-2">
              <Button variant="outline" disabled={reopenBusy} onClick={() => setReopenOpen(false)}>Cancel</Button>
              <Button disabled={!reopenHandlerId || reopenHandlers.isLoading || reopenHandlers.isError}
                loading={reopenBusy} onClick={() => void reopenIncident()}>
                Reopen incident
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        onClose={() => setPendingDelete(null)}
        onConfirm={() => void confirmDelete()}
        title="Remove evidence?"
        description={pendingDelete ? `This permanently removes ${pendingDelete.originalFilename}.` : undefined}
        confirmLabel="Remove"
        loading={deleteEvidence.isPending}
      />
    </div>
  )
}
