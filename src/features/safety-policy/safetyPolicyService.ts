import type { SupabaseClient } from '@supabase/supabase-js'

export type SafetyPolicyFrequency = 'every_login' | 'first_login' | 'interval_days' | 'weekly'

export interface SafetyPolicy {
  id: string
  versionId: string
  versionNumber: number
  title: string
  text: string
  effectiveAt: string
  frequency: SafetyPolicyFrequency
  intervalDays: number | null
  timezone: string
}

export interface SafetyPolicyStatus {
  active: boolean
  required: boolean
  policy: SafetyPolicy | null
}

export interface SafetyPolicySettings {
  configured: boolean
  active: boolean
  deleted: boolean
  hasDraft: boolean
  isStarterDraft: boolean
  policyId: string | null
  versionId: string | null
  versionNumber: number | null
  publishedVersionNumber: number | null
  title: string
  text: string
  frequency: SafetyPolicyFrequency
  intervalDays: number | null
  timezone: string
  updatedAt: string | null
}

export interface SafetyPolicyDraft {
  title: string
  text: string
  frequency: SafetyPolicyFrequency
  intervalDays: number | null
  timezone: string
}

const frequencies = new Set<SafetyPolicyFrequency>(['every_login', 'first_login', 'interval_days', 'weekly'])
const SAFETY_POLICY_REQUEST_TIMEOUT_MS = 12_000

interface SafetyPolicyRpcError {
  code?: string
  message?: string
  details?: string
  hint?: string
  status?: number
}

function logSafetyPolicyFailure(operation: string, error: SafetyPolicyRpcError | Error) {
  if (!import.meta.env.DEV) return
  if (error instanceof Error) {
    console.error(`[SafetyPolicy] ${operation} failed`, {
      name: error.name,
      message: error.message,
    })
    return
  }
  console.error(`[SafetyPolicy] ${operation} failed`, {
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
    status: error.status,
  })
}

function verificationErrorMessage(error: SafetyPolicyRpcError): string {
  switch (error.code) {
    case 'PGRST202':
    case '42883':
      return 'Safety Policy verification is unavailable because its database function is missing. Contact your administrator.'
    case '42P01':
    case '42703':
      return 'Safety Policy verification is unavailable because its database configuration is incomplete. Contact your administrator.'
    case '42501':
      return 'Your account is not permitted to verify this organisation’s Safety Policy. Contact your administrator.'
    case '28000':
    case 'PGRST301':
      return 'Your sign-in session could not be verified. Sign out and sign in again.'
    default:
      return 'We could not verify your company safety policy. Please retry or contact your administrator.'
  }
}

function acknowledgementErrorMessage(error: SafetyPolicyRpcError): string {
  switch (error.code) {
    case 'PGRST202':
    case '42883':
      return 'Saving your acknowledgement is unavailable because its database function is missing. Contact your administrator.'
    case '42P01':
    case '42703':
      return 'Your acknowledgement could not be saved because the Safety Policy database configuration is incomplete.'
    case '42501':
      return 'Your account is not permitted to acknowledge this organisation’s Safety Policy.'
    case '28000':
    case 'PGRST301':
      return 'Your sign-in session could not be verified. Sign out and sign in again.'
    default:
      return 'We could not save your acknowledgement. Please retry.'
  }
}

async function withSafetyPolicyTimeout<T>(request: PromiseLike<T>): Promise<T> {
  let timeoutId = 0
  try {
    return await Promise.race([
      Promise.resolve(request),
      new Promise<never>((_, reject) => {
        timeoutId = window.setTimeout(
          () => reject(new Error('Policy verification is taking longer than expected. Please retry.')),
          SAFETY_POLICY_REQUEST_TIMEOUT_MS,
        )
      }),
    ])
  } finally {
    window.clearTimeout(timeoutId)
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('The safety policy service returned an invalid response.')
  }
  return value as Record<string, unknown>
}

