create function public.get_verifier_incident_actions(target_incident_id uuid)
returns table (
  id uuid, incident_id uuid, type text, description text, assignee_id uuid,
  due_at timestamptz, status text, assigned_at timestamptz,
  resolved_at timestamptz, resolved_by uuid
)
language plpgsql
stable
security definer
set search_path = pg_catalog, public
as $$
declare incident_row public.incidents;
begin
  select incident.* into incident_row
  from public.incidents incident where incident.id = target_incident_id;
  if not found or not public.is_org_member(incident_row.organization_id)
    or not public.can_close_incidents(incident_row.organization_id) then
    raise exception 'Not authorized to view incident actions' using errcode = '42501';
  end if;

  return query
  select action.id, action.incident_id, action.type,
    case when incident_row.is_anonymous then 'Linked action' else action.description end,
    null::uuid, action.due_at, action.status, action.assigned_at, action.resolved_at,
    case when action.resolved_by = auth.uid() then auth.uid() else null end
  from public.actions action
  where action.incident_id = incident_row.id
    and action.organization_id = incident_row.organization_id
  order by action.assigned_at desc;
end;
$$;
revoke all on function public.get_verifier_incident_actions(uuid) from public, anon, service_role;
grant execute on function public.get_verifier_incident_actions(uuid) to authenticated;
