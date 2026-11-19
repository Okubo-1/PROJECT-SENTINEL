import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

export const investigationTeamMemberSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  severity_level: z.string().min(1).max(100),
  user_id: z.string().uuid(),
  full_name: z.string(),
  account_status: z.string(),
  added_at: z.string().datetime(),
})

export type InvestigationTeamMember = z.infer<typeof investigationTeamMemberSchema>

export const investigationDeadlinesSchema = z.object({
  critical_hours: z.number().int().positive(),
  high_hours: z.number().int().positive(),
  medium_hours: z.number().int().positive(),
  low_hours: z.number().int().positive(),
  verification_enabled: z.boolean(),
})

export type InvestigationDeadlines = z.infer<typeof investigationDeadlinesSchema>

export const investigationTimelineEventSchema = z.object({
  id: z.string().uuid(),
  organization_id: z.string().uuid(),
  investigation_id: z.string().uuid(),
  event_type: z.enum(['created', 'assigned', 'started', 'finding_added', 'status_changed', 'completed']),
  actor_id: z.string().uuid(),
  details: z.record(z.string(), z.unknown()),
  created_at: z.string().datetime(),
})

export type InvestigationTimelineEvent = z.infer<typeof investigationTimelineEventSchema>

export class InvestigationServiceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'InvestigationServiceError'
  }
}

export async function getInvestigationTeamMembers(
  client: SupabaseClient,
  organizationId: string,
  severityLevel?: string,
): Promise<InvestigationTeamMember[]> {
  let query = client
    .from('investigation_team_members')
    .select('id, organization_id, severity_level, user_id, full_name:profiles(full_name), account_status:profiles(account_status), added_at')
    .eq('organization_id', organizationId)

  if (severityLevel) {
    query = query.eq('severity_level', severityLevel)
  }

  const { data, error } = await query.order('added_at', { ascending: false })

  if (error) {
    console.error('Failed to fetch investigation team members', {
      code: error.code,
      message: error.message,
    })
    throw new InvestigationServiceError('Failed to load investigation team members.')
  }

  return ((data || []) as Array<Record<string, unknown>>).map((item) => ({
    id: item.id as string,
    organization_id: item.organization_id as string,
    severity_level: item.severity_level as string,
    user_id: item.user_id as string,
    full_name: ((item.full_name as Record<string, unknown>) || {}).full_name as string || 'Unknown',
    account_status: ((item.account_status as Record<string, unknown>) || {}).account_status as string || 'active',
    added_at: item.added_at as string,
  }))
}

export async function addInvestigationTeamMember(
  client: SupabaseClient,
  organizationId: string,
  severityLevel: string,
  userId: string,
): Promise<InvestigationTeamMember> {
  const user = await client.auth.getUser()
  if (!user.data.user) {
    throw new InvestigationServiceError('Not authenticated.')
  }

  const { data, error } = await client
    .from('investigation_team_members')
    .insert({
      organization_id: organizationId,
      severity_level: severityLevel,
      user_id: userId,
      added_by: user.data.user.id,
    })
    .select('id, organization_id, severity_level, user_id, full_name:profiles(full_name), account_status:profiles(account_status), added_at')
    .single()

  if (error) {
    console.error('Failed to add investigation team member', {
      code: error.code,
      message: error.message,
    })
    throw new InvestigationServiceError(error.message || 'Failed to add team member.')
  }

  return {
    id: (data as Record<string, unknown>).id as string,
    organization_id: (data as Record<string, unknown>).organization_id as string,
    severity_level: (data as Record<string, unknown>).severity_level as string,
    user_id: (data as Record<string, unknown>).user_id as string,
    full_name: (((data as Record<string, unknown>).full_name as Record<string, unknown>) || {}).full_name as string || 'Unknown',
    account_status: (((data as Record<string, unknown>).account_status as Record<string, unknown>) || {}).account_status as string || 'active',
    added_at: (data as Record<string, unknown>).added_at as string,
  }
}

export async function removeInvestigationTeamMember(
  client: SupabaseClient,
  organizationId: string,
  memberId: string,
): Promise<void> {
  const { error } = await client
    .from('investigation_team_members')
    .delete()
    .eq('id', memberId)
    .eq('organization_id', organizationId)

  if (error) {
    console.error('Failed to remove investigation team member', {
      code: error.code,
      message: error.message,
    })
    throw new InvestigationServiceError('Failed to remove team member.')
  }
}

