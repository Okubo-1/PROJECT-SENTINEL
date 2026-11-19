import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useQueryClient } from '@tanstack/react-query'

import { Alert, Button, FilterBar, Icon, PageHeader, SegmentedControl, Select, buttonVariants } from '../../components/ui'
import { createAction, downloadQhseFile, getActionsWorkspace, resolveAction, reassignAction, validateQhseFile } from './inspectionActionService'
import type { ActionRecord, ActionType, EligibleIncident, QhsePerson, QhseSite } from './inspectionActionService'
import { ActionCreateForm } from './ActionCreateForm'
import { ActionRegister } from './ActionRegister'
import { ActionSuccessModal } from './ActionSuccessModal'
import { companySettingsEventMatchesOrganization, companySettingsUpdatedEvent } from '../../lib/companySettingsSync'

function localDateTime() {
  const date = new Date(Date.now() + 24 * 60 * 60 * 1000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function FilterField({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="grid min-w-[180px] gap-1 text-[11px] font-medium text-muted">
      {label}
      {children}
    </label>
  )
}

function SummaryStat({ label, value, tone }: { label: string; value: string; tone?: 'danger' }) {
  return (
    <div className="grid gap-1 border-line sm:border-l sm:pl-5 sm:first:border-l-0 sm:first:pl-0">
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-muted">{label}</span>
      <span className={`font-display text-2xl font-semibold tabular-nums tracking-tight ${tone === 'danger' ? 'text-danger' : 'text-foreground'}`}>{value}</span>
    </div>
  )
}

export function ActionsWorkspace({ supabase, canManage, assignedOnly = false, showInspectionBack = false, canViewAllAssignedActions = false }: { supabase: SupabaseClient; canManage: boolean; assignedOnly?: boolean; showInspectionBack?: boolean; canViewAllAssignedActions?: boolean }) {
  const queryClient = useQueryClient()
  const [actions, setActions] = useState<ActionRecord[]>([])
  const [sites, setSites] = useState<QhseSite[]>([])
  const [activeSites, setActiveSites] = useState<QhseSite[]>([])
  const [people, setPeople] = useState<QhsePerson[]>([])
  const [eligibleIncidents, setEligibleIncidents] = useState<EligibleIncident[]>([])
  const [linkedIncidents, setLinkedIncidents] = useState<EligibleIncident[]>([])
  const [organizationId, setOrganizationId] = useState('')
  const [currentUserId, setCurrentUserId] = useState('')
  const [type, setType] = useState<ActionType>('corrective')
  const [incidentId, setIncidentId] = useState('')
  const [description, setDescription] = useState('')
  const [siteId, setSiteId] = useState('')
  const [assigneeId, setAssigneeId] = useState('')
  const [dueAt, setDueAt] = useState(localDateTime)
  const [resolutionAction, setResolutionAction] = useState<string | null>(null)
  const [resolutionNotes, setResolutionNotes] = useState('')
  const [proofFile, setProofFile] = useState<File | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [currentTime, setCurrentTime] = useState(() => Date.now())
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [organizationActionsView, setOrganizationActionsView] = useState(false)
  const [loadedOrganizationActionsView, setLoadedOrganizationActionsView] = useState(false)
  const [actionTypeFilter, setActionTypeFilter] = useState<'all' | ActionType>('all')
  const [actionStatusFilter, setActionStatusFilter] = useState<'all' | 'open' | 'overdue' | 'closed'>('all')
  const [successModalOpen, setSuccessModalOpen] = useState(false)
  const [createdActionId, setCreatedActionId] = useState<string | null>(null)
  const submitInProgress = useRef(false)

  const refresh = useCallback(async () => {
    const data = await getActionsWorkspace(supabase, assignedOnly, assignedOnly && organizationActionsView)
    setOrganizationId(data.organizationId)
    setCurrentUserId(data.userId)
    setActions(data.actions)
    setSites(data.sites)
    setActiveSites(data.activeSites)
    setPeople(data.people)
    setEligibleIncidents(data.eligibleIncidents)
    setLinkedIncidents(data.linkedIncidents)
    setLoadedOrganizationActionsView(organizationActionsView)
    setSiteId((current) => current || data.activeSites[0]?.id || '')
    setAssigneeId((current) => current || data.people[0]?.id || '')
  }, [supabase, assignedOnly, organizationActionsView])

  useEffect(() => {
    let active = true
    void getActionsWorkspace(supabase, assignedOnly, assignedOnly && organizationActionsView).then((data) => {
      if (!active) return
      setError('')
      setOrganizationId(data.organizationId)
      setCurrentUserId(data.userId)
      setActions(data.actions)
      setSites(data.sites)
      setActiveSites(data.activeSites)
      setPeople(data.people)
      setEligibleIncidents(data.eligibleIncidents)
      setLinkedIncidents(data.linkedIncidents)
      setLoadedOrganizationActionsView(organizationActionsView)
      setSiteId(data.activeSites[0]?.id || '')
      setAssigneeId(data.people[0]?.id || '')
    }).catch((loadError: unknown) => {
      if (active) {
        setLoadedOrganizationActionsView(organizationActionsView)
        setError(loadError instanceof Error ? loadError.message : 'Unable to load actions.')
      }
    }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [assignedOnly, organizationActionsView, supabase])

  useEffect(() => {
    if (!organizationId) return
    const handleSettingsUpdated = (event: Event) => {
      if (!companySettingsEventMatchesOrganization(event, organizationId)) return
      void refresh().catch((loadError: unknown) => {
        setError(loadError instanceof Error ? loadError.message : 'Unable to refresh actions.')
      })
    }
    window.addEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
    return () => window.removeEventListener(companySettingsUpdatedEvent, handleSettingsUpdated)
  }, [organizationId, refresh])

  useEffect(() => {
    const timer = window.setInterval(() => setCurrentTime(Date.now()), 60_000)
    return () => window.clearInterval(timer)
  }, [])

  const finishMutation = async (successMessage: string) => {
    await refresh()
    if (organizationId) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dashboard', organizationId] }),
        queryClient.invalidateQueries({ queryKey: ['incidents'] }),
        queryClient.invalidateQueries({ queryKey: ['investigation-register'] }),
        queryClient.invalidateQueries({ queryKey: ['incident-workflow-notifications'] }),
      ])
    }
    if (assignedOnly && organizationId && currentUserId) {
      await queryClient.invalidateQueries({ queryKey: ['assigned-action-count', organizationId, currentUserId] })
    }
    setMessage(successMessage)
  }

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (submitInProgress.current) return
    submitInProgress.current = true
    setBusy(true)
    setError('')
    setMessage('')
    try {
      const result = await createAction(supabase, { type, description, siteId, assigneeId, dueAt, incidentId: incidentId || null })
      await finishMutation(result.notificationWarning || 'Action created and assigned.')
      setCreatedActionId(result.actionId)
      setSuccessModalOpen(true)
      setDescription('')
      setIncidentId('')
      setDueAt(localDateTime())
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : 'Unable to create the action.')
    } finally {
      submitInProgress.current = false
      setBusy(false)
    }
  }

  const reassign = async (action: ActionRecord, nextAssigneeId: string) => {
    setBusy(true)
    setError('')
    try {
      const result = await reassignAction(supabase, action.id, nextAssigneeId)
      await finishMutation(result.notificationWarning || 'Action reassigned.')
    } catch (assignError) {
      setError(assignError instanceof Error ? assignError.message : 'Unable to reassign the action.')
    } finally {
      setBusy(false)
    }
  }

  const resolve = async (action: ActionRecord) => {
    setBusy(true)
    setError('')
    try {
      validateQhseFile(proofFile)
      await resolveAction(supabase, action, resolutionNotes, proofFile)
      setResolutionAction(null)
      setResolutionNotes('')
      setProofFile(null)
      await finishMutation('Action resolved.')
    } catch (resolveError) {
      setError(resolveError instanceof Error ? resolveError.message : 'Unable to resolve the action.')
    } finally {
      setBusy(false)
    }
  }

  const workspaceLoading = loading || (assignedOnly && canViewAllAssignedActions && loadedOrganizationActionsView !== organizationActionsView)
  const requestedActionId = new URLSearchParams(window.location.hash.split('?')[1] || '').get('action')
  const filteredActions = actions.filter((action) => {
    if (actionTypeFilter !== 'all' && action.type !== actionTypeFilter) return false
    if (actionStatusFilter === 'open') return action.status === 'open'
    if (actionStatusFilter === 'overdue') return action.status === 'open' && new Date(action.due_at).getTime() < currentTime
    if (actionStatusFilter === 'closed') return action.status === 'resolved'
    return true
  })
  useEffect(() => {
    if (workspaceLoading && assignedOnly) return
    if (requestedActionId && actions.some((action) => action.id === requestedActionId)) {
      document.getElementById(`action-${requestedActionId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [actions, assignedOnly, requestedActionId, workspaceLoading])
  const returnToInspection = () => {
    const returnKey = new URLSearchParams(window.location.hash.split('?')[1] || '').get('return')
    const storageKey = returnKey && /^[\da-f-]{36}$/i.test(returnKey) ? `actions-return:${returnKey}` : ''
    if (storageKey && sessionStorage.getItem(storageKey) === 'inspections') {
      sessionStorage.removeItem(storageKey)
      window.history.back()
      return
    }
    const url = new URL(window.location.href)
    url.hash = '#inspections'
    window.location.replace(url.toString())
  }

  const openCount = actions.filter((action) => action.status === 'open').length
  const overdueCount = actions.filter((action) => action.status === 'open' && new Date(action.due_at).getTime() < currentTime).length
  const closedCount = actions.filter((action) => action.status === 'resolved').length

  return (
    <div className="grid gap-5">
      <PageHeader
        eyebrow="Operations & QHSE"
        title={assignedOnly ? 'Assigned actions' : 'Actions'}
        description={assignedOnly ? 'Actions assigned to your account.' : 'Create, assign, and track organization actions.'}
        actions={
          <>
            {showInspectionBack && (
              <Button variant="outline" size="sm" onClick={returnToInspection}>
                <Icon name="arrowLeft" size={15} />Back
              </Button>
            )}
            {canManage && !assignedOnly && (
              <a href="#assigned-actions" className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                Assigned actions
              </a>
            )}
          </>
        }
      />

      {error && <Alert tone="danger">{error}</Alert>}
      {message && !successModalOpen && <Alert tone="success">{message}</Alert>}

      <section className="border-y border-line">
        <div className="grid grid-cols-2 gap-4 py-4 sm:grid-cols-4">
          <SummaryStat label="Actions" value={String(actions.length)} />
          <SummaryStat label="Open" value={String(openCount)} />
          <SummaryStat label="Overdue" value={String(overdueCount)} tone={overdueCount ? 'danger' : undefined} />
          <SummaryStat label="Closed" value={String(closedCount)} />
        </div>
      </section>

      {canManage && !assignedOnly && (
        <ActionCreateForm
          type={type}
          onTypeChange={(nextType) => { setType(nextType); setIncidentId('') }}
          siteId={siteId}
          onSiteChange={setSiteId}
          assigneeId={assigneeId}
          onAssigneeChange={setAssigneeId}
          dueAt={dueAt}
          onDueAtChange={setDueAt}
          incidentId={incidentId}
          onIncidentChange={setIncidentId}
          description={description}
          onDescriptionChange={setDescription}
          sites={activeSites}
          people={people}
          eligibleIncidents={eligibleIncidents}
          busy={busy}
          loading={loading}
          onSubmit={(event) => void submit(event)}
        />
      )}

      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-display text-lg font-semibold tracking-tight text-foreground">{assignedOnly ? 'My assigned actions' : 'Action register'}</h2>
          <p className="text-sm text-muted">{filteredActions.length} of {actions.length} actions</p>
        </div>
        {assignedOnly && canViewAllAssignedActions && (
          <SegmentedControl
            label="Assigned action view"
            value={organizationActionsView ? 'organization' : 'mine'}
            onChange={(value) => {
              setOrganizationActionsView(value === 'organization')
              setResolutionAction(null)
            }}
            options={[{ value: 'mine', label: 'My assigned' }, { value: 'organization', label: 'Organization assigned' }]}
          />
        )}
      </div>

      <FilterBar
        actions={<Button variant="ghost" size="sm" onClick={() => { setActionTypeFilter('all'); setActionStatusFilter('all') }}>Reset filters</Button>}
      >
        <FilterField label="Action type">
          <Select value={actionTypeFilter} onChange={(event) => setActionTypeFilter(event.target.value as 'all' | ActionType)}>
            <option value="all">All action types</option>
            <option value="corrective">Corrective actions</option>
            <option value="preventive">Preventive actions</option>
            <option value="investigation">Investigations</option>
          </Select>
        </FilterField>
        <FilterField label="Action status">
          <Select value={actionStatusFilter} onChange={(event) => setActionStatusFilter(event.target.value as 'all' | 'open' | 'overdue' | 'closed')}>
            <option value="all">All statuses</option>
            <option value="open">Open actions</option>
            <option value="overdue">Overdue actions</option>
            <option value="closed">Closed actions</option>
          </Select>
        </FilterField>
      </FilterBar>

      <ActionRegister
        filteredActions={filteredActions}
        workspaceLoading={workspaceLoading}
        currentTime={currentTime}
        currentUserId={currentUserId}
        canManage={canManage}
        assignedOnly={assignedOnly}
        busy={busy}
        resolutionAction={resolutionAction}
        resolutionNotes={resolutionNotes}
        proofFile={proofFile}
        sites={sites}
        people={people}
        linkedIncidents={linkedIncidents}
        onToggleResolve={(action) => {
          setResolutionAction((current) => current === action.id ? null : action.id)
          setResolutionNotes('')
          setProofFile(null)
        }}
        onResolutionNotesChange={setResolutionNotes}
        onProofFileChange={setProofFile}
        onCancelResolve={() => { setResolutionAction(null); setResolutionNotes(''); setProofFile(null) }}
        onResolve={(action) => void resolve(action)}
        onReassign={(action, nextAssigneeId) => void reassign(action, nextAssigneeId)}
        onDownloadProof={(action) => {
          if (!action.proof_storage_path || !action.proof_file_name) return
          void downloadQhseFile(supabase, action.proof_storage_path, action.proof_file_name).catch((downloadError: unknown) => {
            setError(downloadError instanceof Error ? downloadError.message : 'Unable to download proof.')
          })
        }}
      />

      <ActionSuccessModal
        open={successModalOpen}
        onClose={() => {
          setSuccessModalOpen(false)
          setCreatedActionId(null)
        }}
        onViewInRegister={() => {
          if (createdActionId) {
            setSuccessModalOpen(false)
            setCreatedActionId(null)
            window.location.hash = `#corrective-actions?action=${createdActionId}`
          }
        }}
      />
    </div>
  )
}
