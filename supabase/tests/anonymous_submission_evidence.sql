begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  result jsonb;
  incident uuid;
  object_path text;
  evidence uuid := gen_random_uuid();
  identified_incident uuid := gen_random_uuid();
  identified_path text;
  row_json jsonb;
  gate_active boolean;
  input jsonb := jsonb_build_object(
    'reportType', 'incident', 'title', 'Anonymous incident',
    'occurredAt', '2026-01-01T10:00:00Z', 'department', 'Operations',
    'shift', 'Day', 'weatherConditions', 'Sunny', 'severity', 'Low',
    'incidentCategory', 'General', 'accuracyConfirmed', true,
    'digitalSignature', 'do not persist'
  );
begin
  select exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
    and conname = 'incidents_anonymous_release_gate') into gate_active;
  if has_schema_privilege('authenticated', 'sentinel_private', 'USAGE')
    or has_table_privilege('authenticated', 'sentinel_private.anonymous_reporter_links', 'SELECT')
    or not exists (select 1 from storage.buckets where id = 'anonymous-incident-evidence' and public = false) then
    raise exception 'Reporter links or evidence bucket are not private';
  end if;
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

  perform set_config('role', 'authenticated', true);
  if gate_active then
    begin
      perform public.submit_new_anonymous_incident(input, 'anonymous-submission-test');
      raise exception 'Anonymous submission bypassed the release gate';
    exception when check_violation then null;
    end;
  end if;
  perform set_config('role', 'postgres', true);
  if gate_active then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;
  perform set_config('role', 'authenticated', true);
  result := public.submit_new_anonymous_incident(input, 'anonymous-submission-test');
  incident := (result->>'id')::uuid;
  if result->>'confirmation' <> 'Anonymous reporter' or result->>'status' <> 'submitted'
    or result::text like '%' || reporter::text || '%'
    or (public.submit_new_anonymous_incident(input, 'anonymous-submission-test'))->>'id' <> incident::text then
    raise exception 'Anonymous submission response or retry is unsafe';
  end if;
  if exists (select 1 from public.incidents where id = incident
    and (reported_by is not null or created_by is not null or digital_signature is not null)) then
    raise exception 'Anonymous incident identity or private link is invalid';
  end if;
  perform set_config('role', 'postgres', true);
  if sentinel_private.anonymous_notification_recipient(incident) <> reporter then
    raise exception 'Private reporter link is invalid';
  end if;
  object_path := organization::text || '/' || incident::text || '/' || gen_random_uuid()::text;
  perform set_config('role', 'authenticated', true);
  begin
    insert into public.incident_evidence(id, organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by)
    values (evidence, organization, incident, object_path, 'Evidence', 'application/pdf', 1, null);
    raise exception 'Direct anonymous evidence metadata insertion was allowed';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);
  insert into storage.objects(bucket_id, name, owner, owner_id, user_metadata)
  values ('anonymous-incident-evidence', object_path, reporter, reporter::text, jsonb_build_object('name', reporter::text));
  perform set_config('role', 'service_role', true);
  select id into evidence from public.record_anonymous_evidence(incident, organization, object_path, 'application/pdf', 1);
  perform set_config('role', 'authenticated', true);
  begin
    insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by)
    values (organization, incident, organization::text || '/' || incident::text || '/' || gen_random_uuid()::text,
      'Evidence', 'application/pdf', 1, reporter);
    raise exception 'Anonymous uploader ID was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Anonymous evidence must use an opaque path without uploader identity' then raise; end if;
  end;
  begin
    insert into storage.objects(bucket_id, name, owner, owner_id)
    values ('incident-evidence', organization::text || '/' || incident::text || '/' || reporter::text || '/file.pdf', reporter, reporter::text);
    raise exception 'Identifying object path was accepted';
  exception when raise_exception then
    if sqlerrm <> 'Anonymous evidence must use an opaque path' then raise; end if;
  end;
  if exists (select 1 from storage.objects where bucket_id = 'anonymous-incident-evidence' and name = object_path) then
    raise exception 'Authenticated user can directly access anonymous storage';
  end if;
  perform set_config('role', 'postgres', true);
  select to_jsonb(o) into row_json from storage.objects o where bucket_id = 'anonymous-incident-evidence' and name = object_path;
  if row_json::text like '%' || reporter::text || '%'
    or row_json->>'owner' is not null or row_json->>'owner_id' is not null or row_json->>'user_metadata' is not null then
    raise exception 'Storage object exposes uploader identity';
  end if;
  perform set_config('role', 'authenticated', true);
  select to_jsonb(e) into row_json from public.incident_evidence e where id = evidence;
  if row_json::text like '%' || reporter::text || '%' or row_json->>'uploaded_by' is not null then
    raise exception 'Evidence exposes uploader identity';
  end if;
  select to_jsonb(i) into row_json from public.incidents i where id = incident;
  if row_json is null or row_json::text like '%' || reporter::text || '%'
    or row_json->>'reported_by' is not null or row_json->>'created_by' is not null
    or row_json->>'digital_signature' is not null then
    raise exception 'Authenticated incident response exposes reporter identity';
  end if;
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  if public.can_access_anonymous_evidence(organization, incident, false)
    or public.can_access_anonymous_evidence(organization, incident, true)
    or exists (select 1 from public.incident_evidence e where e.id = evidence)
    or exists (select 1 from storage.objects o where o.name = object_path) then
    raise exception 'Another user can access anonymous evidence (read %, write %, row %, object %)',
      public.can_access_anonymous_evidence(organization, incident, false),
      public.can_access_anonymous_evidence(organization, incident, true),
      exists (select 1 from public.incident_evidence e where e.id = evidence),
      exists (select 1 from storage.objects o where o.name = object_path);
  end if;
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  insert into public.incidents(id, organization_id, report_type, status, title, created_by, reported_by)
  values (identified_incident, organization, 'incident', 'draft', 'Identified incident', reporter, reporter);
  identified_path := organization::text || '/' || identified_incident::text || '/' || reporter::text || '/file.pdf';
  insert into storage.objects(bucket_id, name, owner, owner_id)
  values ('incident-evidence', identified_path, reporter, reporter::text);
  insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by)
  values (organization, identified_incident, identified_path, 'file.pdf', 'application/pdf', 1, reporter);
  if not exists (select 1 from storage.objects where name = identified_path and owner = reporter and owner_id = reporter::text)
    or not exists (select 1 from public.incident_evidence where incident_id = identified_incident and uploaded_by = reporter and original_filename = 'file.pdf') then
    raise exception 'Identified evidence behavior changed';
  end if;
  perform set_config('role', 'authenticated', true);
  if not exists (select 1 from storage.objects where name = identified_path and owner = reporter)
    or not exists (select 1 from public.incident_evidence where incident_id = identified_incident and uploaded_by = reporter) then
    raise exception 'Identified evidence is not accessible to its uploader';
  end if;
end;
$$;
rollback;
