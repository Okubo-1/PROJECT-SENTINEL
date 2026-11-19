begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  other_organization uuid := gen_random_uuid();
  site uuid := gen_random_uuid();
  incident uuid := gen_random_uuid();
  other_incident uuid := gen_random_uuid();
  foreign_incident uuid := gen_random_uuid();
  caller_role text;
  results uuid[];
begin
  foreach caller_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(caller_role, 'sentinel_private.my_anonymous_incident_ids()', 'EXECUTE')
      or has_function_privilege(caller_role, 'sentinel_private.anonymous_notification_recipient(uuid)', 'EXECUTE') then
      raise exception '% can directly invoke a private reporter resolver', caller_role;
    end if;
  end loop;

  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[reporter, other_user]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values
    (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', reporter),
    (other_organization, 'PRIVACY_' || upper(replace(other_organization::text, '-', '')), 'Privacy Test 2', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', reporter);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (reporter, organization, 'Reporter', 'active'), (other_user, organization, 'Other', 'active');
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (reporter, organization, 'Super Administrator'), (other_user, organization, 'Field Worker');
  insert into public.company_settings(organization_id, operational_sites, severity_levels, incident_categories, working_hours, weather_conditions)
  values (organization, '["Test Site"]', '["Low"]', '["Test"]', '{"shifts":[{"name":"Day","active":true}]}', '["Sunny"]');
  insert into public.sites(id, organization_id, name) values (site, organization, 'Test Site');

  -- The release gate is removed only inside this rolled-back test transaction.
  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;
  insert into public.incidents(id, organization_id, reference_number, report_type, status, title, is_anonymous, site_id, severity, incident_category, weather_conditions, shift)
  values
    (incident, organization, 'PRIVACY-ONE', 'incident', 'submitted', 'Test', true, site, 'Low', 'Test', 'Sunny', 'Day'),
    (other_incident, organization, 'PRIVACY-TWO', 'incident', 'draft', 'Test', true, null, null, null, null, null),
    (foreign_incident, other_organization, 'PRIVACY-THREE', 'incident', 'draft', 'Test', true, null, null, null, null, null);
  perform sentinel_private.insert_anonymous_reporter_link(incident, reporter);
  perform sentinel_private.insert_anonymous_reporter_link(other_incident, other_user);
  perform sentinel_private.insert_anonymous_reporter_link(foreign_incident, reporter);

  perform set_config('request.jwt.claim.sub', reporter::text, true);
  select array_agg(id) into results from sentinel_private.my_anonymous_incident_ids() as id;
  if results is distinct from array[incident] then
    raise exception 'Reporter did not receive exactly their own anonymous report';
  end if;
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  select array_agg(id) into results from sentinel_private.my_anonymous_incident_ids() as id;
  if results is distinct from array[other_incident] then
    raise exception 'Other user did not receive exactly their own anonymous report';
  end if;
  if sentinel_private.anonymous_notification_recipient(incident) <> reporter then
    raise exception 'Notification recipient was not resolved correctly';
  end if;
  begin
    perform sentinel_private.anonymous_notification_recipient(other_incident);
    raise exception 'Draft recipient was exposed to notification sender';
  exception when no_data_found then
    null;
  end;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform * from sentinel_private.my_anonymous_incident_ids();
    raise exception 'Unauthenticated report lookup succeeded';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;

rollback;
