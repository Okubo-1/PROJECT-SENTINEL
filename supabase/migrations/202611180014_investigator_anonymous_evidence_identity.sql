create or replace function sentinel_private.guard_incident_evidence_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private, pg_temp
as $$
declare
  anonymous_report boolean;
  opaque_path boolean;
begin
  select incident.is_anonymous
    into strict anonymous_report
  from public.incidents incident
  where incident.id = new.incident_id
    and incident.organization_id = new.organization_id;

  opaque_path := new.storage_path ~ (
    '^' || new.organization_id::text || '/' || new.incident_id::text ||
    '/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
  );

  if anonymous_report then
    if new.uploaded_by is null then
      if new.original_filename <> 'Evidence' or not opaque_path then
        raise exception 'Anonymous reporter evidence must use an opaque path';
      end if;
    elsif new.uploaded_by is distinct from auth.uid()
      or not opaque_path
      or not sentinel_private.can_upload_investigation_evidence(
        new.organization_id, new.incident_id
      ) then
      raise exception 'Anonymous investigation evidence is unavailable' using errcode = '42501';
    end if;
  elsif new.uploaded_by is null then
    raise exception 'Evidence for identified reports requires an uploader';
  end if;

  return new;
end;
$$;

notify pgrst, 'reload schema';
