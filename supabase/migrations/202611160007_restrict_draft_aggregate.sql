-- Match the Executive Analytics authorization boundary for this organization total.
create or replace function public.get_incident_draft_total()
returns bigint
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  organization uuid;
  member_role text;
begin
  select p.organization_id, m.role::text into organization, member_role
  from public.profiles p
  join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
  where p.id = auth.uid() and p.account_status = 'active';
  if organization is null
    or not public.safety_policy_access_allowed(organization)
    or not public.role_has_executive_analytics(organization, member_role) then
    raise exception 'Not authorized to view draft totals' using errcode = '42501';
  end if;
  return (select count(*) from public.incidents i where i.organization_id = organization and i.status = 'draft');
end;
$$;
notify pgrst, 'reload schema';
