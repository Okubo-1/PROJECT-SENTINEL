begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $$
declare
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  organization uuid := '6be4f137-4f64-4b69-b84c-7237ac0cbfa0';
  input jsonb := jsonb_build_object('reportType', 'incident', 'occurredAt', '2026-01-01T10:00:00Z',
    'department', 'Operations', 'shift', 'Day', 'weatherConditions', 'Sunny', 'severity', 'Low',
    'incidentCategory', 'General', 'accuracyConfirmed', true);
  draft jsonb;
begin
  if has_table_privilege('authenticated', 'sentinel_private.anonymous_test_accounts', 'SELECT')
    or has_table_privilege('service_role', 'sentinel_private.anonymous_test_accounts', 'INSERT') then
    raise exception 'Test allowlist is accessible to API roles';
  end if;
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[reporter, other_user]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values (organization, 'PRIVACY_TEST_ONLY', 'PRIVACY TEST ONLY', 'Testing', '1-10', 'Nigeria', 'Lagos', 'test@example.invalid', '12345678', reporter);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (reporter, organization, 'Test reporter', 'active'), (other_user, organization, 'Other test user', 'active');
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (reporter, organization, 'Super Administrator'), (other_user, organization, 'Field Worker');
  insert into public.company_settings(organization_id, departments, severity_levels, incident_categories, working_hours, weather_conditions)
  values (organization, '["Operations"]', '["Low"]', '["General"]', '{"shifts":["Day"]}', '["Sunny"]');
  if not exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    insert into sentinel_private.anonymous_test_accounts(user_id) values (reporter);
    perform set_config('role', 'authenticated', true);
    if coalesce(public.my_anonymous_test_access(), false)
      or public.anonymous_test_access(organization) then
      raise exception 'Test switch remains enabled after release';
    end if;
    return;
  end if;
  perform set_config('role', 'authenticated', true);
  if coalesce(public.my_anonymous_test_access(), false) then raise exception 'Unlisted user enabled'; end if;
  begin
    perform public.submit_new_anonymous_incident(input, 'before-allowlist');
    raise exception 'Unlisted user bypassed gate';
  exception when check_violation then null; end;
  perform set_config('role', 'postgres', true);
  insert into sentinel_private.anonymous_test_accounts(user_id) values (reporter);
  perform set_config('role', 'authenticated', true);
  if not public.my_anonymous_test_access()
    or public.anonymous_test_access(gen_random_uuid()) then raise exception 'Test gate scope incorrect'; end if;
  draft := public.save_my_anonymous_draft(null, input, 'allowed-test', public.anonymous_draft_owner_token());
  if (public.submit_my_anonymous_draft((draft->>'id')::uuid, input))->>'status' <> 'submitted' then
    raise exception 'Test draft did not submit';
  end if;
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  if coalesce(public.my_anonymous_test_access(), false) then raise exception 'Other account enabled'; end if;
  begin
    perform public.submit_new_anonymous_incident(input, 'other-test-user');
    raise exception 'Other account bypassed gate';
  exception when check_violation then null; end;
end;
$$;
rollback;
