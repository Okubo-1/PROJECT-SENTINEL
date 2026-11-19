-- Internal draft writer only. The anonymous release gate remains enabled and
-- this function is not granted to API roles until the complete flow is ready.
create function sentinel_private.save_anonymous_incident_draft(
  p_incident_id uuid,
  p_input jsonb,
  p_client_submission_id text default null
)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  current_user_id uuid := auth.uid();
  organization uuid;
  saved public.incidents;
begin
  if current_user_id is null or jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Authentication and a valid draft are required' using errcode = '42501';
  end if;
  select p.organization_id into organization
    from public.profiles p
    join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
    where p.id = current_user_id and p.account_status = 'active';
  if organization is null or not public.can_create_incident(organization)
    or not public.has_org_permission(organization, 'view_own_reports') then
    raise exception 'Not authorized to create a draft' using errcode = '42501';
  end if;

  if p_incident_id is null and nullif(p_client_submission_id, '') is not null then
    select i.* into saved from public.incidents i
      where i.organization_id = organization and i.client_submission_id = p_client_submission_id;
    if found then
      if not saved.is_anonymous or not exists (
        select 1 from sentinel_private.my_anonymous_incident_ids() own(id) where own.id = saved.id
      ) then
        raise exception 'Draft is unavailable' using errcode = '42501';
      end if;
      return saved;
    end if;
  end if;

  if p_incident_id is null then
    insert into public.incidents (
      organization_id, report_type, status, title, description, occurred_at,
      site_id, facility_id, location, department, shift, work_activity_context,
      reported_by, created_by, is_anonymous, contractor_involved, contractor_organization,
      severity, potential_severity, incident_category, environmental_impact,
      injury_or_illness, property_damage, work_related, immediate_correction, priority,
      gps_coordinates, weather_conditions, equipment_involved, people_involved, witnesses,
      potential_root_cause, digital_signature, accuracy_confirmed, draft_stage, client_submission_id
    ) values (
      organization, (p_input->>'reportType')::public.incident_report_type, 'draft',
      coalesce(nullif(p_input->>'title', ''), 'Untitled draft'), nullif(p_input->>'description', ''),
      nullif(p_input->>'occurredAt', '')::timestamptz, nullif(p_input->>'siteId', '')::uuid,
      nullif(p_input->>'facilityId', '')::uuid, nullif(p_input->>'location', ''),
      nullif(p_input->>'department', ''), nullif(p_input->>'shift', ''), nullif(p_input->>'workActivityContext', ''),
      null, null, true, coalesce((p_input->>'contractorInvolved')::boolean, false),
      nullif(p_input->>'contractorOrganization', ''), nullif(p_input->>'severity', ''),
      nullif(p_input->>'potentialSeverity', ''), nullif(p_input->>'incidentCategory', ''),
      coalesce((p_input->>'environmentalImpact')::boolean, false),
      coalesce((p_input->>'injuryOrIllness')::boolean, false),
      coalesce((p_input->>'propertyDamage')::boolean, false),
      coalesce((p_input->>'workRelated')::boolean, true),
      nullif(p_input->>'immediateCorrection', ''), nullif(p_input->>'priority', ''),
      nullif(p_input->>'gpsCoordinates', ''), nullif(p_input->>'weatherConditions', ''),
      nullif(p_input->>'equipmentInvolved', ''), nullif(p_input->>'peopleInvolved', ''),
      nullif(p_input->>'witnesses', ''), nullif(p_input->>'potentialRootCause', ''),
      null, coalesce((p_input->>'accuracyConfirmed')::boolean, false),
      greatest(0, least(3, coalesce((p_input->>'draftStage')::smallint, 0))),
      nullif(p_client_submission_id, '')
    ) returning * into saved;
    perform sentinel_private.insert_anonymous_reporter_link(saved.id, current_user_id);
  else
    update public.incidents i set
      report_type = (p_input->>'reportType')::public.incident_report_type,
      title = coalesce(nullif(p_input->>'title', ''), 'Untitled draft'),
      description = nullif(p_input->>'description', ''),
      occurred_at = nullif(p_input->>'occurredAt', '')::timestamptz,
      site_id = nullif(p_input->>'siteId', '')::uuid,
      facility_id = nullif(p_input->>'facilityId', '')::uuid,
      location = nullif(p_input->>'location', ''),
      department = nullif(p_input->>'department', ''),
      shift = nullif(p_input->>'shift', ''),
      work_activity_context = nullif(p_input->>'workActivityContext', ''),
      contractor_involved = coalesce((p_input->>'contractorInvolved')::boolean, false),
      contractor_organization = nullif(p_input->>'contractorOrganization', ''),
      severity = nullif(p_input->>'severity', ''),
      potential_severity = nullif(p_input->>'potentialSeverity', ''),
      incident_category = nullif(p_input->>'incidentCategory', ''),
      environmental_impact = coalesce((p_input->>'environmentalImpact')::boolean, false),
      injury_or_illness = coalesce((p_input->>'injuryOrIllness')::boolean, false),
      property_damage = coalesce((p_input->>'propertyDamage')::boolean, false),
      work_related = coalesce((p_input->>'workRelated')::boolean, true),
      immediate_correction = nullif(p_input->>'immediateCorrection', ''),
      priority = nullif(p_input->>'priority', ''),
      gps_coordinates = nullif(p_input->>'gpsCoordinates', ''),
      weather_conditions = nullif(p_input->>'weatherConditions', ''),
      equipment_involved = nullif(p_input->>'equipmentInvolved', ''),
      people_involved = nullif(p_input->>'peopleInvolved', ''),
      witnesses = nullif(p_input->>'witnesses', ''),
      potential_root_cause = nullif(p_input->>'potentialRootCause', ''),
      digital_signature = null,
      accuracy_confirmed = coalesce((p_input->>'accuracyConfirmed')::boolean, false),
      draft_stage = greatest(0, least(3, coalesce((p_input->>'draftStage')::smallint, 0)))
    where i.id = p_incident_id and i.organization_id = organization
      and i.is_anonymous and i.status = 'draft'
      and i.id in (select sentinel_private.my_anonymous_incident_ids())
    returning i.* into saved;
    if not found then
      raise exception 'Draft is unavailable' using errcode = '42501';
    end if;
  end if;
  return saved;
end;
$$;
revoke all on function sentinel_private.save_anonymous_incident_draft(uuid, jsonb, text)
  from public, anon, authenticated, service_role;
