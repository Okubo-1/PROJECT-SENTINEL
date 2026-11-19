begin;

do $$
declare
  api_role text;
  privilege_name text;
begin
  if not exists (
    select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'sentinel_private' and c.relname = 'anonymous_reporter_links'
      and c.relrowsecurity and c.relforcerowsecurity
  ) then
    raise exception 'Reporter links must have forced row-level security';
  end if;

  if exists (
    select 1 from pg_policies
    where schemaname = 'sentinel_private' and tablename = 'anonymous_reporter_links'
  ) then
    raise exception 'Reporter links must not have direct-access policies';
  end if;

  foreach api_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_schema_privilege(api_role, 'sentinel_private', 'USAGE') then
      raise exception '% can access the private schema', api_role;
    end if;
    foreach privilege_name in array array['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER'] loop
      if has_table_privilege(api_role, 'sentinel_private.anonymous_reporter_links', privilege_name) then
        raise exception '% has % on reporter links', api_role, privilege_name;
      end if;
    end loop;
    if has_function_privilege(api_role, 'sentinel_private.insert_anonymous_reporter_link(uuid,uuid)', 'EXECUTE') then
      raise exception '% can call the reporter-link writer', api_role;
    end if;
  end loop;

  if not exists (
    select 1 from pg_constraint c
    where c.conrelid = 'sentinel_private.anonymous_reporter_links'::regclass
      and c.confrelid = 'public.incidents'::regclass and c.contype = 'f'
  ) then
    raise exception 'Reporter links must reference an incident';
  end if;
end;
$$;

do $$
declare
  reporter uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  incident uuid := gen_random_uuid();
  second_incident uuid := gen_random_uuid();
  ciphertext bytea;
  digest bytea;
  second_ciphertext bytea;
  second_digest bytea;
  encryption_key text;
  lookup_key text;
begin
  if not exists (select 1 from vault.decrypted_secrets where name = 'anonymous_reporter_encryption_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'anonymous_reporter_encryption_key');
  end if;
  if not exists (select 1 from vault.decrypted_secrets where name = 'anonymous_reporter_lookup_key') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'anonymous_reporter_lookup_key');
  end if;
  select decrypted_secret into strict encryption_key from vault.decrypted_secrets where name = 'anonymous_reporter_encryption_key';
  select decrypted_secret into strict lookup_key from vault.decrypted_secrets where name = 'anonymous_reporter_lookup_key';

  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  values (reporter, 'authenticated', 'authenticated', reporter::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now());
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', reporter);
  insert into public.incidents(id, organization_id, reference_number, report_type, status, title, created_by, reported_by)
  values
    (incident, organization, 'PRIVACY-TEST', 'incident', 'draft', 'Privacy test', reporter, reporter),
    (second_incident, organization, 'PRIVACY-TEST-2', 'incident', 'draft', 'Privacy test', reporter, reporter);

  perform sentinel_private.insert_anonymous_reporter_link(incident, reporter);
  perform sentinel_private.insert_anonymous_reporter_link(second_incident, reporter);
  select encrypted_reporter, reporter_hmac into strict ciphertext, digest
    from sentinel_private.anonymous_reporter_links where incident_id = incident;
  select encrypted_reporter, reporter_hmac into strict second_ciphertext, second_digest
    from sentinel_private.anonymous_reporter_links where incident_id = second_incident;
  if extensions.pgp_sym_decrypt(ciphertext, encryption_key) <> reporter::text
    or digest <> extensions.hmac(reporter::text, lookup_key, 'sha256')
    or digest <> second_digest or ciphertext = second_ciphertext
    or position(convert_to(reporter::text, 'UTF8') in ciphertext) > 0 then
    raise exception 'Reporter encryption or lookup digest is invalid';
  end if;
end;
$$;

set local role authenticated;
do $$
begin
  begin
    perform * from sentinel_private.anonymous_reporter_links;
    raise exception 'Authenticated role unexpectedly read reporter links';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
reset role;

rollback;
