import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { writeFileSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const { EVIDENCE_TEST_URL: url, EVIDENCE_TEST_ANON_KEY: key, EVIDENCE_TEST_SERVICE_KEY: serviceKey, EVIDENCE_TEST_DIR: directory } = process.env
if (!url || !key || !serviceKey || !directory) throw new Error('Explicit test configuration is required')
const org = '6be4f137-4f64-4b69-b84c-7237ac0cbfa0'
const adminApi = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } })
const users = []
const paths = []
const identifiedPaths = []
const failures = []
let organizationCreated = false
let incidentId
let evidenceId
let stage = 'setup'
const site = randomUUID()
const secretName = `SYNTHETIC_REPORTER_${randomUUID().replaceAll('-', '')}`
const assert = (condition, message) => { if (!condition) throw new Error(message) }
const check = (result, message) => { if (result.error) throw new Error(`${message}: ${result.error.message}`); return result.data }
const safe = (data) => {
  const text = JSON.stringify(data).toLowerCase()
  for (const value of [users[0]?.id, users[0]?.email, secretName]) {
    if (value && text.includes(value.toLowerCase())) throw new Error('Reporter identity appeared in a response')
  }
}
function sql(query) {
  const path = join(directory, `anonymous-live-${randomUUID()}.sql`)
  writeFileSync(path, query)
  try {
    const result = spawnSync(process.env.ComSpec || 'cmd.exe', ['/d', '/c', 'npx', 'supabase', 'db', 'query', '--linked', '--file', path], { encoding: 'utf8' })
    if (result.status !== 0) throw new Error(`Database operation failed: ${(result.stderr + result.stdout).slice(0, 2000)}`)
    return JSON.parse(result.stdout.slice(result.stdout.indexOf('{'))).rows
  } finally { unlinkSync(path) }
}
async function createUser(label) {
  const email = `anon-privacy-${label}-${randomUUID()}@example.invalid`
  const password = `${randomUUID()}aA1!`
  const result = check(await adminApi.auth.admin.createUser({ email, password, email_confirm: true }), 'Creating synthetic account')
  users.push({ id: result.user.id, email, password })
  const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  check(await client.auth.signInWithPassword({ email, password }), 'Signing in synthetic account')
  return client
}
async function functionCall(client, action, body, extraHeaders = {}) {
  return client.functions.invoke('sanitize-anonymous-evidence', { body, headers: { 'x-evidence-action': action, ...extraHeaders } })
}

