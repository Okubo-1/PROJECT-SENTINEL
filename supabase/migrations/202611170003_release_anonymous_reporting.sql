-- The test allowlist must be empty before enabling anonymous reporting.
do $$
begin
  if exists (select 1 from sentinel_private.anonymous_test_accounts) then
    raise exception 'Remove test accounts before releasing anonymous reporting';
  end if;
end;
$$;

alter table public.incidents drop constraint incidents_anonymous_release_gate;

create or replace function public.anonymous_test_access(target_organization_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select false;
$$;

create or replace function public.submit_my_anonymous_draft(p_incident_id uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare saved public.incidents;
begin
  saved := sentinel_private.submit_anonymous_incident(p_incident_id, p_input - 'digitalSignature');
  return jsonb_build_object(
    'id', saved.id, 'referenceNumber', saved.reference_number,
    'status', saved.status, 'confirmation', 'Anonymous reporter'
  );
end;
$$;
notify pgrst, 'reload schema';
