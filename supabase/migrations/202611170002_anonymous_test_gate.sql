-- Temporary, isolated test exception. Remove after the privacy test campaign.
-- This identifier must never be assigned to a real organization.
create table sentinel_private.anonymous_test_accounts (
  user_id uuid primary key references auth.users(id) on delete cascade
);
alter table sentinel_private.anonymous_test_accounts enable row level security;
alter table sentinel_private.anonymous_test_accounts force row level security;
revoke all on sentinel_private.anonymous_test_accounts from public, anon, authenticated, service_role;

create function public.anonymous_test_access(target_organization_id uuid)
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select target_organization_id = '6be4f137-4f64-4b69-b84c-7237ac0cbfa0'::uuid
    and exists (
      select 1 from sentinel_private.anonymous_test_accounts t
      join public.profiles p on p.id = t.user_id
      join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
      where t.user_id = auth.uid() and p.account_status = 'active'
        and p.organization_id = target_organization_id
    );
$$;
revoke all on function public.anonymous_test_access(uuid) from public, anon, service_role;
grant execute on function public.anonymous_test_access(uuid) to authenticated;

create function public.my_anonymous_test_access()
returns boolean language sql stable security definer
set search_path = pg_catalog, pg_temp as $$
  select public.anonymous_test_access(p.organization_id)
  from public.profiles p where p.id = auth.uid();
$$;
revoke all on function public.my_anonymous_test_access() from public, anon, service_role;
grant execute on function public.my_anonymous_test_access() to authenticated;

alter table public.incidents drop constraint incidents_anonymous_release_gate;
alter table public.incidents add constraint incidents_anonymous_release_gate
  check (not is_anonymous or public.anonymous_test_access(organization_id));

create or replace function public.submit_my_anonymous_draft(p_incident_id uuid, p_input jsonb)
returns jsonb language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare saved public.incidents; organization uuid;
begin
  select i.organization_id into organization from public.incidents i where i.id = p_incident_id;
  if not coalesce(public.anonymous_test_access(organization), false) then
    raise exception 'Anonymous reporting is not available';
  end if;
  saved := sentinel_private.submit_anonymous_incident(p_incident_id, p_input - 'digitalSignature');
  return jsonb_build_object(
    'id', saved.id, 'referenceNumber', saved.reference_number,
    'status', saved.status, 'confirmation', 'Anonymous reporter'
  );
end;
$$;
notify pgrst, 'reload schema';
