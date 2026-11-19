-- Returns a single organization-wide count; no draft rows or caller-supplied
-- filters are exposed. Executive Analytics integration is a separate release.
create function public.get_incident_draft_total()
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  organization uuid;
begin
  select p.organization_id into organization
  from public.profiles p
  join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
  where p.id = auth.uid() and p.account_status = 'active';
  if organization is null
    or not public.safety_policy_access_allowed(organization)
    or not public.has_org_permission(organization, 'view_analytics') then
    raise exception 'Not authorized to view draft totals' using errcode = '42501';
  end if;
  return (select count(*) from public.incidents i where i.organization_id = organization and i.status = 'draft');
end;
$$;
revoke all on function public.get_incident_draft_total() from public, anon;
grant execute on function public.get_incident_draft_total() to authenticated;
notify pgrst, 'reload schema';
