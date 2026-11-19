begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
values
  ('d3000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'investigation-record-admin@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('d3000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'investigation-record-team@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('d3000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'investigation-record-resolver@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('d3000000-0000-4000-8000-000000000004', 'authenticated', 'authenticated', 'investigation-record-verifier@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()),
  ('d3000000-0000-4000-8000-000000000005', 'authenticated', 'authenticated', 'investigation-record-handler@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now());

select set_config('app.super_admin_initialization', 'on', true);
insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
values ('d4000000-0000-4000-8000-000000000001', 'INV_RECORD_TEST',
  'Investigation Record Test', 'Testing', '1-10', 'Nigeria', 'Lagos',
  'investigation-record@example.com', '12345678', 'd3000000-0000-4000-8000-000000000001');
insert into public.profiles(id, organization_id, full_name, account_status)
values
  ('d3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Investigation Admin', 'active'),
  ('d3000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000001', 'Investigation Team Member', 'active'),
  ('d3000000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000001', 'Action Resolver', 'active'),
  ('d3000000-0000-4000-8000-000000000004', 'd4000000-0000-4000-8000-000000000001', 'Incident Verifier', 'active'),
  ('d3000000-0000-4000-8000-000000000005', 'd4000000-0000-4000-8000-000000000001', 'Reopen Handler', 'active');
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
insert into public.memberships(user_id, organization_id, role)
values
  ('d3000000-0000-4000-8000-000000000001', 'd4000000-0000-4000-8000-000000000001', 'Super Administrator'),
  ('d3000000-0000-4000-8000-000000000002', 'd4000000-0000-4000-8000-000000000001', 'Field Worker'),
  ('d3000000-0000-4000-8000-000000000003', 'd4000000-0000-4000-8000-000000000001', 'Field Worker'),
  ('d3000000-0000-4000-8000-000000000004', 'd4000000-0000-4000-8000-000000000001', 'Field Worker'),
  ('d3000000-0000-4000-8000-000000000005', 'd4000000-0000-4000-8000-000000000001', 'Field Worker');
insert into public.company_settings(
  organization_id, departments, severity_levels, incident_categories, working_hours
) values (
  'd4000000-0000-4000-8000-000000000001',
  '["Operations"]', '["High"]', '["Testing"]', '{"shifts":["Day"]}'
);
insert into public.investigation_deadlines(
  organization_id, critical_hours, high_hours, medium_hours, low_hours
) values (
  'd4000000-0000-4000-8000-000000000001', 24, 6, 168, 336
);
insert into public.investigation_team_members(organization_id, severity_level, user_id, added_by)
values ('d4000000-0000-4000-8000-000000000001', 'High',
  'd3000000-0000-4000-8000-000000000002', 'd3000000-0000-4000-8000-000000000001');
insert into public.sites(id, organization_id, name, code)
values (
  'd5000000-0000-4000-8000-000000000001',
  'd4000000-0000-4000-8000-000000000001',
  'Investigation Test Site',
  'INVTEST'
);

set local role authenticated;
do $$
declare
  submitted public.incidents;
  action_id uuid;
begin
  submitted := public.submit_new_incident(jsonb_build_object(
    'reportType', 'incident',
    'title', 'Investigation workflow test',
    'occurredAt', now() - interval '1 hour',
    'severity', 'High',
    'incidentCategory', 'Testing',
    'department', 'Operations',
    'shift', 'Day',
    'weatherConditions', 'Sunny',
    'accuracyConfirmed', true
  ));
  perform set_config('test.investigation_record_incident', submitted.id::text, true);
  perform set_config('test.investigation_record_id',
    (select id::text from public.investigations where incident_id = submitted.id), true);

  insert into public.incident_evidence(
    organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by
  ) values
    ('d4000000-0000-4000-8000-000000000001', submitted.id,
      'd4000000-0000-4000-8000-000000000001/' || submitted.id::text || '/d3000000-0000-4000-8000-000000000001/report.pdf',
      'report.pdf', 'application/pdf', 100, 'd3000000-0000-4000-8000-000000000001'),
    ('d4000000-0000-4000-8000-000000000001', submitted.id,
      'd4000000-0000-4000-8000-000000000001/' || submitted.id::text || '/d3000000-0000-4000-8000-000000000001/report.txt',
      'report.txt', 'text/plain', 100, 'd3000000-0000-4000-8000-000000000001');
  perform set_config('test.investigation_report_id',
    (select id::text from public.incident_evidence where incident_id = submitted.id and original_filename = 'report.pdf'), true);
  perform set_config('test.investigation_invalid_report_id',
    (select id::text from public.incident_evidence where incident_id = submitted.id and original_filename = 'report.txt'), true);

  insert into public.actions(
    organization_id, incident_id, type, description, site_id, assignee_id, due_at
  ) values (
    'd4000000-0000-4000-8000-000000000001', submitted.id, 'corrective',
    'Complete the investigation action',
    'd5000000-0000-4000-8000-000000000001',
    'd3000000-0000-4000-8000-000000000003',
    now() + interval '1 day'
  ) returning id into action_id;
  perform set_config('test.investigation_record_action_id', action_id::text, true);
end;
$$;

select public.set_incident_closure_delegate('d3000000-0000-4000-8000-000000000003', true);
select public.set_incident_closure_delegate('d3000000-0000-4000-8000-000000000004', true);

select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select extensions.throws_ok(
  format(
    'select public.save_investigation_record(%L::uuid, %L::jsonb, true)',
    current_setting('test.investigation_record_id'),
    '{}'::text
  ),
  'P0001',
  'Immediate causes are required',
  'server rejects closing without compulsory fields'
);

select extensions.throws_ok(
  format(
    'select public.save_investigation_record(%L::uuid, %L::jsonb, true)',
    current_setting('test.investigation_record_id'),
    jsonb_build_object(
      'immediate_causes', 'A required cause',
      'root_cause_method', '5_whys',
      'root_cause_breakdown', jsonb_build_object('method', '5_whys', 'answers', '[]'::jsonb),
      'report_evidence_id', current_setting('test.investigation_report_id'),
      'attachment_ids', '[]'::jsonb
    )::text
  ),
  'P0001',
  'Complete the root cause analysis and mark at least one root cause',
  'server rejects closing without a root cause'
);

select extensions.throws_ok(
  format(
    'select public.save_investigation_record(%L::uuid, %L::jsonb, true)',
    current_setting('test.investigation_record_id'),
    jsonb_build_object(
      'immediate_causes', 'A required cause',
      'root_cause_method', '5_whys',
      'root_cause_breakdown', jsonb_build_object('method', '5_whys', 'answers', jsonb_build_array('A root cause')),
      'attachment_ids', '[]'::jsonb
    )::text
  ),
  'P0001',
  'An investigation report is required',
  'server rejects closing without the investigation report'
);

select extensions.throws_ok(
  format(
    'update public.investigations set status = ''completed'' where id = %L::uuid',
    current_setting('test.investigation_record_id')
  ),
  'P0001',
  'Complete the investigation record and attach a valid report before closing',
  'direct status updates cannot bypass compulsory investigation fields or report evidence'
);

select public.save_investigation_record(
  current_setting('test.investigation_record_id')::uuid,
  jsonb_build_object(
    'immediate_causes', 'A required cause',
    'root_cause_method', '5_whys',
    'root_cause_breakdown', jsonb_build_object('method', '5_whys', 'answers', jsonb_build_array('Why one', 'Why two')),
    'report_evidence_id', current_setting('test.investigation_report_id'),
    'attachment_ids', '[]'::jsonb
  ),
  false
);
select extensions.is(
  public.get_investigation_record(current_setting('test.investigation_record_id')::uuid)
    #>> '{investigation,root_causes_summary}',
  'Why two',
  '5 Whys breakdown reloads with its final answer as the root cause'
);

select public.save_investigation_record(
  current_setting('test.investigation_record_id')::uuid,
  jsonb_build_object(
    'immediate_causes', 'A required cause',
    'root_cause_method', 'fishbone',
    'root_cause_breakdown', jsonb_build_object('method', 'fishbone', 'categories', jsonb_build_object(
      'People', jsonb_build_array(jsonb_build_object('cause', 'Fatigue', 'is_root_cause', true)),
      'Process', '[]'::jsonb, 'Equipment', '[]'::jsonb,
      'Environment', '[]'::jsonb, 'Management', '[]'::jsonb
    )),
    'report_evidence_id', current_setting('test.investigation_report_id'),
    'attachment_ids', '[]'::jsonb
  ),
  false
);
select extensions.is(
  public.get_investigation_record(current_setting('test.investigation_record_id')::uuid)
    #>> '{investigation,root_causes_summary}',
  'Fatigue',
  'Fishbone breakdown reloads with marked causes as the root cause'
);

select public.save_investigation_record(
  current_setting('test.investigation_record_id')::uuid,
  jsonb_build_object(
    'immediate_causes', 'A required cause',
    'root_cause_method', 'fault_tree',
    'root_cause_breakdown', jsonb_build_object(
      'method', 'fault_tree', 'top_event', 'Top event', 'gate', 'OR',
      'causes', jsonb_build_array(jsonb_build_object(
        'cause', 'Branch', 'gate', 'AND', 'is_root_cause', false,
        'children', jsonb_build_array(jsonb_build_object(
          'cause', 'Failed control', 'gate', 'OR', 'is_root_cause', true, 'children', '[]'::jsonb
        ))
      ))
    ),
    'report_evidence_id', current_setting('test.investigation_report_id'),
    'attachment_ids', '[]'::jsonb
  ),
  false
);
select extensions.is(
  public.get_investigation_record(current_setting('test.investigation_record_id')::uuid)
    #>> '{investigation,root_causes_summary}',
  'Failed control',
  'Fault Tree breakdown reloads with marked bottom-level causes as root cause'
);

select extensions.throws_ok(
  format(
    'select public.save_investigation_record(%L::uuid, %L::jsonb, true)',
    current_setting('test.investigation_record_id'),
    jsonb_build_object(
      'immediate_causes', 'A required cause',
      'root_cause_method', '5_whys',
      'root_cause_breakdown', jsonb_build_object('method', '5_whys', 'answers', jsonb_build_array('Root cause')),
      'report_evidence_id', current_setting('test.investigation_invalid_report_id'),
      'attachment_ids', '[]'::jsonb
    )::text
  ),
  'P0001',
  'The investigation report must be a PDF or Word document',
  'server rejects unsupported report file types'
);

select public.save_investigation_record(
  current_setting('test.investigation_record_id')::uuid,
  jsonb_build_object(
    'immediate_causes', 'A required cause',
    'root_cause_method', '5_whys',
    'root_cause_breakdown', jsonb_build_object('method', '5_whys', 'answers', jsonb_build_array('Final root cause')),
    'report_evidence_id', current_setting('test.investigation_report_id'),
    'attachment_ids', '[]'::jsonb
  ),
  true
);
reset role;
select extensions.is(
  (select status::text from public.investigations where id = current_setting('test.investigation_record_id')::uuid),
  'completed',
  'closing an investigation marks it completed'
);
select extensions.is(
  (select status::text from public.incidents where id = current_setting('test.investigation_record_incident')::uuid),
  'submitted',
  'closing an investigation does not close its incident'
);
select extensions.is(
  (select count(*)::integer from public.investigation_timeline_events
   where investigation_id = current_setting('test.investigation_record_id')::uuid and event_type = 'completed'),
  1,
  'closing records a completion timeline event'
);
select extensions.is(
  (select count(*)::integer from sentinel_private.reporter_notifications
   where incident_id = current_setting('test.investigation_record_incident')::uuid
     and status = 'investigated'),
  1,
  'closing notifies the reporter through the existing private status link'
);
select extensions.is(
  (select due_at - created_at from public.investigations
   where id = current_setting('test.investigation_record_id')::uuid),
  interval '6 hours',
  'the configured High deadline is used for investigation due dates'
);

insert into storage.objects(bucket_id, name, owner, owner_id, metadata)
values (
  'incident-evidence',
  'd4000000-0000-4000-8000-000000000001/actions/'
    || current_setting('test.investigation_record_action_id')
    || '/d3000000-0000-4000-8000-000000000003/resolution.png',
  'd3000000-0000-4000-8000-000000000003'::uuid,
  'd3000000-0000-4000-8000-000000000003',
  '{"size":100,"mimetype":"image/png"}'::jsonb
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select extensions.throws_ok(
  format(
    'update public.actions set status = ''resolved'', resolution_notes = '' '' , '
    || 'proof_storage_path = %L, proof_file_name = ''resolution.png'', '
    || 'proof_file_type = ''image/png'', proof_file_size = 100 where id = %L::uuid',
    'd4000000-0000-4000-8000-000000000001/actions/'
      || current_setting('test.investigation_record_action_id')
      || '/d3000000-0000-4000-8000-000000000003/resolution.png',
    current_setting('test.investigation_record_action_id')
  ),
  'P0001',
  'Resolution details are required',
  'action resolution requires nonblank details'
);
select extensions.throws_ok(
  format(
    'update public.actions set status = ''resolved'', resolution_notes = ''Completed work'' '
    || 'where id = %L::uuid',
    current_setting('test.investigation_record_action_id')
  ),
  'P0001',
  'A valid photo or document upload is required',
  'action resolution requires uploaded evidence'
);
update public.actions
set status = 'resolved',
    resolution_notes = 'Completed work and checked the result',
    proof_storage_path = 'd4000000-0000-4000-8000-000000000001/actions/'
      || current_setting('test.investigation_record_action_id')
      || '/d3000000-0000-4000-8000-000000000003/resolution.png',
    proof_file_name = 'resolution.png',
    proof_file_type = 'image/png',
    proof_file_size = 100
where id = current_setting('test.investigation_record_action_id')::uuid;
select extensions.is(
  (select status::text from public.incidents
   where id = current_setting('test.investigation_record_incident')::uuid),
  'pending_verification',
  'completed investigation and resolved actions put the incident into verification'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.incident_workflow_notifications
   where incident_id = current_setting('test.investigation_record_incident')::uuid
     and notification_type = 'verification_ready'),
  3,
  'closure delegates receive in-app verification notifications'
);
set local role authenticated;
select extensions.lives_ok(
  format(
    'select public.acknowledge_investigation_view(%L::uuid)',
    current_setting('test.investigation_record_id')
  ),
  'an action resolver can view the investigation before attempting verification'
);
select extensions.throws_ok(
  format(
    'select public.confirm_incident_closeout(%L::uuid)',
    current_setting('test.investigation_record_incident')
  ),
  '42501',
  'A person who resolved an action on this incident cannot verify its close-out',
  'an action resolver cannot verify the incident close-out'
);

select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select extensions.throws_ok(
  format(
    'update public.incidents set status = ''closed'' where id = %L::uuid',
    current_setting('test.investigation_record_incident')
  ),
  '42501',
  'Only an authorized close-out verification can close this incident',
  'direct incident updates cannot close without verifier confirmation'
);
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select extensions.is(
  public.get_investigation_record(current_setting('test.investigation_record_id')::uuid)->'can_edit',
  'false'::jsonb,
  'a verifier without an individual assignment receives a false edit flag'
);
select extensions.is(
  (select can_edit from public.list_investigations()
   where investigation_id = current_setting('test.investigation_record_id')::uuid),
  false,
  'a verifier receives a false edit flag in the investigation list'
);
select extensions.is(
  jsonb_array_length(public.get_investigation_record(current_setting('test.investigation_record_id')::uuid)->'linked_actions'),
  1,
  'a verifier can see the linked action'
);
select extensions.is(
  (select count(*)::integer from public.get_verifier_incident_actions(current_setting('test.investigation_record_incident')::uuid)),
  1,
  'incident detail lists linked actions for a verifier who is not the assignee'
);
select public.acknowledge_investigation_view(
  current_setting('test.investigation_record_id')::uuid
);
select public.confirm_incident_closeout(
  current_setting('test.investigation_record_incident')::uuid
);
select extensions.is(
  (select status::text from public.incidents
   where id = current_setting('test.investigation_record_incident')::uuid),
  'closed',
  'authorized verifier confirmation closes the incident'
);

select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.reopen_incident(
  current_setting('test.investigation_record_incident')::uuid,
  'd3000000-0000-4000-8000-000000000005',
  'Regression test reopen'
);
select extensions.is(
  (select status::text from public.incidents
   where id = current_setting('test.investigation_record_incident')::uuid),
  'open',
  'Super Administrator can reopen a closed incident'
);
reset role;
select extensions.is(
  (select assigned_investigator_id from public.investigations
   where id = current_setting('test.investigation_record_id')::uuid),
  'd3000000-0000-4000-8000-000000000005'::uuid,
  'reopened investigation is assigned to the selected handler'
);
select extensions.is(
  (select count(*)::integer from public.investigation_timeline_events
   where investigation_id = current_setting('test.investigation_record_id')::uuid
     and event_type = 'reopened'),
  1,
  'reopening adds an investigation timeline event'
);
select extensions.is(
  (select count(*)::integer from public.incident_workflow_notifications
   where incident_id = current_setting('test.investigation_record_incident')::uuid
     and user_id = 'd3000000-0000-4000-8000-000000000005'
     and notification_type = 'reopened'),
  1,
  'the reopened handler receives an in-app notification'
);
set local role authenticated;
select extensions.is(
  (select count(distinct status)::integer
   from public.get_my_report_notifications()
   where incident_id = current_setting('test.investigation_record_incident')::uuid
     and status in ('investigation_assigned', 'investigated', 'closed', 'reopened')),
  4,
  'identified reporters receive the complete investigation, close, and reopen status progression'
);

select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.submit_new_anonymous_incident(
  jsonb_build_object(
    'reportType', 'incident',
    'title', 'Anonymous verifier privacy test',
    'occurredAt', now() - interval '1 hour',
    'severity', 'High',
    'incidentCategory', 'Testing',
    'department', 'Operations',
    'shift', 'Day',
    'weatherConditions', 'Sunny',
    'accuracyConfirmed', true,
    'digitalSignature', 'ANONYMOUS_VERIFIER_PRIVATE_MARKER'
  ),
  'investigation-verifier-privacy-test'
);
select set_config(
  'test.anonymous_investigation_incident_id',
  (select incident.id::text
   from public.incidents incident
   where incident.title = 'Anonymous verifier privacy test'
     and incident.is_anonymous),
  true
);
select set_config(
  'test.anonymous_investigation_id',
  (select investigation.id::text
   from public.investigations investigation
   join public.incidents incident on incident.id = investigation.incident_id
   where incident.title = 'Anonymous verifier privacy test'
     and incident.is_anonymous),
  true
);
insert into public.actions(organization_id, incident_id, type, description, site_id, assignee_id, due_at)
values (
  'd4000000-0000-4000-8000-000000000001',
  current_setting('test.anonymous_investigation_incident_id')::uuid,
  'corrective', 'ANONYMOUS_VERIFIER_PRIVATE_MARKER',
  'd5000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000003', now() + interval '1 day'
);
select set_config('test.anonymous_action_id',
  (select id::text from public.actions where incident_id = current_setting('test.anonymous_investigation_incident_id')::uuid), true);
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
insert into storage.objects(bucket_id, name, owner, owner_id)
values (
  'incident-evidence',
  'd4000000-0000-4000-8000-000000000001/'
    || current_setting('test.anonymous_investigation_incident_id')
    || '/e4000000-0000-4000-8000-000000000001',
  'd3000000-0000-4000-8000-000000000002'::uuid,
  'd3000000-0000-4000-8000-000000000002'
);
insert into public.incident_evidence(
  organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by
) values (
  'd4000000-0000-4000-8000-000000000001',
  current_setting('test.anonymous_investigation_incident_id')::uuid,
  'd4000000-0000-4000-8000-000000000001/'
    || current_setting('test.anonymous_investigation_incident_id')
    || '/e4000000-0000-4000-8000-000000000001',
  'anonymous-investigation-report.pdf',
  'application/pdf',
  100,
  'd3000000-0000-4000-8000-000000000002'
);
select set_config(
  'test.anonymous_investigation_report_id',
  (select id::text from public.incident_evidence
   where incident_id = current_setting('test.anonymous_investigation_incident_id')::uuid
     and original_filename = 'anonymous-investigation-report.pdf'),
  true
);
select public.save_investigation_record(
  current_setting('test.anonymous_investigation_id')::uuid,
  jsonb_build_object(
    'immediate_causes', 'A required anonymous-investigation cause',
    'root_cause_method', '5_whys',
    'root_cause_breakdown', jsonb_build_object(
      'method', '5_whys', 'answers', jsonb_build_array('An investigator-entered root cause')
    ),
    'report_evidence_id', current_setting('test.anonymous_investigation_report_id'),
    'attachment_ids', '[]'::jsonb
  ),
  true
);
reset role;
select extensions.is(
  (select uploaded_by from public.incident_evidence
   where id = current_setting('test.anonymous_investigation_report_id')::uuid),
  'd3000000-0000-4000-8000-000000000002'::uuid,
  'anonymous investigation report is stored under the investigator identity'
);
select extensions.is(
  (select status::text from public.investigations
   where id = current_setting('test.anonymous_investigation_id')::uuid),
  'completed',
  'investigator can close an anonymous investigation after uploading its report'
);
select extensions.ok(
  not (
    public.get_investigation_record(current_setting('test.anonymous_investigation_id')::uuid)::text
      like '%ANONYMOUS_VERIFIER_PRIVATE_MARKER%'
  )
  and not (
    public.get_investigation_record(current_setting('test.anonymous_investigation_id')::uuid)::text
      like '%reporter%'
  ),
  'closed anonymous investigation view contains no reporter identity'
);

reset role;
insert into storage.objects(bucket_id, name, owner, owner_id, metadata)
values (
  'incident-evidence',
  'd4000000-0000-4000-8000-000000000001/actions/' || current_setting('test.anonymous_action_id')
    || '/d3000000-0000-4000-8000-000000000003/resolution.pdf',
  'd3000000-0000-4000-8000-000000000003',
  'd3000000-0000-4000-8000-000000000003',
  '{"size":100,"mimetype":"application/pdf"}'::jsonb
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000003', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
select extensions.throws_ok(
  format('update public.actions set status = ''resolved'', resolution_notes = ''done'' where id = %L::uuid',
    current_setting('test.anonymous_action_id')),
  'P0001', 'A valid photo or document upload is required',
  'anonymous action resolution requires uploaded evidence'
);
select extensions.throws_ok(
  format('update public.actions set status = ''resolved'', resolution_notes = '' '', proof_storage_path = %L, proof_file_name = ''resolution.pdf'', proof_file_type = ''application/pdf'', proof_file_size = 100 where id = %L::uuid',
    'd4000000-0000-4000-8000-000000000001/actions/' || current_setting('test.anonymous_action_id') || '/d3000000-0000-4000-8000-000000000003/resolution.pdf',
    current_setting('test.anonymous_action_id')),
  'P0001', 'Resolution details are required',
  'anonymous action resolution requires details'
);
update public.actions set status = 'resolved', resolution_notes = 'Completed work',
  proof_storage_path = 'd4000000-0000-4000-8000-000000000001/actions/' || current_setting('test.anonymous_action_id') || '/d3000000-0000-4000-8000-000000000003/resolution.pdf',
  proof_file_name = 'resolution.pdf', proof_file_type = 'application/pdf', proof_file_size = 100
where id = current_setting('test.anonymous_action_id')::uuid;
select public.acknowledge_investigation_view(current_setting('test.anonymous_investigation_id')::uuid);
select extensions.throws_ok(
  format('select public.confirm_incident_closeout(%L::uuid)', current_setting('test.anonymous_investigation_incident_id')),
  '42501', 'A person who resolved an action on this incident cannot verify its close-out',
  'anonymous incident resolver cannot verify their own action'
);
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000004', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000004","role":"authenticated"}', true);
select extensions.ok(
  (select count(*) = 1 and bool_and(description = 'Linked action')
     and bool_and(assignee_id is null and resolved_by is null)
   from public.get_verifier_incident_actions(current_setting('test.anonymous_investigation_incident_id')::uuid)),
  'anonymous verifier action list is complete and redacts potentially identifying details'
);
select public.acknowledge_investigation_view(current_setting('test.anonymous_investigation_id')::uuid);
select public.confirm_incident_closeout(current_setting('test.anonymous_investigation_incident_id')::uuid);
select extensions.is(
  (select status::text from public.incidents where id = current_setting('test.anonymous_investigation_incident_id')::uuid),
  'closed', 'a different verifier closes the anonymous incident after action resolution'
);
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000001', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
select public.reopen_incident(current_setting('test.anonymous_investigation_incident_id')::uuid,
  'd3000000-0000-4000-8000-000000000005', 'Reopen for review');
select extensions.is(
  (select status from public.get_my_report_notifications()
   where incident_id = current_setting('test.anonymous_investigation_incident_id')::uuid and status = 'reopened'),
  'reopened', 'anonymous reporter receives reopened status'
);
reset role;
select extensions.is(
  (select count(*)::integer from public.incident_workflow_notifications
   where incident_id = current_setting('test.anonymous_investigation_incident_id')::uuid
     and user_id = 'd3000000-0000-4000-8000-000000000005' and notification_type = 'reopened'),
  1, 'anonymous reopen notifies the selected handler'
);
select extensions.is(
  (select count(*)::integer from public.investigation_timeline_events
   where investigation_id = current_setting('test.anonymous_investigation_id')::uuid and event_type = 'reopened'),
  1, 'anonymous reopen adds a timeline entry'
);
set local role authenticated;
select set_config('request.jwt.claim.sub', 'd3000000-0000-4000-8000-000000000002', true);
select set_config('request.jwt.claims', '{"sub":"d3000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
select extensions.throws_ok(
  format('select * from public.get_verifier_incident_actions(%L::uuid)', current_setting('test.anonymous_investigation_incident_id')),
  '42501', 'Not authorized to view incident actions',
  'non-verifier cannot use verifier action access'
);

select * from extensions.finish();
rollback;
