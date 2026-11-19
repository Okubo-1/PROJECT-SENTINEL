begin;
set local lock_timeout = '2s';
alter table public.incidents add constraint incidents_anonymous_release_gate
  check (not is_anonymous) not valid;
create or replace function public.submit_my_anonymous_draft(p_incident_id uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  raise exception 'Anonymous reporting is not available';
end;
$$;
delete from supabase_migrations.schema_migrations where version = '202611170003';
notify pgrst, 'reload schema';
commit;
