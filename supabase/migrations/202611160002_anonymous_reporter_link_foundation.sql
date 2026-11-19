-- This schema is not exposed by PostgREST. Anonymous reporting remains disabled
-- until the submission, evidence, notification and ownership flows are integrated.
create schema sentinel_private;
revoke all on schema sentinel_private from public, anon, authenticated, service_role;

create table sentinel_private.anonymous_reporter_links (
  incident_id uuid primary key references public.incidents(id) on delete cascade,
  encrypted_reporter bytea not null check (octet_length(encrypted_reporter) > 0),
  reporter_hmac bytea not null check (octet_length(reporter_hmac) = 32)
);

create index anonymous_reporter_links_hmac_idx
  on sentinel_private.anonymous_reporter_links (reporter_hmac);

revoke all on sentinel_private.anonymous_reporter_links from public, anon, authenticated, service_role;
alter table sentinel_private.anonymous_reporter_links enable row level security;
alter table sentinel_private.anonymous_reporter_links force row level security;

do $$
declare
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
  if encryption_key is null or lookup_key is null
    or length(encryption_key) < 32 or length(lookup_key) < 32 or encryption_key = lookup_key then
    raise exception 'Anonymous reporter keys are invalid';
  end if;
end;
$$;

create function sentinel_private.insert_anonymous_reporter_link(
  target_incident_id uuid,
  reporter_id uuid
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  encryption_key text;
  lookup_key text;
begin
  if reporter_id is null or not exists (select 1 from auth.users where id = reporter_id) then
    raise exception 'A valid reporter is required';
  end if;

  select decrypted_secret into strict encryption_key
    from vault.decrypted_secrets where name = 'anonymous_reporter_encryption_key';
  select decrypted_secret into strict lookup_key
    from vault.decrypted_secrets where name = 'anonymous_reporter_lookup_key';
  if encryption_key is null or lookup_key is null
    or length(encryption_key) < 32 or length(lookup_key) < 32 or encryption_key = lookup_key then
    raise exception 'Anonymous reporter keys are invalid';
  end if;

  insert into sentinel_private.anonymous_reporter_links (incident_id, encrypted_reporter, reporter_hmac)
  values (
    target_incident_id,
    extensions.pgp_sym_encrypt(reporter_id::text, encryption_key, 'cipher-algo=aes256'),
    extensions.hmac(reporter_id::text, lookup_key, 'sha256')
  );
end;
$$;
revoke all on function sentinel_private.insert_anonymous_reporter_link(uuid, uuid)
  from public, anon, authenticated, service_role;
