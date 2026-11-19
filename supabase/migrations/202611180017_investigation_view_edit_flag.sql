create or replace function public.get_investigation_record(target_investigation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare result jsonb;
begin
  if not public.can_view_investigation(
    (select investigation.organization_id from public.investigations investigation
     where investigation.id = target_investigation_id),
    target_investigation_id
  ) then
    raise exception 'Not authorized to view this investigation' using errcode = '42501';
  end if;

  select jsonb_build_object(
    'investigation', jsonb_build_object(
      'id', investigation.id,
      'organization_id', investigation.organization_id,
      'incident_id', investigation.incident_id,
      'level', investigation.level,
      'status', investigation.status,
      'due_at', investigation.due_at,
      'witness_statement', investigation.witness_statement,
      'immediate_causes', investigation.immediate_causes,
      'root_cause_method', investigation.root_cause_method,
      'root_cause_breakdown', investigation.root_cause_breakdown,
      'root_causes_summary', investigation.root_causes_summary,
      'contributing_factors', investigation.contributing_factors,
      'closed_at', investigation.closed_at
    ),
    'incident', jsonb_build_object(
      'reference_number', incident.reference_number,
      'incident_category', incident.incident_category,
      'severity', coalesce(incident.severity, investigation.level),
      'site_name', site.name,
      'department', incident.department,
      'facility_name', facility.name,
      'location', incident.location,
      'occurred_at', incident.occurred_at,
      'shift', incident.shift
    ),
    'assigned_team', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', profile.id, 'full_name', profile.full_name) order by profile.full_name)
      from public.investigation_team_members team
      join public.profiles profile on profile.id = team.user_id
        and profile.organization_id = team.organization_id
      where team.organization_id = investigation.organization_id
        and team.severity_level = investigation.level
    ), '[]'::jsonb),
    'timeline', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', event.id, 'event_type', event.event_type,
        'details', event.details, 'created_at', event.created_at
      ) order by event.created_at)
      from public.investigation_timeline_events event
      where event.investigation_id = investigation.id
        and event.organization_id = investigation.organization_id
    ), '[]'::jsonb),
    'attachments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', evidence.id, 'original_filename', evidence.original_filename,
        'mime_type', evidence.mime_type, 'file_size', evidence.file_size,
        'attachment_type', linked.attachment_type
      ) order by linked.created_at)
      from public.investigation_attachments linked
      join public.incident_evidence evidence on evidence.id = linked.incident_evidence_id
        and evidence.organization_id = linked.organization_id
      where linked.investigation_id = investigation.id
        and linked.organization_id = investigation.organization_id
    ), '[]'::jsonb),
    'linked_actions', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', action.id, 'type', action.type,
        'description', case when incident.is_anonymous then 'Linked action' else action.description end,
        'status', action.status, 'due_at', action.due_at
      ) order by action.due_at)
      from public.actions action
      where action.incident_id = incident.id
        and action.organization_id = incident.organization_id
    ), '[]'::jsonb),
    'can_edit', coalesce(investigation.assigned_investigator_id = auth.uid(), false)
      or public.is_investigation_administrator(investigation.organization_id)
      or exists (
        select 1 from public.investigation_team_members team
        where team.organization_id = investigation.organization_id
          and team.severity_level = investigation.level
          and team.user_id = auth.uid()
      )
  )
  into result
  from public.investigations investigation
  join public.incidents incident on incident.id = investigation.incident_id
    and incident.organization_id = investigation.organization_id
  left join public.sites site on site.id = incident.site_id
    and site.organization_id = incident.organization_id
  left join public.facilities facility on facility.id = incident.facility_id
    and facility.organization_id = incident.organization_id
  where investigation.id = target_investigation_id;
  return result;
end;
$$;
