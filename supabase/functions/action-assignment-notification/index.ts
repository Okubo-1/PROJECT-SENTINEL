import { createClient } from 'npm:@supabase/supabase-js@2'
import { sendActionAssignmentEmail } from '../_shared/inviteEmail.ts'
import { logNotificationFailure } from './logging.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

type AssignmentRequest = { actionId: string }
type ActionRecord = {
  id: string
  organization_id: string
  assignee_id: string
  type: 'preventive' | 'corrective' | 'investigation'
  description: string
  site_id: string
  due_at: string
  assigned_at: string
  incident_id: string | null
}

function jsonResponse(body: Record<string, unknown>, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

Deno.serve(async (request: Request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (request.method !== 'POST') return jsonResponse({ error: 'Method not allowed' }, 405)

  let stage = 'initialization'
  let actorId: string | null = null
  let eventId: string | null = null
  let eventClaimed = false

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL')
    const anonKey = Deno.env.get('SUPABASE_ANON_KEY')
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
    if (!supabaseUrl || !anonKey || !serviceRoleKey) throw new Error('The notification service is not configured')

    stage = 'authentication'
    const authorization = request.headers.get('Authorization')
    if (!authorization) return jsonResponse({ error: 'Authentication is required' }, 401)
    const userClient = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } } })
    const { data: { user }, error: userError } = await userClient.auth.getUser()
    if (userError || !user) return jsonResponse({ error: 'Invalid authentication token' }, 401)
    actorId = user.id

    stage = 'request_validation'
    const body = await request.json() as AssignmentRequest
    if (!body.actionId || !/^[\da-f-]{36}$/i.test(body.actionId)) return jsonResponse({ error: 'A valid action ID is required' }, 400)

    const adminClient = createClient(supabaseUrl, serviceRoleKey)
    stage = 'action_lookup'
    const { data: action, error: actionError } = await adminClient.from('actions')
      .select('id, organization_id, assignee_id, type, description, site_id, due_at, assigned_at, incident_id')
      .eq('id', body.actionId)
      .maybeSingle()
    if (actionError) throw new Error(actionError.message)
    if (!action) return jsonResponse({ error: 'Action not found' }, 404)
    const record = action as ActionRecord
    const notificationKey = `action_assigned:${record.id}:${record.assignee_id}:${record.assigned_at}`

    stage = 'assignment_event_validation'
    const { data: event, error: eventError } = await adminClient.from('activity_logs')
      .select('id')
      .eq('organization_id', record.organization_id)
      .eq('user_id', user.id)
      .in('activity', ['Action assigned', 'Action reassigned'])
      .contains('metadata', { notification_key: notificationKey, recipient_id: record.assignee_id })
      .maybeSingle()
    if (eventError) throw new Error(eventError.message)
    if (!event) return jsonResponse({ error: 'You are not authorized to notify this assignment' }, 403)
    eventId = event.id

    stage = 'delivery_claim'
    const { data: claimed, error: claimError } = await adminClient.rpc('claim_action_assignment_email', {
      target_event_id: eventId,
      target_actor_id: user.id,
    })
    if (claimError) throw new Error(claimError.message)
    if (!claimed) return jsonResponse({ success: true, emailSent: false, reason: 'already_attempted' })
    eventClaimed = true

    stage = 'recipient_lookup'
    const [{ data: profile, error: profileError }, { data: authUser, error: authUserError }, { data: organization, error: organizationError }, { data: site, error: siteError }] = await Promise.all([
      adminClient.from('profiles').select('full_name, organization_id, account_status').eq('id', record.assignee_id).maybeSingle(),
      adminClient.auth.admin.getUserById(record.assignee_id),
      adminClient.from('organizations').select('company_name').eq('id', record.organization_id).maybeSingle(),
      adminClient.from('sites').select('name').eq('id', record.site_id).eq('organization_id', record.organization_id).maybeSingle(),
    ])
    if (profileError || authUserError || organizationError || siteError) throw new Error('Unable to load action assignment notification details')
    if (!profile || profile.organization_id !== record.organization_id || profile.account_status !== 'active' || !authUser.user?.email) {
      throw new Error('The assigned user is not an active organization member with a valid email address')
    }

    let incidentReference: string | null = null
    if (record.incident_id) {
      const { data: incident, error: incidentError } = await adminClient.from('incidents')
        .select('reference_number')
        .eq('id', record.incident_id)
        .eq('organization_id', record.organization_id)
        .maybeSingle()
      if (incidentError) throw new Error('Unable to load the linked incident reference')
      incidentReference = incident?.reference_number || null
    }

    stage = 'email_delivery'
    await sendActionAssignmentEmail({
      assigneeEmail: authUser.user.email,
      assigneeName: profile.full_name || authUser.user.email,
      organizationName: organization?.company_name || 'your organization',
      actionType: record.type,
      description: record.description,
      siteName: site?.name || 'Assigned site',
      dueAt: new Date(record.due_at).toLocaleString('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC',
      incidentReference,
    })

    stage = 'delivery_complete'
    const { error: completeError } = await adminClient.rpc('complete_action_assignment_email', {
      target_event_id: eventId,
      target_actor_id: user.id,
      delivery_succeeded: true,
      failure_code: null,
    })
    if (completeError) throw new Error(completeError.message)
    eventClaimed = false
    return jsonResponse({ success: true, emailSent: true })
  } catch {
    logNotificationFailure('action_assignment_notification_failed', stage)
    if (eventClaimed && eventId && actorId) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')
        const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
        if (supabaseUrl && serviceRoleKey) {
          const adminClient = createClient(supabaseUrl, serviceRoleKey)
          const { error: statusError } = await adminClient.rpc('complete_action_assignment_email', {
            target_event_id: eventId,
            target_actor_id: actorId,
            delivery_succeeded: false,
            failure_code: stage,
          })
          if (statusError) {
            logNotificationFailure('action_assignment_notification_failure_status_update_failed', stage)
          }
        }
      } catch {
        logNotificationFailure('action_assignment_notification_failure_record_failed', stage)
      }
    }
    return jsonResponse({ success: false, emailSent: false, error: 'Action assignment email delivery failed' })
  }
})
