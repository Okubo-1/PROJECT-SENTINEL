begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  draft public.incidents;
  submitted public.incidents;
  input jsonb := jsonb_build_object(
    'reportType', 'incident', 'title', 'Anonymous incident',
    'occurredAt', '2026-11-01T10:00:00Z', 'department', 'Operations',
    'shift', 'Day', 'weatherConditions', 'Sunny', 'severity', 'Low',
    'incidentCategory', 'General', 'accuracyConfirmed', true,
    'digitalSignature', 'must not be stored'
  );
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(api_role, 'sentinel_private.submit_anonymous_incident(uuid,jsonb)', 'EXECUTE') then
      raise exception '% can directly invoke private submission', api_role;
    end if;
  end loop;
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[reporter, other_user]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', reporter);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (reporter, organization, 'Reporter', 'active'), (other_user, organization, 'Other', 'active');
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (reporter, organization, 'Super Administrator'), (other_user, organization, 'Field Worker');
  insert into public.company_settings(organization_id, departments, severity_levels, incident_categories, working_hours, weather_conditions)
  values (organization, '["Operations"]', '["Low"]', '["General"]', '{"shifts":["Day"]}', '["Sunny"]');

  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;
  draft := sentinel_private.save_anonymous_incident_draft(null, input, 'submit-test');
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  begin
    perform sentinel_private.submit_anonymous_incident(draft.id, input);
    raise exception 'Another user submitted the anonymous draft';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  begin
    perform sentinel_private.submit_anonymous_incident(draft.id, input - 'accuracyConfirmed');
    raise exception 'Unconfirmed incident was accepted';
  exception when raise_exception then
    if sqlerrm = 'Unconfirmed incident was accepted' then raise; end if;
  end;
  submitted := sentinel_private.submit_anonymous_incident(draft.id, input);
  if submitted.status <> 'submitted' or submitted.reported_by is not null or submitted.created_by is not null
    or submitted.digital_signature is not null or submitted.reported_at is null then
    raise exception 'Anonymous submission contains identity or has invalid status';
  end if;
  if sentinel_private.anonymous_notification_recipient(submitted.id) <> reporter then
    raise exception 'Private reporter link could not resolve the reporter';
  end if;
  if exists (select 1 from public.activity_logs where metadata->>'incident_id' = submitted.id::text) then
    raise exception 'Anonymous submission created an identifying activity';
  end if;
  if (sentinel_private.submit_anonymous_incident(draft.id, input)).id <> submitted.id then
    raise exception 'Submission retry did not return the same incident';
  end if;
end;
$$;
rollback;
