begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare
  reporter uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  identified_incident uuid := gen_random_uuid();
  anonymous_incident uuid := gen_random_uuid();
  path text;
begin
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (reporter, 'authenticated', 'authenticated', reporter::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now());
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', reporter);

  insert into public.incidents(id, organization_id, reference_number, report_type, status, title, created_by, reported_by)
  values (identified_incident, organization, 'IDENTIFIED', 'incident', 'draft', 'Identified test', reporter, reporter);
  insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by)
  values (organization, identified_incident, 'test/identified-path', 'identified.pdf', 'application/pdf', 1, reporter);
  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    begin
      insert into public.incidents(id, organization_id, reference_number, report_type, status, title, is_anonymous)
      values (anonymous_incident, organization, 'ANONYMOUS', 'incident', 'draft', 'Anonymous test', true);
      raise exception 'The anonymous release gate allowed a submission';
    exception when check_violation then null;
    end;
  end if;
  begin
    insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size)
    values (organization, identified_incident, 'test/path', 'test.pdf', 'application/pdf', 1);
    raise exception 'Identified evidence accepted a missing uploader';
  exception when raise_exception then
    if sqlerrm <> 'Evidence for identified reports requires an uploader' then raise; end if;
  end;

  -- Exercise the future constraints only in this rolled-back transaction.
  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;
  insert into public.incidents(id, organization_id, reference_number, report_type, status, title, is_anonymous)
  values (anonymous_incident, organization, 'ANONYMOUS', 'incident', 'draft', 'Anonymous test', true);

  begin
    update public.incidents set digital_signature = 'identifying signature' where id = anonymous_incident;
    raise exception 'Anonymous signature accepted';
  exception when check_violation then
    null;
  end;
  begin
    update public.incidents set reported_by = reporter where id = anonymous_incident;
    raise exception 'Anonymous reporter ID accepted';
  exception when check_violation then
    null;
  end;
  begin
    update public.incidents set created_by = reporter where id = anonymous_incident;
    raise exception 'Anonymous creator ID accepted';
  exception when check_violation then
    null;
  end;
  begin
    update public.incidents set is_anonymous = true where id = identified_incident;
    raise exception 'Existing incident identity changed';
  exception when raise_exception then
    if sqlerrm <> 'An incident reporting identity cannot be changed after creation' then raise; end if;
  end;

  path := organization::text || '/' || anonymous_incident::text || '/' || gen_random_uuid()::text;
  insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size)
  values (organization, anonymous_incident, path, 'Evidence', 'application/pdf', 1);
  begin
    insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by)
    values (organization, anonymous_incident, organization::text || '/' || anonymous_incident::text || '/' || gen_random_uuid()::text, 'Evidence', 'application/pdf', 1, reporter);
    raise exception 'Anonymous evidence accepted an uploader';
  exception when raise_exception then
    if sqlerrm <> 'Anonymous evidence must use an opaque path without uploader identity' then raise; end if;
  end;
  begin
    insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size)
    values (organization, anonymous_incident, organization::text || '/' || anonymous_incident::text || '/' || gen_random_uuid()::text, 'personal-name.pdf', 'application/pdf', 1);
    raise exception 'Anonymous evidence accepted an identifying filename';
  exception when raise_exception then
    if sqlerrm <> 'Anonymous evidence must use an opaque path without uploader identity' then raise; end if;
  end;
  begin
    insert into public.incident_evidence(organization_id, incident_id, storage_path, original_filename, mime_type, file_size)
    values (organization, anonymous_incident, organization::text || '/' || anonymous_incident::text || '/' || reporter::text || '/file.pdf', 'Evidence', 'application/pdf', 1);
    raise exception 'Anonymous evidence accepted an identifying path';
  exception when raise_exception then
    if sqlerrm <> 'Anonymous evidence must use an opaque path without uploader identity' then raise; end if;
  end;
end;
$$;

rollback;
