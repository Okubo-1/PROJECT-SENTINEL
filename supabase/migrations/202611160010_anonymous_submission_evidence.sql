-- Anonymous reporting remains blocked by incidents_anonymous_release_gate.
create function public.submit_new_anonymous_incident(p_input jsonb, p_client_submission_id text)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  saved public.incidents;
begin
  if nullif(btrim(p_client_submission_id), '') is null
    or length(p_client_submission_id) > 128 then
    raise exception 'A valid submission identifier is required';
  end if;
  saved := sentinel_private.save_anonymous_incident_draft(null, p_input, p_client_submission_id);
  saved := sentinel_private.submit_anonymous_incident(saved.id, p_input);
  return jsonb_build_object(
    'id', saved.id, 'referenceNumber', saved.reference_number,
    'status', saved.status, 'confirmation', 'Anonymous reporter'
  );
end;
$$;
revoke all on function public.submit_new_anonymous_incident(jsonb, text) from public, anon, service_role;
grant execute on function public.submit_new_anonymous_incident(jsonb, text) to authenticated;

-- This returns authorization only, never the linked reporter reference.
create function public.can_access_anonymous_evidence(target_organization_id uuid, target_incident_id uuid, for_upload boolean)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  incident_status public.incident_status;
begin
  if auth.uid() is null or not public.safety_policy_access_allowed(target_organization_id)
    then
    return false;
  end if;
  select i.status into incident_status from public.incidents i
    where i.id = target_incident_id and i.organization_id = target_organization_id and i.is_anonymous;
  if incident_status is null then return false; end if;
  if incident_status <> 'draft' and (
    (for_upload and public.can_manage_incident(target_organization_id, target_incident_id))
    or (not for_upload and public.can_view_incident(target_organization_id, target_incident_id))
  ) then
    return true;
  end if;
  if not public.has_org_permission(target_organization_id, 'view_own_reports') then
    return false;
  end if;
  return exists (select 1 from sentinel_private.my_anonymous_incident_ids() own(id) where own.id = target_incident_id);
end;
$$;
revoke all on function public.can_access_anonymous_evidence(uuid, uuid, boolean) from public, anon, service_role;
grant execute on function public.can_access_anonymous_evidence(uuid, uuid, boolean) to authenticated;

create function public.anonymous_evidence_context(target_incident_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  organization uuid;
begin
  select i.organization_id into organization from public.incidents i
  where i.id = target_incident_id and i.is_anonymous;
  if organization is null or not public.can_access_anonymous_evidence(organization, target_incident_id, true) then
    raise exception 'Incident unavailable' using errcode = '42501';
  end if;
  return jsonb_build_object('organizationId', organization);
end;
$$;
revoke all on function public.anonymous_evidence_context(uuid) from public, anon, service_role;
grant execute on function public.anonymous_evidence_context(uuid) to authenticated;

create policy anonymous_evidence_select on public.incident_evidence
for select to authenticated using (public.can_access_anonymous_evidence(organization_id, incident_id, false));
create policy anonymous_evidence_insert on public.incident_evidence
for insert to authenticated with check (
  uploaded_by is null and public.can_access_anonymous_evidence(organization_id, incident_id, true)
);
create policy anonymous_evidence_delete on public.incident_evidence
for delete to authenticated using (public.can_access_anonymous_evidence(organization_id, incident_id, true));

-- Supabase Storage otherwise records the JWT subject as the object owner.
create function sentinel_private.guard_anonymous_storage_object()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  org_text text := split_part(new.name, '/', 1);
  incident_text text := split_part(new.name, '/', 2);
begin
  if new.bucket_id <> 'incident-evidence'
    or org_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or incident_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return new;
  end if;
  if exists (select 1 from public.incidents i
    where i.id = incident_text::uuid and i.organization_id = org_text::uuid and i.is_anonymous) then
    if new.name !~ ('^' || org_text || '/' || incident_text ||
      '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$') then
      raise exception 'Anonymous evidence must use an opaque path';
    end if;
    new.owner := null;
    new.owner_id := null;
    new.user_metadata := null;
  end if;
  return new;
end;
$$;
revoke all on function sentinel_private.guard_anonymous_storage_object() from public, anon, authenticated, service_role;
create trigger anonymous_evidence_storage_guard
before insert or update on storage.objects
for each row execute function sentinel_private.guard_anonymous_storage_object();

create function public.anonymous_storage_read_allowed(object_path text)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  org_text text := split_part(object_path, '/', 1);
  incident_text text := split_part(object_path, '/', 2);
begin
  if org_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or incident_text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return true;
  end if;
  if not exists (select 1 from public.incidents i
    where i.id = incident_text::uuid and i.organization_id = org_text::uuid and i.is_anonymous) then
    return true;
  end if;
  return public.can_access_anonymous_evidence(org_text::uuid, incident_text::uuid, false);
end;
$$;
revoke all on function public.anonymous_storage_read_allowed(text) from public, anon, service_role;
grant execute on function public.anonymous_storage_read_allowed(text) to authenticated;

-- A separate investigation policy permits organization-wide bucket reads.
-- Restrict anonymous incident objects even when another permissive policy matches.
create policy anonymous_evidence_storage_read_guard on storage.objects
as restrictive for select to authenticated using (
  bucket_id <> 'incident-evidence' or public.anonymous_storage_read_allowed(name)
);

create policy anonymous_evidence_storage_insert on storage.objects
for insert to authenticated with check (
  bucket_id = 'incident-evidence'
  and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then public.can_access_anonymous_evidence(split_part(name, '/', 1)::uuid, split_part(name, '/', 2)::uuid, true) else false end
);
create policy anonymous_evidence_storage_select on storage.objects
for select to authenticated using (
  bucket_id = 'incident-evidence'
  and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then public.can_access_anonymous_evidence(split_part(name, '/', 1)::uuid, split_part(name, '/', 2)::uuid, false) else false end
);
create policy anonymous_evidence_storage_delete on storage.objects
for delete to authenticated using (
  bucket_id = 'incident-evidence'
  and case when name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
    then public.can_access_anonymous_evidence(split_part(name, '/', 1)::uuid, split_part(name, '/', 2)::uuid, true) else false end
);
notify pgrst, 'reload schema';
