begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $$
declare
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  draft jsonb;
  result jsonb;
  input jsonb := jsonb_build_object(
    'reportType', 'incident', 'title', 'Anonymous incident',
    'occurredAt', '2026-01-01T10:00:00Z', 'department', 'Operations',
    'shift', 'Day', 'weatherConditions', 'Sunny', 'severity', 'Low',
    'incidentCategory', 'General', 'accuracyConfirmed', true, 'digitalSignature', 'private signature'
  );
begin
  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    raise exception 'Anonymous release gate is still active';
  end if;
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.invalid', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[reporter, other_user]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values (organization, 'RELEASE_' || upper(replace(organization::text, '-', '')), 'Release Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'release@example.invalid', '12345678', reporter);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (reporter, organization, 'Reporter', 'active'), (other_user, organization, 'Other', 'active');
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (reporter, organization, 'Super Administrator'), (other_user, organization, 'Field Worker');
  insert into public.company_settings(organization_id, departments, severity_levels, incident_categories, working_hours, weather_conditions)
  values (organization, '["Operations"]', '["Low"]', '["General"]', '{"shifts":["Day"]}', '["Sunny"]');
  perform set_config('role', 'authenticated', true);
  if public.anonymous_test_access(organization) then raise exception 'Test switch remains enabled'; end if;
  draft := public.save_my_anonymous_draft(null, input, 'release-test', public.anonymous_draft_owner_token());
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  begin
    perform public.submit_my_anonymous_draft((draft->>'id')::uuid, input);
    raise exception 'Another user submitted the draft';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  result := public.submit_my_anonymous_draft((draft->>'id')::uuid, input);
  if result->>'status' <> 'submitted' or result->>'confirmation' <> 'Anonymous reporter'
    or result::text like '%' || reporter::text || '%' or result::text like '%private signature%' then
    raise exception 'Anonymous submission response is invalid';
  end if;
  if public.submit_my_anonymous_draft((draft->>'id')::uuid, input)->>'id' <> draft->>'id' then
    raise exception 'Submission retry created a duplicate';
  end if;
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.incidents where id = (draft->>'id')::uuid
      and (created_by is not null or reported_by is not null or digital_signature is not null or status <> 'submitted')) then
    raise exception 'Anonymous submission stored identity';
  end if;
end;
$$;
rollback;
