import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'

import {
  createIncidentDraft,
  deleteIncidentEvidence,
  getIncident,
  getIncidentActivity,
  getIncidentEvidence,
  getIncidents,
  getOrganizationContext,
  downloadIncidentEvidence,
  submitIncident,
  submitNewIncident,
  updateIncidentDraft,
  uploadIncidentEvidence,
  uploadInvestigationEvidence,
  type IncidentActivity,
  type IncidentListResult,
} from './incidentService'
import { incidentQueryKeys } from './incidentQueryKeys'
import { getIncidentClosureAccess } from './incidentClosureService'
import { invalidateSafetyIntelligence } from '../safety-intelligence/safetyIntelligenceQueryKeys'
import { syncQueuedIncidentSubmissions } from './incidentOfflineQueue'
import { syncOfflineAnonymousDrafts } from './anonymousDraftQueue'
import type { IncidentDetail, IncidentDraftInput, IncidentEvidence, IncidentListFilters, IncidentListScope, IncidentSubmissionInput, IncidentSummary } from './incidentTypes'

export function useIncidentClosureAccess(client: SupabaseClient, organizationId: string, userId: string, enabled = true) {
  return useQuery({
    // Delegated access is personal, even when two users belong to the same organization.
    queryKey: ['incident-closure-access', organizationId, userId],
    queryFn: () => getIncidentClosureAccess(client, organizationId),
    enabled: Boolean(enabled && organizationId && userId),
    staleTime: 0,
    refetchOnWindowFocus: true,
  })
}

// Resolve the signed-in user first, then load the organization context needed by incident queries.
export function useIncidentOrganization(client: SupabaseClient) {
  const session = useQuery({
    queryKey: ['incident-auth-session'],
    queryFn: async () => {
      const { data, error } = await client.auth.getSession()
      if (error || !data.session?.user.id) throw new Error('Your session is no longer valid.')
      return data.session.user.id
    },
    staleTime: 0,
    refetchOnMount: true,
  })
  return useQuery({
    queryKey: ['organization-context', session.data || 'pending'],
    queryFn: () => getOrganizationContext(client),
    enabled: Boolean(session.data),
    staleTime: 60_000,
    refetchOnMount: true,
  })
}

export function useIncidentOfflineSync(client: SupabaseClient, enabled = true) {
  const queryClient = useQueryClient()

  // Try queued submissions when the app starts and again when the browser reports that it is online.
  useEffect(() => {
    if (!enabled) return
    let active = true
    const sync = async () => {
      if (!active) return
      try {
        const result = await syncQueuedIncidentSubmissions(client)
        if (result.submitted.length) {
          await queryClient.invalidateQueries({ queryKey: incidentQueryKeys.all })
          await queryClient.invalidateQueries({ queryKey: ['dashboard', result.submitted[0].organizationId] })
          await invalidateSafetyIntelligence(queryClient, result.submitted[0].organizationId)
        }
      } catch {
        // Keep queued items for a later reconnect attempt.
      }
      try {
        const result = await syncOfflineAnonymousDrafts(client)
        if (result.failed) console.error('Some anonymous drafts could not be synchronized and remain on this device.')
        if (result.saved.length) {
          await queryClient.invalidateQueries({ queryKey: incidentQueryKeys.all })
          await invalidateSafetyIntelligence(queryClient, result.saved[0].organizationId)
        }
      } catch {
        console.error('Unable to synchronize anonymous drafts; they remain on this device.')
      }
    }
    const handleOnline = () => { void sync() }
    void sync()
    window.addEventListener('online', handleOnline)
    return () => {
      active = false
      window.removeEventListener('online', handleOnline)
    }
  }, [client, enabled, queryClient])
}

export function useIncidents(client: SupabaseClient, filters: IncidentListFilters = {}, scope: IncidentListScope = 'organization') {
  const organization = useIncidentOrganization(client)
  const queryClient = useQueryClient()
  // Refresh only this organization's incident lists and dashboard when another workflow announces a record change.
  useEffect(() => {
    const organizationId = organization.data?.organizationId
    if (!organizationId) return
    const handleIncidentRecordsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ organizationId?: string }>).detail
      if (detail?.organizationId === organizationId) {
        void queryClient.invalidateQueries({ queryKey: ['incidents', 'list', organizationId] })
        void queryClient.invalidateQueries({ queryKey: ['dashboard', organizationId] })
        void invalidateSafetyIntelligence(queryClient, organizationId)
      }
    }
    window.addEventListener('incident-records-updated', handleIncidentRecordsUpdated)
    return () => window.removeEventListener('incident-records-updated', handleIncidentRecordsUpdated)
  }, [organization.data?.organizationId, queryClient])

  return useQuery<IncidentListResult>({
    queryKey: [...incidentQueryKeys.list(organization.data?.organizationId || 'pending', scope, filters), organization.data?.userId],
    queryFn: () => getIncidents(client, filters, scope),
    enabled: Boolean(organization.data?.organizationId),
    staleTime: 0,
    refetchOnMount: 'always',
    refetchOnWindowFocus: true,
  })
}

export function useIncident(client: SupabaseClient, incidentId: string | null) {
  const organization = useIncidentOrganization(client)
  return useQuery<IncidentDetail>({
    queryKey: [...incidentQueryKeys.detail(organization.data?.organizationId || 'pending', incidentId || 'pending'), organization.data?.userId],
    queryFn: () => getIncident(client, incidentId as string),
    enabled: Boolean(organization.data?.organizationId && incidentId),
    staleTime: 30_000,
  })
}