try {
  const reporter = await createUser('reporter')
  const admin = await createUser('admin')
  const unrelated = await createUser('other')
  stage = 'test organization'
  assert(sql(`select count(*) as count from public.organizations where id='${org}' or company_code='ANON_PRIVACY_TEST_ONLY';`)[0].count === 0,
    'The designated test organization already exists')
  organizationCreated = true
  sql(`begin;
    set local app.super_admin_initialization = 'on';
    insert into public.organizations(id,company_code,company_name,industry,company_size,country,state,contact_email,contact_phone,original_super_admin_id)
    values ('${org}','ANON_PRIVACY_TEST_ONLY','ANONYMOUS PRIVACY TEST ONLY','Testing','1-10','Nigeria','Lagos','test@example.invalid','12345678','${users[1].id}');
    insert into public.profiles(id,organization_id,full_name,account_status) values
      ('${users[0].id}','${org}','${secretName}','active'),
      ('${users[1].id}','${org}','Synthetic administrator','active'),
      ('${users[2].id}','${org}','Synthetic unrelated user','active');
    select set_config('request.jwt.claim.sub','${users[1].id}',true);
    insert into public.memberships(user_id,organization_id,role) values
      ('${users[1].id}','${org}','Super Administrator'),
      ('${users[0].id}','${org}','Field Worker'), ('${users[2].id}','${org}','Field Worker');
    insert into public.company_settings(organization_id,departments,severity_levels,incident_categories,working_hours,weather_conditions)
    values ('${org}','["Operations"]','["Low"]','["General"]','{"shifts":["Day"]}','["Sunny"]');
    insert into public.sites(id, organization_id, name, code) values ('${site}', '${org}', 'Test site', 'TEST');
    insert into sentinel_private.anonymous_test_accounts(user_id) values ('${users[0].id}'),('${users[1].id}');
    commit;`)
  stage = 'gate'
  assert(check(await reporter.rpc('my_anonymous_test_access'), 'Reporter gate') === true, 'Test reporter not enabled')
  assert(check(await unrelated.rpc('my_anonymous_test_access'), 'Other user gate') === false, 'Other user enabled')
  const input = { reportType: 'incident', title: 'Synthetic privacy test', occurredAt: new Date().toISOString(),
    department: 'Operations', shift: 'Day', weatherConditions: 'Sunny', severity: 'Low',
    incidentCategory: 'General', accuracyConfirmed: true }
  const denial = await unrelated.rpc('submit_new_anonymous_incident', { p_input: input, p_client_submission_id: randomUUID() })
  assert(denial.error, 'Unlisted user bypassed the gate')
  stage = 'submission'
  const submission = check(await reporter.rpc('submit_new_anonymous_incident', { p_input: input, p_client_submission_id: randomUUID() }), 'Anonymous submission')
  incidentId = submission.id
  safe(submission)
  assert(incidentId && submission.confirmation === 'Anonymous reporter', 'Invalid submission response')
  stage = 'evidence upload'
  const upload = check(await functionCall(reporter, 'upload', new Blob(['Synthetic evidence'], { type: 'application/octet-stream' }),
    { 'x-incident-id': incidentId, 'x-evidence-type': 'text/plain' }), 'Evidence upload')
  evidenceId = upload.evidence.id
  paths.push(upload.evidence.storage_path)
  safe(upload)
  assert(upload.evidence.uploaded_by === null && upload.evidence.original_filename === 'Evidence', 'Evidence metadata exposes uploader')
  const stored = check(await adminApi.from('incident_evidence').select('*').eq('id', evidenceId).single(), 'Stored evidence')
  safe(stored)
  assert(stored.uploaded_by === null, 'Uploader ID stored')
  const objects = sql(`select owner, owner_id, user_metadata from storage.objects where bucket_id='anonymous-incident-evidence' and name='${stored.storage_path}';`)
  assert(objects.length === 1 && !objects[0].owner && !objects[0].owner_id && !objects[0].user_metadata, 'Storage object has identity metadata')
  stage = 'signed evidence download'
  const signed = check(await functionCall(reporter, 'download', { evidenceId }), 'Reporter signed URL')
  safe(signed)
  const downloaded = await fetch(signed.signedUrl)
  assert(downloaded.ok, 'Reporter signed URL did not work')
  const downloadedBytes = Buffer.from(await downloaded.arrayBuffer())
  assert(downloadedBytes.length > 0, 'Downloaded evidence is empty')
  safe(downloadedBytes.toString('latin1'))
  const adminSigned = check(await functionCall(admin, 'download', { evidenceId }), 'Administrator signed URL')
  safe(adminSigned)
  assert((await fetch(adminSigned.signedUrl)).ok, 'Authorized admin could not open evidence')
  assert((await functionCall(unrelated, 'download', { evidenceId })).error, 'Unrelated user opened evidence')
  stage = 'my reports and API'
  const own = check(await reporter.rpc('get_my_incidents'), 'My Reports')
  assert(own.some((row) => row.id === incidentId), 'Reporter cannot find own report')
  safe(own)
  const otherOwn = check(await unrelated.rpc('get_my_incidents'), 'Other My Reports')
  const adminOwn = check(await admin.rpc('get_my_incidents'), 'Admin My Reports')
  assert(!otherOwn.some((row) => row.id === incidentId) && !adminOwn.some((row) => row.id === incidentId), 'My Reports isolation failed')
  const visible = check(await admin.from('incidents').select('*').eq('id', incidentId).single(), 'Admin incident access')
  safe(visible)
  assert(visible.is_anonymous && !visible.created_by && !visible.reported_by && !visible.digital_signature, 'Incident identity was stored')
  const expanded = check(await admin.from('incidents').select('*,incident_evidence!incident_evidence_incident_id_fkey(*)').eq('id', incidentId).single(), 'Expanded incident access')
  safe(expanded)
  assert(expanded.incident_evidence?.some((item) => item.id === evidenceId && item.uploaded_by === null), 'Expanded evidence missing')
  stage = 'notifications'
  const investigation = check(await admin.rpc('create_investigation', {
    target_incident_id: incidentId, target_investigator_id: users[1].id,
  }), 'Investigation assignment')
  safe(investigation)
  const notifications = check(await reporter.rpc('get_my_report_notifications'), 'Reporter notifications')
  assert(notifications.some((item) => item.incident_id === incidentId && item.status === 'investigation_assigned'), 'Notification missing')
  safe(notifications)
  assert(notifications.every((item) => Object.keys(item).sort().join(',') === 'incident_id,status'), 'Notification content unsafe')
  assert(!(check(await unrelated.rpc('get_my_report_notifications'), 'Other notifications')).some((item) => item.incident_id === incidentId), 'Notification leaked')
  console.log('PASS: live gate, submission, evidence, My Reports, notification and role isolation')
  stage = 'identified report and actions'
  const identified = check(await admin.rpc('submit_new_incident', { p_input: { ...input, title: 'Identified test', digitalSignature: 'Synthetic administrator' } }), 'Identified submission')
  assert(identified.reported_by === users[1].id && identified.created_by === users[1].id && !identified.is_anonymous,
    'Identified reporting changed')
  const identifiedPath = `${org}/${identified.id}/${users[1].id}/${randomUUID()}-identified.pdf`
  const identifiedStorage = admin.storage.from('incident-evidence')
  check(await identifiedStorage.upload(identifiedPath, new Blob(['identified evidence'], { type: 'application/pdf' }), { contentType: 'application/pdf' }), 'Identified evidence upload')
  identifiedPaths.push(identifiedPath)
  check(await admin.from('incident_evidence').insert({ organization_id: org, incident_id: identified.id, storage_path: identifiedPath,
    original_filename: 'identified.pdf', mime_type: 'application/pdf', file_size: 19, uploaded_by: users[1].id }), 'Identified evidence metadata')
  const identifiedFile = check(await identifiedStorage.download(identifiedPath), 'Identified evidence download')
  assert(await identifiedFile.text() === 'identified evidence', 'Identified evidence changed')
  const action = check(await admin.from('actions').insert({ organization_id: org, type: 'corrective', description: 'Synthetic action',
    site_id: site, assignee_id: users[1].id, created_by: users[1].id, due_at: new Date(Date.now() + 86400000).toISOString(), status: 'open' }).select('id,assignee_id').single(), 'Create action')
  assert(action.assignee_id === users[1].id, 'Action assignment changed')
  assert(check(await admin.from('actions').select('id').eq('id', action.id).single(), 'Action register').id === action.id, 'Action not registered')
  console.log('PASS: live identified report, evidence upload/download and action register')
  stage = 'AI permission denial'
  sql(`update public.organization_builtin_role_settings
    set permissions = permissions - 'use_ai_assistant'
    where organization_id = '${org}' and role_key = 'Field Worker';`)
  assert(check(await unrelated.rpc('can_use_ai_sessions', { target_organization_id: org }), 'AI permission lookup') === false,
    'Synthetic field worker still has AI access')
  const deniedAi = await unrelated.functions.invoke('ai-service', {
    body: { feature: 'qhse_knowledge', prompt: 'Synthetic permission test.' },
  })
  assert(deniedAi.error && deniedAi.response?.status === 403, 'Revoked built-in role reached AI')
  console.log('PASS: live AI rejects a built-in role with revoked AI permission')
  if (process.env.EVIDENCE_TEST_SKIP_AI !== '1') {
    stage = 'AI summary'
    const session = check(await admin.rpc('create_ai_session', { p_title: 'Synthetic privacy test' }), 'Create AI session')
    const aiResult = await admin.functions.invoke('ai-service', {
      body: { feature: 'safety_copilot', sessionId: session.id, prompt: 'Summarize accessible incidents.', days: 90 },
    })
    if (aiResult.error) {
      const log = await adminApi.from('ai_request_logs').select('error_code,response_metadata')
        .eq('organization_id', org).order('requested_at', { ascending: false }).limit(1).maybeSingle()
      const status = log.data?.response_metadata?.provider_http_status
      throw new Error(`AI provider failed (${log.data?.error_code || 'unknown'}${typeof status === 'number' ? `, HTTP ${status}` : ''})`)
    }
    const answer = aiResult.data
    safe(answer)
    assert(answer.ok && answer.content?.text, 'AI summary missing')
    console.log('PASS: live AI summary contains no synthetic reporter identity')
  }
} catch (error) {
  failures.push(`${stage}: ${error.message}`)
} finally {
  for (const path of paths) {
    const result = await adminApi.storage.from('anonymous-incident-evidence').remove([path])
    if (result.error) failures.push('Failed to clean up synthetic evidence object')
  }
  for (const path of identifiedPaths) {
    const result = await adminApi.storage.from('incident-evidence').remove([path])
    if (result.error) failures.push('Failed to clean up synthetic identified evidence object')
  }
  if (organizationCreated) {
    try {
      sql(`begin;
        delete from public.ai_sessions where organization_id='${org}'
          and exists (select 1 from public.organizations where id='${org}' and company_code='ANON_PRIVACY_TEST_ONLY');
        delete from public.actions where organization_id='${org}'
          and exists (select 1 from public.organizations where id='${org}' and company_code='ANON_PRIVACY_TEST_ONLY');
        delete from public.incidents where organization_id='${org}'
          and exists (select 1 from public.organizations where id='${org}' and company_code='ANON_PRIVACY_TEST_ONLY');
        do $$ begin
          if exists (select 1 from public.organization_policy_objective_permission_overrides where organization_id='${org}')
            or exists (select 1 from public.legal_compliance_obligation_versions where organization_id='${org}') then
            raise exception 'Unexpected dependent test records';
          end if;
        end $$;
        set local session_replication_role = replica;
        delete from public.memberships where organization_id='${org}'
          and exists (select 1 from public.organizations where id='${org}' and company_code='ANON_PRIVACY_TEST_ONLY');
        set local session_replication_role = origin;
        delete from public.profiles where organization_id='${org}'
          and exists (select 1 from public.organizations where id='${org}' and company_code='ANON_PRIVACY_TEST_ONLY');
        delete from public.organizations where id='${org}' and company_code='ANON_PRIVACY_TEST_ONLY';
        commit;`)
    } catch (error) { failures.push(`Organization cleanup: ${error.message}`) }
  }
  for (const user of users) {
    const result = await adminApi.auth.admin.deleteUser(user.id)
    if (result.error) failures.push('Failed to clean up a synthetic account')
  }
}
if (failures.length) {
  console.error(failures.join('\n'))
  process.exitCode = 1
}