function stringValue(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function frequencyValue(value: unknown): SafetyPolicyFrequency {
  if (typeof value === 'string' && frequencies.has(value as SafetyPolicyFrequency)) {
    return value as SafetyPolicyFrequency
  }
  throw new Error('The safety policy service returned an unsupported acknowledgement frequency.')
}

function parseSettings(value: unknown): SafetyPolicySettings {
  const result = objectValue(value)
  const configured = result.configured === true
  return {
    configured,
    active: result.active === true,
    deleted: result.deleted === true,
    hasDraft: result.hasDraft === true,
    isStarterDraft: result.isStarterDraft === true,
    policyId: stringValue(result.policyId) || null,
    versionId: stringValue(result.versionId) || null,
    versionNumber: typeof result.versionNumber === 'number' ? result.versionNumber : null,
    publishedVersionNumber: typeof result.publishedVersionNumber === 'number' ? result.publishedVersionNumber : null,
    title: stringValue(result.title),
    text: stringValue(result.text),
    frequency: result.frequency === undefined ? 'every_login' : frequencyValue(result.frequency),
    intervalDays: typeof result.intervalDays === 'number' ? result.intervalDays : null,
    timezone: stringValue(result.timezone, 'UTC'),
    updatedAt: stringValue(result.updatedAt) || null,
  }
}

export async function getSafetyPolicyStatus(client: SupabaseClient): Promise<SafetyPolicyStatus> {
  let response
  try {
    response = await withSafetyPolicyTimeout(client.rpc('get_safety_policy_status'))
  } catch (caught) {
    logSafetyPolicyFailure('Status request', caught instanceof Error ? caught : new Error('Unknown request failure'))
    if (caught instanceof Error && caught.message.includes('longer than expected')) throw caught
    throw new Error('We could not verify your company safety policy. Check your connection and retry.')
  }
  const { data, error } = response
  if (error) {
    logSafetyPolicyFailure('Status RPC', error)
    throw new Error(verificationErrorMessage(error))
  }

  try {
    const result = objectValue(data)
    if (typeof result.active !== 'boolean') throw new Error('Invalid policy status.')
    if (typeof result.required !== 'boolean') throw new Error('Invalid acknowledgement status.')
    if (!result.active) {
      if (result.required || result.policy !== null) throw new Error('Invalid inactive policy status.')
      return { active: false, required: false, policy: null }
    }

    const policyData = objectValue(result.policy)
    const versionNumber = policyData.versionNumber
    const id = stringValue(policyData.id)
    const versionId = stringValue(policyData.versionId)
    const title = stringValue(policyData.title)
    const text = stringValue(policyData.text)
    if (typeof versionNumber !== 'number' || versionNumber < 1 || !id || !versionId || !title || !text) {
      throw new Error('Invalid active policy.')
    }

    return {
      active: true,
      required: result.required,
      policy: {
        id,
        versionId,
        versionNumber,
        title,
        text,
        effectiveAt: stringValue(policyData.effectiveAt),
        frequency: frequencyValue(policyData.frequency),
        intervalDays: typeof policyData.intervalDays === 'number' ? policyData.intervalDays : null,
        timezone: stringValue(policyData.timezone, 'UTC'),
      },
    }
  } catch (caught) {
    logSafetyPolicyFailure(
      'Status response validation',
      caught instanceof Error ? caught : new Error('Invalid response'),
    )
    throw new Error('The Safety Policy service returned an invalid response. Contact your administrator.')
  }
}

export async function acknowledgeSafetyPolicy(client: SupabaseClient): Promise<void> {
  let response
  try {
    response = await withSafetyPolicyTimeout(client.rpc('acknowledge_safety_policy'))
  } catch (caught) {
    logSafetyPolicyFailure('Acknowledgement request', caught instanceof Error ? caught : new Error('Unknown request failure'))
    if (caught instanceof Error && caught.message.includes('longer than expected')) throw caught
    throw new Error('We could not save your acknowledgement. Please retry.')
  }
  if (response.error) {
    logSafetyPolicyFailure('Acknowledgement RPC', response.error)
    throw new Error(acknowledgementErrorMessage(response.error))
  }
  try {
    const result = objectValue(response.data)
    if (result.acknowledged !== true) throw new Error('Acknowledgement was not confirmed by the database.')
  } catch (caught) {
    logSafetyPolicyFailure(
      'Acknowledgement response validation',
      caught instanceof Error ? caught : new Error('Invalid response'),
    )
    throw new Error('The database did not confirm your Safety Policy acknowledgement. Please retry.')
  }
}

export async function getSafetyPolicySettings(client: SupabaseClient): Promise<SafetyPolicySettings> {
  const { data, error } = await client.rpc('get_safety_policy_settings')
  if (error) throw new Error(error.message || 'Unable to load Safety Policy settings.')
  return parseSettings(data)
}

export async function saveSafetyPolicyDraft(client: SupabaseClient, draft: SafetyPolicyDraft): Promise<SafetyPolicySettings> {
  const { data, error } = await client.rpc('save_safety_policy_draft', {
    policy_title: draft.title,
    policy_text: draft.text,
    acknowledgement_frequency: draft.frequency,
    acknowledgement_interval_days: draft.frequency === 'interval_days' ? draft.intervalDays : null,
    acknowledgement_timezone: draft.timezone,
    starter_template: false,
  })
  if (error) throw new Error(error.message || 'Unable to save the safety policy.')
  return parseSettings(data)
}

export async function createSafetyPolicyStarterDraft(client: SupabaseClient): Promise<SafetyPolicySettings> {
  const { data, error } = await client.rpc('create_safety_policy_starter_draft')
  if (error) throw new Error(error.message || 'Unable to load the safety policy starter template.')
  return parseSettings(data)
}

export async function setSafetyPolicyActive(client: SupabaseClient, active: boolean): Promise<void> {
  const { error } = await client.rpc('set_safety_policy_active', { activate_policy: active })
  if (error) throw new Error(error.message || 'Unable to update policy activation.')
}

export async function deleteSafetyPolicy(client: SupabaseClient): Promise<void> {
  const { error } = await client.rpc('delete_safety_policy')
  if (error) throw new Error(error.message || 'Unable to delete the safety policy.')
}
