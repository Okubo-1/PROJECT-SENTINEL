import type { SupabaseClient } from '@supabase/supabase-js'

export type AiAccessContext = {
  userId: string
  organizationId: string
  role: string
}

export class AiAccessError extends Error {
  readonly status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'AiAccessError'
    this.status = status
  }
}

// Both AI generation and read-only intelligence resolve identity through caller RLS.
export async function authenticateOrganization(client: SupabaseClient): Promise<AiAccessContext> {
  const { data: { user }, error } = await client.auth.getUser()
  if (error || !user) throw new AiAccessError('Invalid authentication token', 401)
  const profileResult = await client.from('profiles')
    .select('id, organization_id, account_status').eq('id', user.id).maybeSingle()
  if (profileResult.error) throw new AiAccessError('Unable to verify organization access', 503)
  const profile = profileResult.data
  if (!profile?.organization_id || profile.account_status !== 'active') {
    throw new AiAccessError('An active organization account is required', 403)
  }
  const membershipResult = await client.from('memberships')
    .select('user_id, organization_id, role')
    .eq('user_id', user.id).eq('organization_id', profile.organization_id).maybeSingle()
  if (membershipResult.error) throw new AiAccessError('Unable to verify organization access', 503)
  const context = resolveAiAccessContext(user.id, profile, membershipResult.data)
  if (!context) throw new AiAccessError('Organization access is required', 403)
  return context
}

export async function requireAiPermission(client: SupabaseClient, context: AiAccessContext) {
  const { data, error } = await client.rpc('can_use_ai_sessions', {
    target_organization_id: context.organizationId,
  })
  if (error || typeof data !== 'boolean') throw new AiAccessError('Unable to verify AI permission', 503)
  if (!data) {
    throw new AiAccessError('You are not authorized to use the AI service', 403)
  }
}

const executiveAnalyticsDeniedMessage =
  'You do not have permission to view Executive Analytics. Please ask your Super Admin to grant you access.'

// Executive Analytics is a separate grant; only Super Administrators receive it implicitly.
export function hasExecutiveAnalyticsPermission(role: string, customPermissions: unknown = []) {
  if (role === 'Super Administrator') return true
  return Array.isArray(customPermissions) && customPermissions.includes('view_executive_analytics')
}

export async function requireExecutiveAnalyticsPermission(client: SupabaseClient, context: AiAccessContext) {
  if (hasExecutiveAnalyticsPermission(context.role)) return
  const { data, error } = await client.from('custom_roles').select('permissions')
    .eq('organization_id', context.organizationId).eq('name', context.role)
    .eq('is_active', true).maybeSingle()
  if (error) throw new AiAccessError('Unable to verify Executive Analytics permission', 503)
  if (!hasExecutiveAnalyticsPermission(context.role, data?.permissions)) {
    throw new AiAccessError(executiveAnalyticsDeniedMessage, 403)
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

// Inputs must come from caller-scoped Supabase reads, never from the request body.
export function resolveAiAccessContext(
  authenticatedUserId: string,
  profile: unknown,
  membership: unknown,
): AiAccessContext | null {
  if (!isRecord(profile)
    || profile.id !== authenticatedUserId
    || typeof profile.organization_id !== 'string'
    || profile.account_status !== 'active') return null

  if (!isRecord(membership)
    || membership.user_id !== authenticatedUserId
    || membership.organization_id !== profile.organization_id
    || typeof membership.role !== 'string'
    || !membership.role.trim()) return null

  return {
    userId: authenticatedUserId,
    organizationId: profile.organization_id,
    role: membership.role,
  }
}

export function parseAiPrompt(body: unknown): string | null {
  // Extra fields are rejected so clients cannot supply tenant, identity or instruction overrides.
  if (!isRecord(body)
    || Object.keys(body).length !== 1
    || typeof body.prompt !== 'string') return null

  const prompt = body.prompt.trim()
  return prompt && prompt.length <= 4_000 ? prompt : null
}
