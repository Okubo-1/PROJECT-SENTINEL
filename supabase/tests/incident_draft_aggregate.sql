begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare
  admin_user uuid := gen_random_uuid();
  worker uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  other_organization uuid := gen_random_uuid();
  anonymous_draft public.incidents;
begin
  if has_function_privilege('anon', 'public.get_incident_draft_total()', 'EXECUTE') then
    raise exception 'Unauthenticated API can query draft totals';
  end if;
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[admin_user, worker]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values
    (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', admin_user),
    (other_organization, 'PRIVACY_' || upper(replace(other_organization::text, '-', '')), 'Privacy Test 2', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', admin_user);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (admin_user, organization, 'Admin', 'active'), (worker, organization, 'Worker', 'active');
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (admin_user, organization, 'Super Administrator'), (worker, organization, 'Field Worker');
  insert into public.company_settings(organization_id, departments, severity_levels, incident_categories, working_hours, weather_conditions)
  values (organization, '["Operations"]', '["Low"]', '["General"]', '{"shifts":["Day"]}', '["Sunny"]');
  insert into public.incidents(organization_id, reference_number, report_type, status, title, created_by, reported_by)
  values
    (organization, 'PRIVACY-ONE', 'incident', 'draft', 'Draft one', admin_user, admin_user),
    (organization, 'PRIVACY-TWO', 'incident', 'draft', 'Draft two', worker, worker),
    (other_organization, 'PRIVACY-FOREIGN', 'incident', 'draft', 'Foreign draft', admin_user, admin_user);
  if public.get_incident_draft_total() <> 2 then
    raise exception 'Draft count did not aggregate the current organization';
  end if;
  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;
  anonymous_draft := sentinel_private.save_anonymous_incident_draft(
    null, '{"reportType":"incident","title":"Anonymous draft"}'::jsonb, 'aggregate-private-test'
  );
  if public.get_incident_draft_total() <> 3 then
    raise exception 'Count excludes a private anonymous draft';
  end if;
  delete from public.incidents where id = anonymous_draft.id;
  if public.get_incident_draft_total() <> 2 then
    raise exception 'Count includes a deleted draft';
  end if;
  update public.incidents set status = 'submitted', department = 'Operations', severity = 'Low',
    incident_category = 'General', shift = 'Day', weather_conditions = 'Sunny'
  where reference_number = 'PRIVACY-ONE' and organization_id = organization;
  if public.get_incident_draft_total() <> 1 then
    raise exception 'Count includes a draft after submission';
  end if;
  perform set_config('request.jwt.claim.sub', worker::text, true);
  begin
    perform public.get_incident_draft_total();
    raise exception 'Worker without Executive Analytics permission received draft count';
  exception when insufficient_privilege then
    null;
  end;
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  update public.profiles set account_status = 'suspended' where id = worker;
  perform set_config('request.jwt.claim.sub', worker::text, true);
  begin
    perform public.get_incident_draft_total();
    raise exception 'Unauthorized worker received draft count';
  exception when insufficient_privilege then
    null;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform public.get_incident_draft_total();
    raise exception 'Unauthenticated caller received draft count';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
rollback;
