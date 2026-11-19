import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'

export const incidentClosureInputSchema = z.object({
  rootCause: z.string().trim().min(3, 'Enter a root cause of at least 3 characters.').max(5000),
  correctiveAction: z.string().trim().min(3, 'Enter a corrective action of at least 3 characters.').max(5000),
  actionCompleted: z.literal(true, { error: 'Confirm that the corrective action has been completed.' }),
})
export type IncidentClosureInput = z.infer<typeof incidentClosureInputSchema>

const candidateSchema = z.object({
  user_id: z.uuid(),
  full_name: z.string(),
  role: z.string(),
  account_status: z.string(),
  delegated: z.boolean(),
})
export function searchIncidentClosureCandidates(candidates: z.infer<typeof candidateSchema>[], search: string) {
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean)
  // Search only the roster already authorized by the RPC; an empty search must not display everyone.
  return words.length ? candidates.filter((candidate) =>
    words.every((word) => candidate.full_name.toLowerCase().includes(word))) : []
}

export const incidentClosureSchema = z.object({
  root_cause: z.string(),
  corrective_action: z.string(),
  action_completed: z.literal(true),
  closed_by: z.uuid(),
  closed_at: z.iso.datetime({ offset: true }),
})

export class IncidentClosureAccessError extends Error {
  constructor() {
    super('Incident closure permission could not be verified. Please retry.')
    this.name = 'IncidentClosureAccessError'
  }
}

export async function getIncidentClosureAccess(client: SupabaseClient, organizationId: string) {
  const { data, error } = await client.rpc('can_close_incidents', { target_organization_id: organizationId })
  if (error) {
    console.error('Incident closure permission RPC failed.', {
      code: error.code,
      message: error.message,
    })
    throw new IncidentClosureAccessError()
  }
  const result = z.boolean().safeParse(data)
  if (!result.success) {
    console.error('Incident closure permission RPC returned an invalid result.')
    throw new IncidentClosureAccessError()
  }
  return result.data
}

export async function getIncidentClosureCandidates(client: SupabaseClient) {
  const { data, error } = await client.rpc('list_incident_closure_candidates')
  if (error) throw new Error('Unable to load incident closure delegates.')
  return z.array(candidateSchema).parse(data)
}

export async function setIncidentClosureDelegate(client: SupabaseClient, userId: string, enabled: boolean) {
  // The selected user is only a target; the RPC resolves the administrator and tenant itself.
  const { error } = await client.rpc('set_incident_closure_delegate', { p_user_id: userId, p_enabled: enabled })
  if (error) throw new Error(error.message)
}

export async function closeIncident(client: SupabaseClient, incidentId: string, input: IncidentClosureInput) {
  const validated = incidentClosureInputSchema.parse(input)
  const { error } = await client.rpc('close_incident', {
    target_incident_id: incidentId,
    p_root_cause: validated.rootCause,
    p_corrective_action: validated.correctiveAction,
    p_action_completed: validated.actionCompleted,
  })
  if (error) throw new Error(error.message)
}

export async function getIncidentClosure(client: SupabaseClient, incidentId: string) {
  const { data, error } = await client.from('incident_closures')
    .select('root_cause, corrective_action, action_completed, closed_by, closed_at')
    .eq('incident_id', incidentId).maybeSingle()
  if (error) throw new Error('Unable to load incident closure details.')
  return data === null ? null : incidentClosureSchema.parse(data)
}
