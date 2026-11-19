-- The endpoint remains unavailable while anonymous reporting is release-gated.
create function public.submit_my_anonymous_draft(p_incident_id uuid, p_input jsonb)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare saved public.incidents;
begin
  if exists (
    select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate'
  ) then
    raise exception 'Anonymous reporting is not available';
  end if;
  saved := sentinel_private.submit_anonymous_incident(p_incident_id, p_input - 'digitalSignature');
  return jsonb_build_object(
    'id', saved.id, 'referenceNumber', saved.reference_number,
    'status', saved.status, 'confirmation', 'Anonymous reporter'
  );
end;
$$;
revoke all on function public.submit_my_anonymous_draft(uuid, jsonb) from public, anon, service_role;
grant execute on function public.submit_my_anonymous_draft(uuid, jsonb) to authenticated;
notify pgrst, 'reload schema';