// A new draft should appear in report lists as soon as the server confirms it was saved.
export function useCreateIncidentDraft(client: SupabaseClient) {
  const queryClient = useQueryClient()
  return useMutation<IncidentSummary, Error, IncidentDraftInput>({
    mutationFn: (input) => createIncidentDraft(client, input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: incidentQueryKeys.all }),
  })
}

// Refresh both list and detail queries so reopened drafts show their latest fields and saved stage.
export function useUpdateIncidentDraft(client: SupabaseClient) {
  const queryClient = useQueryClient()
  return useMutation<IncidentSummary, Error, { incidentId: string; input: IncidentDraftInput }>({
    mutationFn: ({ incidentId, input }) => updateIncidentDraft(client, incidentId, input),
    onSuccess: (incident) => {
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.all })
      queryClient.invalidateQueries({ queryKey: ['incidents', 'detail', incident.organizationId, incident.id] })
      void invalidateSafetyIntelligence(queryClient, incident.organizationId)
    },
  })
}

// Submission changes the incident status and dashboard counts, so refresh its lists, detail, and organization dashboard.
export function useSubmitIncident(client: SupabaseClient) {
  const queryClient = useQueryClient()
  return useMutation<IncidentSummary, Error, { incidentId: string; input: IncidentSubmissionInput }>({
    mutationFn: ({ incidentId, input }) => submitIncident(client, incidentId, input),
    onSuccess: (incident) => {
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.all })
      queryClient.invalidateQueries({ queryKey: ['incidents', 'detail', incident.organizationId, incident.id] })
      queryClient.invalidateQueries({ queryKey: ['dashboard', incident.organizationId] })
      void invalidateSafetyIntelligence(queryClient, incident.organizationId)
    },
  })
}

// A newly submitted report refreshes incident lists and dashboard counts after the database returns its record.
export function useSubmitNewIncident(client: SupabaseClient) {
  const queryClient = useQueryClient()
  return useMutation<IncidentSummary, Error, IncidentSubmissionInput>({
    mutationFn: (input) => submitNewIncident(client, input),
    onSuccess: (incident) => {
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.all })
      queryClient.invalidateQueries({ queryKey: ['dashboard', incident.organizationId] })
      void invalidateSafetyIntelligence(queryClient, incident.organizationId)
    },
  })
}

export function useIncidentEvidence(client: SupabaseClient, incidentId: string | null) {
  const organization = useIncidentOrganization(client)
  return useQuery<IncidentEvidence[]>({
    queryKey: [...incidentQueryKeys.evidence(organization.data?.organizationId || 'pending', incidentId || 'pending'), organization.data?.userId],
    queryFn: () => getIncidentEvidence(client, incidentId as string),
    enabled: Boolean(organization.data?.organizationId && incidentId),
    staleTime: 30_000,
  })
}

// Refresh the evidence list and incident detail after an upload; the dashboard also shows recent activity.
export function useUploadIncidentEvidence(client: SupabaseClient) {
  const queryClient = useQueryClient()
  return useMutation<IncidentEvidence & { sanitization?: 'verified' | 'unverified' }, Error, { incidentId: string; file: File }>({
    mutationFn: ({ incidentId, file }) => uploadIncidentEvidence(client, incidentId, file),
    onSuccess: (evidence) => {
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.evidence(evidence.organizationId, evidence.incidentId) })
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.detail(evidence.organizationId, evidence.incidentId) })
      queryClient.invalidateQueries({ queryKey: ['dashboard', evidence.organizationId] })
    },
  })
}

export function useUploadInvestigationEvidence(client: SupabaseClient) {
  const queryClient = useQueryClient()
  return useMutation<IncidentEvidence, Error, { incidentId: string; file: File }>({
    mutationFn: ({ incidentId, file }) => uploadInvestigationEvidence(client, incidentId, file),
    onSuccess: (evidence) => {
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.evidence(evidence.organizationId, evidence.incidentId) })
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.detail(evidence.organizationId, evidence.incidentId) })
      queryClient.invalidateQueries({ queryKey: ['dashboard', evidence.organizationId] })
    },
  })
}

// A delete refreshes evidence and detail data so removed files disappear from both views.
export function useDeleteIncidentEvidence(client: SupabaseClient) {
  const queryClient = useQueryClient()
  return useMutation<void, Error, { evidenceId: string; organizationId: string; incidentId: string }>({
    mutationFn: ({ evidenceId }) => deleteIncidentEvidence(client, evidenceId),
    onSuccess: (_, variables) => {
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.evidence(variables.organizationId, variables.incidentId) })
      queryClient.invalidateQueries({ queryKey: incidentQueryKeys.detail(variables.organizationId, variables.incidentId) })
    },
  })
}

export function useDownloadIncidentEvidence(client: SupabaseClient) {
  return useMutation<{ blob: Blob; filename: string }, Error, string>({
    mutationFn: (evidenceId) => downloadIncidentEvidence(client, evidenceId),
  })
}

export function useIncidentActivity(client: SupabaseClient, incidentId: string | null) {
  const organization = useIncidentOrganization(client)
  return useQuery<IncidentActivity[]>({
    queryKey: [...incidentQueryKeys.activity(organization.data?.organizationId || 'pending', incidentId || 'pending'), organization.data?.userId],
    queryFn: () => getIncidentActivity(client, incidentId as string),
    enabled: Boolean(organization.data?.organizationId && incidentId),
    staleTime: 30_000,
  })
}
