-- Internal owner-only reader; no API role can invoke it while the workflow
-- and the anonymous release gate remain incomplete.
create function sentinel_private.my_anonymous_reports()
returns setof public.incidents
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select i.*
  from public.incidents i
  join sentinel_private.my_anonymous_incident_ids() own(id) on own.id = i.id
  where i.is_anonymous
  order by i.created_at desc, i.id desc;
$$;

revoke all on function sentinel_private.my_anonymous_reports()
  from public, anon, authenticated, service_role;
