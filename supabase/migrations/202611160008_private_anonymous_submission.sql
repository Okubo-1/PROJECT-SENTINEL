-- Internal only: the API and release gate remain closed until the complete
-- anonymous reporting workflow is deployed and verified.
create or replace function public.enforce_incident_workflow_transition()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if new.organization_id <> old.organization_id then raise exception 'Incident organization cannot be changed'; end if;
  if new.status = old.status then return new; end if;
  if old.status = 'draft' and old.is_anonymous then
    if new.status <> 'submitted'
      or not public.can_create_incident(old.organization_id)
      or not exists (select 1 from sentinel_private.my_anonymous_incident_ids() own(id) where own.id = old.id) then
      raise exception 'Anonymous draft is unavailable' using errcode = '42501';
    end if;
    return new;
  end if;
  if new.status = 'closed' then
    if old.status in ('draft', 'closed') or not public.can_close_incidents(old.organization_id)
      or not exists (select 1 from public.incident_closures c
        where c.incident_id = old.id and c.organization_id = old.organization_id and c.closed_by = auth.uid()) then
      raise exception 'Use the authorized closure form with root cause and completed corrective action' using errcode = '42501';
    end if;
    if exists (select 1 from public.corrective_actions a where a.incident_id = old.id
      and a.organization_id = old.organization_id and a.status not in ('verified', 'closed')) then
      raise exception 'All linked corrective actions must be verified or closed before closing this incident';
    end if;
    return new;
  end if;
  if not public.has_org_role(old.organization_id, array[
    'Super Administrator', 'Organization Administrator', 'QHSE Manager', 'Site Supervisor', 'Safety Officer / HSE Officer'
  ]::public.membership_role[]) then
    if not (old.status = 'draft' and new.status = 'submitted' and old.created_by = auth.uid()) then
      raise exception 'You are not authorized to change this incident status';
    end if;
  end if;
  if not (
    (old.status = 'submitted' and new.status = 'under_review')
    or (old.status = 'under_review' and new.status = 'investigation')
    or (old.status = 'investigation' and new.status = 'corrective_action')
    or (old.status = 'corrective_action' and new.status = 'pending_verification')
    or (old.status = 'draft' and new.status = 'submitted')
  ) then raise exception 'Invalid incident workflow transition from % to %', old.status, new.status; end if;
  return new;
end;
$$;

create function sentinel_private.submit_anonymous_incident(
  p_incident_id uuid,
  p_input jsonb
)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  saved public.incidents;
begin
  if auth.uid() is null or p_incident_id is null or jsonb_typeof(p_input) is distinct from 'object' then
    raise exception 'Authentication and a valid incident are required' using errcode = '42501';
  end if;
  if nullif(btrim(p_input->>'occurredAt'), '') is null
    or nullif(btrim(p_input->>'severity'), '') is null
    or nullif(btrim(p_input->>'incidentCategory'), '') is null
    or (p_input->'accuracyConfirmed') is distinct from 'true'::jsonb then
    raise exception 'Complete and confirm the incident before submitting';
  end if;
  select i.* into saved from public.incidents i
    where i.id = p_incident_id and i.is_anonymous
      and i.id in (select sentinel_private.my_anonymous_incident_ids())
    for update;
  if not found then
    raise exception 'Anonymous incident is unavailable' using errcode = '42501';
  end if;
  if saved.status <> 'draft' then return saved; end if;
  saved := sentinel_private.save_anonymous_incident_draft(p_incident_id, p_input, null);
  update public.incidents set status = 'submitted', reported_at = now()
    where id = saved.id and status = 'draft'
    returning * into strict saved;
  return saved;
end;
$$;
revoke all on function sentinel_private.submit_anonymous_incident(uuid, jsonb)
  from public, anon, authenticated, service_role;