export async function getInvestigationDeadlines(
  client: SupabaseClient,
  organizationId: string,
): Promise<InvestigationDeadlines | null> {
  const { data, error } = await client
    .from('investigation_deadlines')
    .select('critical_hours, high_hours, medium_hours, low_hours, verification_enabled')
    .eq('organization_id', organizationId)
    .single()

  if (error && error.code !== 'PGRST116') {
    console.error('Failed to fetch investigation deadlines', {
      code: error.code,
      message: error.message,
    })
    throw new InvestigationServiceError('Failed to load investigation deadlines.')
  }

  return data as InvestigationDeadlines | null
}

export async function updateInvestigationDeadlines(
  client: SupabaseClient,
  organizationId: string,
  deadlines: InvestigationDeadlines,
): Promise<InvestigationDeadlines> {
  const { data, error } = await client
    .from('investigation_deadlines')
    .upsert({
      organization_id: organizationId,
      ...deadlines,
      updated_at: new Date().toISOString(),
    }, {
      onConflict: 'organization_id',
    })
    .eq('organization_id', organizationId)
    .select('critical_hours, high_hours, medium_hours, low_hours, verification_enabled')
    .single()

  if (error) {
    console.error('Failed to update investigation deadlines', {
      code: error.code,
      message: error.message,
    })
    throw new InvestigationServiceError('Failed to update investigation deadlines.')
  }

  return data as InvestigationDeadlines
}

export async function addInvestigationTimelineEvent(
  client: SupabaseClient,
  organizationId: string,
  investigationId: string,
  eventType: 'created' | 'assigned' | 'started' | 'finding_added' | 'status_changed' | 'completed',
  details: Record<string, unknown> = {},
): Promise<InvestigationTimelineEvent> {
  const user = await client.auth.getUser()
  if (!user.data.user) {
    throw new InvestigationServiceError('Not authenticated.')
  }

  const { data, error } = await client
    .from('investigation_timeline_events')
    .insert({
      organization_id: organizationId,
      investigation_id: investigationId,
      event_type: eventType,
      actor_id: user.data.user.id,
      details,
    })
    .select()
    .single()

  if (error) {
    console.error('Failed to add investigation timeline event', {
      code: error.code,
      message: error.message,
    })
    throw new InvestigationServiceError('Failed to record timeline event.')
  }

  return data as InvestigationTimelineEvent
}

export async function getInvestigationTimeline(
  client: SupabaseClient,
  organizationId: string,
  investigationId: string,
): Promise<InvestigationTimelineEvent[]> {
  const { data, error } = await client
    .from('investigation_timeline_events')
    .select()
    .eq('organization_id', organizationId)
    .eq('investigation_id', investigationId)
    .order('created_at', { ascending: true })

  if (error) {
    console.error('Failed to fetch investigation timeline', {
      code: error.code,
      message: error.message,
    })
    throw new InvestigationServiceError('Failed to load investigation timeline.')
  }

  return (data || []) as InvestigationTimelineEvent[]
}

export function calculateInvestigationDueDate(
  createdAt: string,
  severityLevel: string,
  deadlines?: InvestigationDeadlines,
): Date {
  const created = new Date(createdAt)
  let hours = 72

  if (deadlines) {
    hours = severityLevel === 'Critical' ? deadlines.critical_hours
      : severityLevel === 'High' ? deadlines.high_hours
      : severityLevel === 'Medium' ? deadlines.medium_hours
      : severityLevel === 'Low' ? deadlines.low_hours
      : 72
  } else {
    hours = severityLevel === 'Critical' ? 24
      : severityLevel === 'High' ? 72
      : severityLevel === 'Medium' ? 168
      : severityLevel === 'Low' ? 336
      : 72
  }

  return new Date(created.getTime() + hours * 60 * 60 * 1000)
}

export function formatInvestigationDuration(hours: number): string {
  if (hours < 24) return `${hours} hour${hours !== 1 ? 's' : ''}`
  if (hours % 24 === 0) {
    const days = hours / 24
    return `${days} day${days !== 1 ? 's' : ''}`
  }
  const days = Math.floor(hours / 24)
  const remainingHours = hours % 24
  return `${days} day${days !== 1 ? 's' : ''} ${remainingHours}h`
}
