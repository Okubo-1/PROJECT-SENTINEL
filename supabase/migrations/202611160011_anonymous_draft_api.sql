-- These endpoints do not disable the anonymous incident release gate.
create function sentinel_private.anonymous_draft_owner_token()
returns text
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  key text;
  organization uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication is required' using errcode = '42501';
  end if;
  select p.organization_id into organization
  from public.profiles p
  join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
  where p.id = auth.uid() and p.account_status = 'active';
  if organization is null or not public.can_create_incident(organization)
    or not public.has_org_permission(organization, 'view_own_reports')
    or not public.safety_policy_access_allowed(organization) then
    raise exception 'Not authorized to create a draft' using errcode = '42501';
  end if;
  select decrypted_secret into strict key from vault.decrypted_secrets
    where name = 'anonymous_reporter_lookup_key';
  if key is null or length(key) < 32 then
    raise exception 'Anonymous reporter lookup key is invalid';
  end if;
  return encode(extensions.hmac('offline-draft:' || organization::text || ':' || auth.uid()::text, key, 'sha256'), 'hex');
end;
$$;
revoke all on function sentinel_private.anonymous_draft_owner_token() from public, anon, authenticated, service_role;

create function public.anonymous_draft_owner_token()
returns text language sql stable security definer set search_path = pg_catalog, pg_temp
as $$ select sentinel_private.anonymous_draft_owner_token() $$;
revoke all on function public.anonymous_draft_owner_token() from public, anon, service_role;
grant execute on function public.anonymous_draft_owner_token() to authenticated;

create function public.save_my_anonymous_draft(p_incident_id uuid, p_input jsonb, p_client_submission_id text, p_owner_token text)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
declare saved public.incidents;
begin
  if p_owner_token is null or p_owner_token <> sentinel_private.anonymous_draft_owner_token()
    or nullif(btrim(p_client_submission_id), '') is null or length(p_client_submission_id) > 128 then
    raise exception 'Draft is unavailable' using errcode = '42501';
  end if;
  saved := sentinel_private.save_anonymous_incident_draft(p_incident_id, p_input - 'digitalSignature', p_client_submission_id);
  if saved.status <> 'draft' then raise exception 'Draft is no longer editable'; end if;
  return to_jsonb(saved) - 'reported_by' - 'created_by' - 'digital_signature';
end;
$$;
revoke all on function public.save_my_anonymous_draft(uuid, jsonb, text, text) from public, anon, service_role;
grant execute on function public.save_my_anonymous_draft(uuid, jsonb, text, text) to authenticated;

create function public.get_my_anonymous_draft(p_incident_id uuid)
returns jsonb language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare saved public.incidents;
begin
  select i.* into saved from sentinel_private.my_anonymous_reports() i
    where i.id = p_incident_id and i.status = 'draft';
  if not found then raise exception 'Draft is unavailable' using errcode = '42501'; end if;
  return to_jsonb(saved) - 'reported_by' - 'created_by' - 'digital_signature';
end;
$$;
revoke all on function public.get_my_anonymous_draft(uuid) from public, anon, service_role;
grant execute on function public.get_my_anonymous_draft(uuid) to authenticated;
notify pgrst, 'reload schema';
