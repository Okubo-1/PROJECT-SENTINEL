-- Deploy together with the authorized anonymous evidence upload and download endpoints.
-- The existing incident-evidence bucket and Actions policies are not changed.
insert into storage.buckets (id, name, public)
values ('anonymous-incident-evidence', 'anonymous-incident-evidence', false);

-- Restrictive policies also protect this bucket from unrelated permissive policies.
create policy anonymous_evidence_bucket_deny_select on storage.objects
as restrictive for select to anon, authenticated
using (bucket_id <> 'anonymous-incident-evidence');

create policy anonymous_evidence_bucket_deny_insert on storage.objects
as restrictive for insert to anon, authenticated
with check (bucket_id <> 'anonymous-incident-evidence');

create policy anonymous_evidence_bucket_deny_update on storage.objects
as restrictive for update to anon, authenticated
using (bucket_id <> 'anonymous-incident-evidence')
with check (bucket_id <> 'anonymous-incident-evidence');

create policy anonymous_evidence_bucket_deny_delete on storage.objects
as restrictive for delete to anon, authenticated
using (bucket_id <> 'anonymous-incident-evidence');

-- Only the service endpoint can create or remove anonymous evidence metadata.
create policy anonymous_evidence_metadata_server_insert on public.incident_evidence
as restrictive for insert to authenticated with check (uploaded_by is not null);
create policy anonymous_evidence_metadata_server_delete on public.incident_evidence
as restrictive for delete to authenticated using (uploaded_by is not null);

create function sentinel_private.guard_anonymous_bucket_object()
returns trigger language plpgsql security definer
set search_path = pg_catalog, pg_temp as $$
begin
  if new.bucket_id = 'anonymous-incident-evidence' then
    if new.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
      raise exception 'Invalid anonymous evidence path';
    end if;
    new.owner := null;
    new.owner_id := null;
    new.user_metadata := null;
  end if;
  return new;
end;
$$;
revoke all on function sentinel_private.guard_anonymous_bucket_object() from public, anon, authenticated, service_role;
create trigger anonymous_bucket_object_guard before insert or update on storage.objects
for each row execute function sentinel_private.guard_anonymous_bucket_object();

-- Serialize the per-incident quota check with metadata creation.
create function public.record_anonymous_evidence(
  target_incident_id uuid, target_organization_id uuid, object_path text,
  object_type text, object_size bigint
) returns public.incident_evidence
language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare saved public.incident_evidence; current_size bigint;
begin
  perform 1 from public.incidents
    where id = target_incident_id and organization_id = target_organization_id and is_anonymous
    for update;
  if not found then raise exception 'Incident unavailable'; end if;
  select coalesce(sum(file_size), 0) into current_size
    from public.incident_evidence where incident_id = target_incident_id and organization_id = target_organization_id;
  if object_size <= 0 or current_size + object_size > 250 * 1024 * 1024 then
    raise exception 'Evidence exceeds the incident attachment limit';
  end if;
  insert into public.incident_evidence (organization_id, incident_id, storage_path, original_filename, mime_type, file_size, uploaded_by)
  values (target_organization_id, target_incident_id, object_path, 'Evidence', object_type, object_size, null)
  returning * into saved;
  return saved;
end;
$$;
revoke all on function public.record_anonymous_evidence(uuid, uuid, text, text, bigint) from public, anon, authenticated;
grant execute on function public.record_anonymous_evidence(uuid, uuid, text, text, bigint) to service_role;
notify pgrst, 'reload schema';
