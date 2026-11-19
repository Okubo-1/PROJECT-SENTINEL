import { useState } from 'react'
import type { SupabaseClient } from '@supabase/supabase-js'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'

import { Alert, Avatar, Badge, Button, Dialog, SearchField, Skeleton } from '../../components/ui'
import type { SeverityOption } from './companySettingsTypes'
import { SettingsSectionShell } from './SettingsSectionShell'

type Candidate = {
  user_id: string
  full_name: string
  account_status: string
  already_assigned: boolean
}

export function InvestigationTeamsSection({ client, organizationId, severities }: {
  client: SupabaseClient
  organizationId: string
  severities: SeverityOption[]
}) {
  const queryClient = useQueryClient()
  const [selectedLevel, setSelectedLevel] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [isModalOpen, setIsModalOpen] = useState(false)

  const teamMembers = useQuery({
    queryKey: ['investigation-team-members', organizationId],
    queryFn: async () => {
      const { data, error } = await client
        .from('investigation_team_members')
        .select('id, user_id, severity_level, full_name:profiles(full_name), account_status:profiles(account_status), added_at')
        .eq('organization_id', organizationId)

      if (error) throw new Error(error.message)
      return ((data || []) as Array<Record<string, unknown>>).map((item) => ({
        id: item.id as string,
        user_id: item.user_id as string,
        severity_level: item.severity_level as string,
        full_name: ((item.full_name as Record<string, unknown>) || {}).full_name as string || 'Unknown',
        account_status: ((item.account_status as Record<string, unknown>) || {}).account_status as string || 'active',
        added_at: item.added_at as string,
      }))
    },
  })

  const candidates = useQuery({
    queryKey: ['investigation-team-candidates', organizationId, selectedLevel],
    queryFn: async () => {
      if (!selectedLevel) return []
      const { data: allMembers } = await client
        .from('investigation_team_members')
        .select('user_id')
        .eq('organization_id', organizationId)
        .eq('severity_level', selectedLevel)

      const assignedIds = new Set((allMembers || []).map((m) => (m as Record<string, unknown>).user_id))

      const { data, error } = await client
        .from('profiles')
        .select('id, full_name, account_status')
        .eq('organization_id', organizationId)
        .order('full_name')

      if (error) throw new Error(error.message)
      return ((data || []) as Array<Record<string, unknown>>).map((profile) => ({
        user_id: profile.id as string,
        full_name: profile.full_name as string,
        account_status: profile.account_status as string,
        already_assigned: assignedIds.has(profile.id as string),
      }))
    },
    enabled: !!selectedLevel,
  })

  const addMutation = useMutation({
    mutationFn: async ({ userId }: { userId: string }) => {
      const { error } = await client
        .from('investigation_team_members')
        .insert({
          organization_id: organizationId,
          severity_level: selectedLevel,
          user_id: userId,
          added_by: (await client.auth.getUser()).data.user?.id,
        })
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investigation-team-members'] })
      queryClient.invalidateQueries({ queryKey: ['investigation-team-candidates'] })
    },
  })

  const removeMutation = useMutation({
    mutationFn: async ({ id }: { id: string }) => {
      const { error } = await client
        .from('investigation_team_members')
        .delete()
        .eq('id', id)
        .eq('organization_id', organizationId)
      if (error) throw new Error(error.message)
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['investigation-team-members'] })
      queryClient.invalidateQueries({ queryKey: ['investigation-team-candidates'] })
    },
  })

  const activeSeverities = severities.filter((s) => !s.deleted)
  const matchedCandidates = searchCandidates(candidates.data || [], search)
  const levelMembers = (teamMembers.data || []).filter((m) => m.severity_level === selectedLevel).sort((a, b) => a.full_name.localeCompare(b.full_name))

  const isLoading = teamMembers.isPending || (selectedLevel && candidates.isPending)
  const isError = teamMembers.isError || candidates.isError
  const error = (teamMembers.error || candidates.error) as Error | null

  return (
    <>
      <SettingsSectionShell
        title="Investigation team members"
        description="Assign team members by severity level to automatically populate investigation teams."
        action={<Badge tone="info">Auto-assigned by severity</Badge>}
      >
        {isLoading ? (
          <Skeleton className="h-32" />
        ) : isError ? (
          <Alert tone="danger">
            {error?.message || 'Failed to load team members'}
            <Button variant="outline" size="sm" className="mt-2" onClick={() => void teamMembers.refetch()}>Retry</Button>
          </Alert>
        ) : (
          <div className="grid gap-4">
            {activeSeverities.length ? (
              <div className="grid gap-3">
                {activeSeverities.map((severity) => {
                  const members = (teamMembers.data || []).filter((m) => m.severity_level === severity.name)
                  return (
                    <div
                      key={severity.id}
                      className="rounded-lg border border-line p-4 hover:border-line/80 cursor-pointer transition-colors"
                      onClick={() => {
                        setSelectedLevel(severity.name)
                        setSearch('')
                        setIsModalOpen(true)
                      }}
                    >
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div className="grid gap-1">
                          <h3 className="font-medium text-foreground">{severity.name}</h3>
                          <p className="text-sm text-muted">{members.length} team member{members.length !== 1 ? 's' : ''}</p>
                        </div>
                        <Badge tone="neutral">{members.length}</Badge>
                      </div>
                    </div>
                  )
                })}
              </div>
            ) : (
              <p className="text-sm text-muted">No severity levels configured. Add severity levels in the Severity section first.</p>
            )}
          </div>
        )}

        {(addMutation.isError || removeMutation.isError) && (
          <Alert tone="danger">{(addMutation.error || removeMutation.error)?.message}</Alert>
        )}
        {(addMutation.isSuccess || removeMutation.isSuccess) && (
          <Alert tone="success">Team member updated successfully.</Alert>
        )}
      </SettingsSectionShell>

      <Dialog open={isModalOpen} onClose={() => setIsModalOpen(false)} title={`${selectedLevel} - Team Members`} description={`Manage team members for ${selectedLevel} severity investigations`} className="max-w-2xl">
        <div className="grid gap-4">
          <div className="grid gap-3">
            <h3 className="text-sm font-semibold text-foreground">Add team members</h3>
            <SearchField
              value={search}
              onChange={setSearch}
              placeholder="Search organization users by name"
              label="Search users"
            />
            {!search.trim() ? (
              <p className="text-sm text-muted">Type a name to find users in your organization.</p>
            ) : !matchedCandidates.length ? (
              <p className="text-sm text-muted">No matching users found.</p>
            ) : (
              <div className="grid gap-2 max-h-64 overflow-y-auto">
                {matchedCandidates.map((candidate) => (
                  <div key={candidate.user_id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <Avatar name={candidate.full_name} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate text-foreground">{candidate.full_name}</p>
                        <p className="text-xs text-muted">{candidate.account_status}</p>
                      </div>
                    </div>
                    <Button
                      variant={candidate.already_assigned ? 'outline' : 'default'}
                      size="sm"
                      disabled={addMutation.isPending || candidate.already_assigned || candidate.account_status !== 'active'}
                      onClick={() => addMutation.mutate({ userId: candidate.user_id })}
                    >
                      {candidate.already_assigned ? 'Added' : 'Add'}
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="grid gap-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-foreground">Current members</h3>
              <Badge tone="neutral">{levelMembers.length}</Badge>
            </div>
            {levelMembers.length ? (
              <ol className="grid gap-2 max-h-64 overflow-y-auto">
                {levelMembers.map((member, index) => (
                  <li key={member.id} className="flex items-center justify-between gap-3 rounded-lg border border-line px-4 py-2">
                    <div className="flex items-center gap-3 min-w-0">
                      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-surface-soft font-mono text-xs text-muted">
                        {index + 1}
                      </span>
                      <Avatar name={member.full_name} size="sm" />
                      <div className="min-w-0">
                        <p className="text-sm font-medium truncate text-foreground">{member.full_name}</p>
                        <p className="text-xs text-muted">{member.account_status}</p>
                      </div>
                    </div>
                    <Button
                      variant="danger"
                      size="sm"
                      disabled={removeMutation.isPending}
                      onClick={() => removeMutation.mutate({ id: member.id })}
                    >
                      Remove
                    </Button>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="rounded-lg border border-dashed border-line px-4 py-4 text-sm text-muted">No team members assigned to this severity level.</p>
            )}
          </div>

          <Button variant="outline" onClick={() => setIsModalOpen(false)} className="w-full">Close</Button>
        </div>
      </Dialog>
    </>
  )
}

function searchCandidates(candidates: Candidate[], search: string): Candidate[] {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  return words.length ? candidates.filter((candidate) =>
    words.every((word) => candidate.full_name.toLowerCase().includes(word))) : []
}
