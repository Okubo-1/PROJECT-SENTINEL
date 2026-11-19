-- Remove the isolated test organization and its incidents before running this rollback.
begin;
set local lock_timeout = '2s';
alter table public.incidents drop constraint incidents_anonymous_release_gate;
alter table public.incidents add constraint incidents_anonymous_release_gate check (not is_anonymous);
create or replace function public.submit_my_anonymous_draft(p_incident_id uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare saved public.incidents;
begin
  if exists (select 1 from pg_catalog.pg_constraint
    where conrelid = 'public.incidents'::regclass and conname = 'incidents_anonymous_release_gate') then
    raise exception 'Anonymous reporting is not available';
  end if;
  saved := sentinel_private.submit_anonymous_incident(p_incident_id, p_input - 'digitalSignature');
  return jsonb_build_object('id', saved.id, 'referenceNumber', saved.reference_number,
    'status', saved.status, 'confirmation', 'Anonymous reporter');
end;
$$;
drop function public.my_anonymous_test_access();
drop function public.anonymous_test_access(uuid);
drop table sentinel_private.anonymous_test_accounts;
delete from supabase_migrations.schema_migrations where version = '202611170002';
notify pgrst, 'reload schema';
commit;
