begin;
create extension if not exists pgtap with schema extensions;
select extensions.no_plan();

insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
select ('d1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'authenticated', 'authenticated', 'investigation-auto-' || n || '@example.com', '',
  '{}'::jsonb, '{}'::jsonb, now(), now()
from generate_series(1, 5) n;

select set_config('app.super_admin_initialization', 'on', true);

insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
values ('d2000000-0000-4000-8000-000000000001', 'INV_AUTOMATION_TEST',
  'Investigation Automation Test', 'Testing', '1-10', 'Nigeria', 'Lagos',
  'investigation-test@example.com', '12345678', 'd1000000-0000-4000-8000-000000000001');

insert into public.company_settings(
  organization_id, departments, severity_levels, incident_categories, working_hours
) values (
  'd2000000-0000-4000-8000-000000000001',
  '["Operations"]', '["Critical","High","Low"]', '["Testing"]', '{"shifts":["Day"]}'
);

insert into public.profiles(id, organization_id, full_name, account_status)
select ('d1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'd2000000-0000-4000-8000-000000000001',
  'Investigation Test User ' || n, 'active'
from generate_series(1, 5) n;

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);

insert into public.memberships(user_id, organization_id, role)
select ('d1000000-0000-4000-8000-' || lpad(n::text, 12, '0'))::uuid,
  'd2000000-0000-4000-8000-000000000001',
  case when n = 1 then 'Super Administrator'::public.membership_role
       else 'Field Worker'::public.membership_role end
from generate_series(1, 5) n;

insert into public.investigation_deadlines(organization_id, critical_hours, high_hours, medium_hours, low_hours)
values ('d2000000-0000-4000-8000-000000000001', 8, 4, 168, 336);

insert into public.investigation_team_members(organization_id, severity_level, user_id, added_by)
values
  ('d2000000-0000-4000-8000-000000000001', 'High',
    'd1000000-0000-4000-8000-000000000002', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'High',
    'd1000000-0000-4000-8000-000000000003', 'd1000000-0000-4000-8000-000000000001'),
  ('d2000000-0000-4000-8000-000000000001', 'Critical',
    'd1000000-0000-4000-8000-000000000005', 'd1000000-0000-4000-8000-000000000001');

insert into public.incident_closure_delegates(organization_id, user_id, granted_role, granted_by)
values ('d2000000-0000-4000-8000-000000000001',
  'd1000000-0000-4000-8000-000000000003', 'Field Worker',
  'd1000000-0000-4000-8000-000000000001');

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
set local role authenticated;

do $$
declare submitted public.incidents;
begin
  submitted := public.submit_new_incident(jsonb_build_object(
    'reportType', 'incident',
    'title', 'Identified investigation test',
    'occurredAt', now() - interval '1 hour',
    'severity', 'High',
    'incidentCategory', 'Testing',
    'department', 'Operations',
    'shift', 'Day',
    'weatherConditions', 'Sunny',
    'accuracyConfirmed', true
  ));
  perform set_config('test.investigation_identified_incident', submitted.id::text, true);

  submitted := public.submit_new_incident(jsonb_build_object(
    'reportType', 'incident',
    'title', 'Unassigned investigation test',
    'occurredAt', now() - interval '1 hour',
    'severity', 'Low',
    'incidentCategory', 'Testing',
    'department', 'Operations',
    'shift', 'Day',
    'weatherConditions', 'Sunny',
    'accuracyConfirmed', true
  ));
  perform set_config('test.investigation_unassigned_incident', submitted.id::text, true);
end;
$$;

select extensions.is(
  (select count(*)::integer from public.investigations
   where incident_id = current_setting('test.investigation_identified_incident')::uuid),
  1, 'identified submission creates exactly one investigation'
);
select extensions.is(
  (select level from public.investigations
   where incident_id = current_setting('test.investigation_identified_incident')::uuid),
  'High', 'investigation severity is copied from the submitted incident'
);
select extensions.ok(
  (select abs(extract(epoch from (due_at - (now() + interval '4 hours')))) < 60
   from public.investigations
   where incident_id = current_setting('test.investigation_identified_incident')::uuid),
  'identified investigation uses the configured severity deadline'
);
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000002', true);
select extensions.is(
  (select count(*)::integer from public.investigation_notifications
   where incident_id = current_setting('test.investigation_identified_incident')::uuid
     and user_id = auth.uid()
     and notification_type = 'assigned'),
  1, 'the first High team member receives an assignment notification'
);
select extensions.ok(
  (select severity = 'High' and due_at = (
     select due_at from public.investigations
     where incident_id = current_setting('test.investigation_identified_incident')::uuid
   )
   from public.investigation_notifications
   where incident_id = current_setting('test.investigation_identified_incident')::uuid
     and user_id = auth.uid() and notification_type = 'assigned'),
  'assignment notification contains the incident, severity, and due date'
);
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select extensions.is(
  (select count(*)::integer from public.investigation_notifications
   where incident_id = current_setting('test.investigation_identified_incident')::uuid
     and user_id = auth.uid()
     and notification_type = 'assigned'),
  1, 'the second High team member receives an assignment notification'
);
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select extensions.ok(
  (select no_team_assigned from public.investigations
   where incident_id = current_setting('test.investigation_unassigned_incident')::uuid),
  'investigation without a configured team is flagged'
);

do $$
declare result jsonb;
begin
  result := public.submit_new_anonymous_incident(jsonb_build_object(
    'reportType', 'incident',
    'title', 'Anonymous investigation test',
    'occurredAt', now() - interval '1 hour',
    'severity', 'Critical',
    'incidentCategory', 'Testing',
    'department', 'Operations',
    'shift', 'Day',
    'weatherConditions', 'Sunny',
    'accuracyConfirmed', true
  ), 'investigation-automation-anonymous-test');
  perform set_config('test.investigation_anonymous_incident', result->>'id', true);
end;
$$;

reset role;

select extensions.is(
  (select count(*)::integer from public.investigations
   where incident_id = current_setting('test.investigation_anonymous_incident')::uuid),
  1, 'private anonymous submission creates an investigation'
);
select extensions.ok(
  (select investigation.created_by is null
   from public.investigations investigation
   where investigation.incident_id = current_setting('test.investigation_anonymous_incident')::uuid),
  'anonymous investigation does not store a reporter identity'
);
select extensions.ok(
  (select event.actor_id is null
     and not (event.details ? 'reporter_id')
     and not (event.details ? 'created_by')
   from public.investigation_timeline_events event
   join public.investigations investigation
     on investigation.id = event.investigation_id
     and investigation.organization_id = event.organization_id
   where investigation.incident_id = current_setting('test.investigation_anonymous_incident')::uuid
     and event.event_type = 'created'),
  'anonymous investigation timeline omits actor identity and reporter fields'
);
select extensions.ok(
  (select not (to_jsonb(notification) ? 'reporter_id')
     and not (to_jsonb(notification) ? 'reported_by')
     and not (to_jsonb(notification) ? 'created_by')
     and notification.user_id <> 'd1000000-0000-4000-8000-000000000001'
   from public.investigation_notifications notification
   where notification.incident_id = current_setting('test.investigation_anonymous_incident')::uuid
     and notification.notification_type = 'assigned'),
  'anonymous assignment notification contains no reporter identity'
);
select extensions.ok(
  (select not (to_jsonb(listed) ? 'reporter_id')
     and not (to_jsonb(listed) ? 'reported_by')
     and not (to_jsonb(listed) ? 'created_by')
   from public.list_investigations() listed
   where listed.incident_id = current_setting('test.investigation_anonymous_incident')::uuid),
  'investigation list API exposes no reporter identity fields'
);

update public.investigations
set due_at = now() - interval '1 hour'
where incident_id = current_setting('test.investigation_identified_incident')::uuid;
update public.investigations
set due_at = now() + interval '2 hours'
where incident_id = current_setting('test.investigation_anonymous_incident')::uuid;

set local role authenticated;
select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000005', true);
select extensions.ok(public.can_access_investigations(), 'severity-team member can open the investigations area');
select extensions.is(
  (select count(*)::integer from public.list_investigations()),
  1, 'team member sees only investigations matching their severity'
);
select extensions.is(
  (select count(*)::integer from public.investigation_notifications
   where incident_id = current_setting('test.investigation_anonymous_incident')::uuid
     and user_id = auth.uid()
     and notification_type = 'due_soon'),
  1, 'register load queues a due-soon reminder for the assigned Critical team'
);

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000003', true);
select extensions.is(
  (select count(*)::integer from public.list_investigations()),
  3, 'closure-access verifier can see all investigations'
);

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000004', true);
select extensions.ok(not public.can_access_investigations(), 'user outside investigation teams cannot open the register');
select extensions.throws_ok(
  $$select * from public.list_investigations()$$,
  '42501', null, 'unauthorized user cannot list investigations'
);

select set_config('request.jwt.claim.sub', 'd1000000-0000-4000-8000-000000000001', true);
select extensions.ok(
  (select listed.is_overdue from public.list_investigations() listed
   where listed.incident_id = current_setting('test.investigation_identified_incident')::uuid),
  'investigations page marks overdue records'
);
select extensions.ok(
  (select listed.no_team_assigned from public.list_investigations() listed
   where listed.incident_id = current_setting('test.investigation_unassigned_incident')::uuid),
  'administrator sees the no-team-assigned flag'
);

reset role;
select * from extensions.finish();
rollback;
