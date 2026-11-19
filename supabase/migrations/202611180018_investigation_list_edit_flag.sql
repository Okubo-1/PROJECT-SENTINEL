create or replace function public.list_investigations()
returns table (
  investigation_id uuid,
  incident_id uuid,
  incident_reference text,
  severity text,
  status public.investigation_status,
  due_at timestamptz,
  is_overdue boolean,
  no_team_assigned boolean,
  assigned_team jsonb,
  can_edit boolean
)
language plpgsql
security definer
set search_path = public, sentinel_private
as $$
declare current_organization_id uuid;
begin
  select profile.organization_id into current_organization_id
  from public.profiles profile
  join public.memberships membership
    on membership.user_id = profile.id
    and membership.organization_id = profile.organization_id
  where profile.id = (select auth.uid())
    and profile.account_status = 'active';
  if current_organization_id is null or not public.can_access_investigations() then
    raise exception 'Not authorized to view investigations' using errcode = '42501';
  end if;

  perform sentinel_private.enqueue_investigation_due_reminders(current_organization_id);
  return query
  select investigation.id,
    incident.id,
    incident.reference_number,
    investigation.level,
    investigation.status,
    investigation.due_at,
    investigation.status <> 'completed'
      and investigation.due_at is not null
      and investigation.due_at < now(),
    public.is_investigation_administrator(current_organization_id)
      and investigation.no_team_assigned,
    coalesce((
      select jsonb_agg(jsonb_build_object('user_id', roster.id, 'full_name', roster.full_name) order by roster.full_name)
      from (
        select member.id, member.full_name
        from public.investigation_team_members team
        join public.profiles member
          on member.id = team.user_id and member.organization_id = team.organization_id
        where team.organization_id = investigation.organization_id
          and team.severity_level = investigation.level
        union
        select handler.id, handler.full_name
        from public.profiles handler
        where handler.id = investigation.assigned_investigator_id
          and handler.organization_id = investigation.organization_id
      ) roster
    ), '[]'::jsonb),
    public.is_investigation_administrator(current_organization_id)
      or coalesce(investigation.assigned_investigator_id = auth.uid(), false)
      or exists (
        select 1 from public.investigation_team_members team
        where team.organization_id = investigation.organization_id
          and team.severity_level = investigation.level
          and team.user_id = auth.uid()
      )
  from public.investigations investigation
  join public.incidents incident
    on incident.id = investigation.incident_id
    and incident.organization_id = investigation.organization_id
  where investigation.organization_id = current_organization_id
    and public.can_view_investigation(investigation.organization_id, investigation.id)
  order by investigation.due_at nulls last, incident.reference_number;
end;
$$;
