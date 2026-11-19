-- Anonymous records remain unavailable until their complete submission, evidence,
-- notification, access and audit paths have been deployed and verified.
alter table public.incidents
  add column is_anonymous boolean not null default false,
  alter column reported_by drop not null,
  alter column created_by drop not null,
  add constraint incidents_reporter_identity_check check (
    (not is_anonymous and reported_by is not null and created_by is not null)
    or (is_anonymous and reported_by is null and created_by is null and digital_signature is null)
  ),
  add constraint incidents_anonymous_release_gate check (not is_anonymous);

alter table public.incident_evidence
  alter column uploaded_by drop not null;

create function sentinel_private.guard_anonymous_incident_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.is_anonymous is distinct from old.is_anonymous then
    raise exception 'An incident reporting identity cannot be changed after creation';
  end if;
  return new;
end;
$$;

create trigger incidents_guard_anonymous_identity
before update of is_anonymous on public.incidents
for each row execute function sentinel_private.guard_anonymous_incident_identity();

create function sentinel_private.guard_incident_evidence_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  anonymous_report boolean;
begin
  select i.is_anonymous into strict anonymous_report
    from public.incidents i
    where i.id = new.incident_id and i.organization_id = new.organization_id;

  if anonymous_report then
    if new.uploaded_by is not null
      or new.original_filename <> 'Evidence'
      or new.storage_path !~ (
        '^' || new.organization_id::text || '/' || new.incident_id::text ||
        '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
      ) then
      raise exception 'Anonymous evidence must use an opaque path without uploader identity';
    end if;
  elsif new.uploaded_by is null then
    raise exception 'Evidence for identified reports requires an uploader';
  end if;
  return new;
end;
$$;

create trigger incident_evidence_guard_identity
before insert or update of incident_id, organization_id, uploaded_by, storage_path, original_filename
on public.incident_evidence
for each row execute function sentinel_private.guard_incident_evidence_identity();

revoke all on function sentinel_private.guard_anonymous_incident_identity() from public, anon, authenticated, service_role;
revoke all on function sentinel_private.guard_incident_evidence_identity() from public, anon, authenticated, service_role;
notify pgrst, 'reload schema';
