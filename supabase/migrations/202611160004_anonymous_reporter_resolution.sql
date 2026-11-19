-- These functions are private building blocks, not client APIs or notification senders.
-- The incident release gate remains in place until the complete workflow is deployed.
create function sentinel_private.my_anonymous_incident_ids()
returns setof uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  current_organization_id uuid;
  lookup_key text;
begin
  if current_user_id is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;

  select p.organization_id into current_organization_id
    from public.profiles p
    join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
    where p.id = current_user_id and p.account_status = 'active';
  if current_organization_id is null
    or not public.safety_policy_access_allowed(current_organization_id)
    or not public.has_org_permission(current_organization_id, 'view_own_reports') then
    raise exception 'Not authorized to view reports' using errcode = '42501';
  end if;

  select decrypted_secret into strict lookup_key
    from vault.decrypted_secrets where name = 'anonymous_reporter_lookup_key';
  if lookup_key is null or length(lookup_key) < 32 then
    raise exception 'Anonymous reporter lookup key is invalid';
  end if;

  return query
    select i.id
    from sentinel_private.anonymous_reporter_links l
    join public.incidents i on i.id = l.incident_id
    where l.reporter_hmac = extensions.hmac(current_user_id::text, lookup_key, 'sha256')
      and i.organization_id = current_organization_id
      and i.is_anonymous;
end;
$$;

create function sentinel_private.anonymous_notification_recipient(target_incident_id uuid)
returns uuid
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  encryption_key text;
  ciphertext bytea;
begin
  select l.encrypted_reporter into strict ciphertext
    from sentinel_private.anonymous_reporter_links l
    join public.incidents i on i.id = l.incident_id
    where i.id = target_incident_id and i.is_anonymous and i.status <> 'draft';
  select decrypted_secret into strict encryption_key
    from vault.decrypted_secrets where name = 'anonymous_reporter_encryption_key';
  if encryption_key is null or length(encryption_key) < 32 then
    raise exception 'Anonymous reporter encryption key is invalid';
  end if;
  return extensions.pgp_sym_decrypt(ciphertext, encryption_key)::uuid;
end;
$$;

revoke all on function sentinel_private.my_anonymous_incident_ids() from public, anon, authenticated, service_role;
revoke all on function sentinel_private.anonymous_notification_recipient(uuid) from public, anon, authenticated, service_role;
