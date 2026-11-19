begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $$
declare
  admin_user uuid := gen_random_uuid();
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  foreign_admin uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  foreign_organization uuid := gen_random_uuid();
  owned public.incidents;
  other_report public.incidents;
  foreign_report public.incidents;
  identified_draft uuid := gen_random_uuid();
  identified_report uuid := gen_random_uuid();
  investigation_id uuid := gen_random_uuid();
  role_name text;
  input jsonb := jsonb_build_object(
    'reportType', 'incident', 'title', 'Anonymous incident',
    'occurredAt', '2026-01-01T10:00:00Z', 'department', 'Operations',
    'shift', 'Day', 'weatherConditions', 'Sunny', 'severity', 'Low',
    'incidentCategory', 'General', 'accuracyConfirmed', true
  );
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_table_privilege(role_name, 'sentinel_private.reporter_notifications', 'SELECT') then
      raise exception '% can read the private notification table', role_name;
    end if;
  end loop;
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[admin_user, reporter, other_user, foreign_admin]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values
    (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', admin_user),
    (foreign_organization, 'PRIVACY_' || upper(replace(foreign_organization::text, '-', '')), 'Privacy Test 2', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', foreign_admin);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (admin_user, organization, 'Admin', 'active'), (reporter, organization, 'Reporter', 'active'),
    (other_user, organization, 'Other', 'active'), (foreign_admin, foreign_organization, 'Foreign admin', 'active');
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (admin_user, organization, 'Super Administrator'), (reporter, organization, 'Field Worker'),
    (other_user, organization, 'Field Worker');
  perform set_config('request.jwt.claim.sub', foreign_admin::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (foreign_admin, foreign_organization, 'Super Administrator');
  insert into public.company_settings(organization_id, departments, severity_levels, incident_categories, working_hours, weather_conditions)
  values (organization, '["Operations"]', '["Low"]', '["General"]', '{"shifts":["Day"]}', '["Sunny"]'),
    (foreign_organization, '["Operations"]', '["Low"]', '["General"]', '{"shifts":["Day"]}', '["Sunny"]');
  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;

  perform set_config('request.jwt.claim.sub', reporter::text, true);
  owned := sentinel_private.save_anonymous_incident_draft(null, input, 'my-reports-owned');
  perform sentinel_private.submit_anonymous_incident(owned.id, input);
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  other_report := sentinel_private.save_anonymous_incident_draft(null, input, 'my-reports-other');
  perform sentinel_private.submit_anonymous_incident(other_report.id, input);
  perform set_config('request.jwt.claim.sub', foreign_admin::text, true);
  foreign_report := sentinel_private.save_anonymous_incident_draft(null, input, 'my-reports-foreign');
  perform sentinel_private.submit_anonymous_incident(foreign_report.id, input);
  insert into public.incidents(id, organization_id, reference_number, report_type, status, title, created_by, reported_by)
  values (identified_draft, organization, 'IDENTIFIED-DRAFT', 'incident', 'draft', 'Identified draft', reporter, reporter);
  insert into public.incidents(id, organization_id, reference_number, report_type, status, title, created_by, reported_by, department, severity, incident_category, shift, weather_conditions)
  values (identified_report, organization, 'IDENTIFIED-REPORT', 'incident', 'submitted', 'Identified report', admin_user, reporter, 'Operations', 'Low', 'General', 'Day', 'Sunny');
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  insert into public.investigations(id, organization_id, incident_id, status, assigned_investigator_id, assigned_by, assigned_at, created_by)
  values (investigation_id, organization, owned.id, 'assigned', admin_user, admin_user, now(), admin_user);
  update public.investigations set status = 'in_progress' where id = investigation_id;
  update public.investigations set status = 'pending_review' where id = investigation_id;
  update public.investigations set status = 'completed' where id = investigation_id;
  perform public.close_incident(owned.id, 'Test root cause', 'Test corrective action', true);
  insert into sentinel_private.reporter_notifications(incident_id, status)
  values (identified_report, 'closed'), (other_report.id, 'closed'), (foreign_report.id, 'closed');

  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  if (select count(*) from public.get_my_incidents()) <> 3
    or not exists (select 1 from public.get_my_incidents() where id = owned.id)
    or not exists (select 1 from public.get_my_incidents() where id = identified_draft and created_by = reporter and reported_by = reporter)
    or not exists (select 1 from public.get_my_incidents() where id = identified_report and created_by = admin_user and reported_by = reporter)
    or exists (select 1 from public.get_my_incidents() where is_anonymous and (created_by is not null or reported_by is not null)) then
    raise exception 'Own reports failed isolation or exposed identity';
  end if;
  if (select count(*) from public.get_my_report_notifications()) <> 4
    or exists (select 1 from public.get_my_report_notifications() n where n.incident_id not in (owned.id, identified_report))
    or (select count(distinct status) from public.get_my_report_notifications()) <> 3
    or exists (select 1 from public.get_my_report_notifications() n
      where (select count(*) from jsonb_object_keys(to_jsonb(n))) <> 2
        or to_jsonb(n)::text like '%' || reporter::text || '%') then
    raise exception 'Notification response failed isolation or content check';
  end if;
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  if exists (select 1 from public.get_my_incidents() where id = owned.id)
    or exists (select 1 from public.get_my_report_notifications() where incident_id = owned.id)
    or exists (select 1 from public.incidents where id = identified_draft) then
    raise exception 'Another user accessed the report or notifications';
  end if;
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  if exists (select 1 from public.get_my_incidents() where id = owned.id)
    or exists (select 1 from public.get_my_report_notifications() where incident_id = owned.id)
    or exists (select 1 from public.incidents where id = identified_draft) then
    raise exception 'Organization admin accessed another user''s own reports or notifications';
  end if;
  if not exists (select 1 from public.incidents where id = owned.id and status = 'closed'
      and is_anonymous and created_by is null and reported_by is null and digital_signature is null)
    or exists (select 1 from public.incidents i where i.id = owned.id
      and to_jsonb(i)::text like '%' || reporter::text || '%') then
    raise exception 'Admin incident access failed or exposed the anonymous reporter';
  end if;
  if exists (select 1 from public.incidents i
    left join public.profiles reporter_profile on reporter_profile.id = i.reported_by
    left join public.profiles creator_profile on creator_profile.id = i.created_by
    where i.id = owned.id and (reporter_profile.id is not null or creator_profile.id is not null)) then
    raise exception 'Nested reporter or creator profile exposed anonymous identity';
  end if;
  if exists (select 1 from public.activity_logs a where a.organization_id = organization
      and a.metadata->>'incident_id' = owned.id::text and to_jsonb(a)::text like '%' || reporter::text || '%') then
    raise exception 'Anonymous reporter appeared in incident activity';
  end if;
  perform set_config('request.jwt.claim.sub', foreign_admin::text, true);
  if exists (select 1 from public.get_my_incidents() where id in (owned.id, other_report.id))
    or exists (select 1 from public.get_my_report_notifications() where incident_id in (owned.id, other_report.id)) then
    raise exception 'Cross-organization access';
  end if;
end;
$$;
rollback;
