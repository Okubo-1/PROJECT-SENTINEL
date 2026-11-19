create or replace function public.enforce_investigation_workflow()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.organization_id is distinct from old.organization_id
    or new.incident_id is distinct from old.incident_id
    or new.created_by is distinct from old.created_by then
    raise exception 'Investigation ownership cannot be changed';
  end if;

  if new.assigned_investigator_id is distinct from old.assigned_investigator_id
    or new.investigation_lead_id is distinct from old.investigation_lead_id
    or new.assigned_by is distinct from old.assigned_by
    or new.assigned_at is distinct from old.assigned_at then
    if not public.can_assign_investigation(old.organization_id) then
      raise exception 'You are not authorized to assign this investigation';
    end if;
    if new.assigned_by is distinct from (select auth.uid()) then
      raise exception 'Assignment actor must be the authenticated user';
    end if;
  end if;

  if new.status is distinct from old.status then
    if old.status = 'completed' and new.status = 'assigned' then
      if not public.can_reopen_incidents(old.organization_id)
        or not exists (
          select 1 from public.incident_reopen_events reopening
          where reopening.incident_id = old.incident_id
            and reopening.organization_id = old.organization_id
            and reopening.reopened_by = auth.uid()
        ) then
        raise exception 'Only a Super Administrator can reopen an investigation' using errcode = '42501';
      end if;
    elsif new.status = 'completed' and (
        nullif(btrim(new.immediate_causes), '') is null
        or new.root_cause_method is null
        or new.root_cause_method not in ('5_whys', 'fishbone', 'fault_tree')
        or new.root_cause_breakdown is null
        or nullif(btrim(new.root_causes_summary), '') is null
        or sentinel_private.investigation_root_cause(
          new.root_cause_method, new.root_cause_breakdown
        ) is distinct from new.root_causes_summary
        or not exists (
          select 1
          from public.investigation_attachments linked
          join public.incident_evidence evidence
            on evidence.id = linked.incident_evidence_id
            and evidence.organization_id = linked.organization_id
          where linked.organization_id = old.organization_id
            and linked.investigation_id = old.id
            and linked.attachment_type = 'report'
            and evidence.incident_id = old.incident_id
            and evidence.mime_type in (
              'application/pdf', 'application/msword',
              'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            )
            and (
              (lower(evidence.original_filename) ~ '\.pdf$' and evidence.mime_type = 'application/pdf')
              or (lower(evidence.original_filename) ~ '\.doc$' and evidence.mime_type = 'application/msword')
              or (lower(evidence.original_filename) ~ '\.docx$'
                and evidence.mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
              or (lower(evidence.original_filename) = 'evidence')
            )
        )
    ) then
        raise exception 'Complete the investigation record and attach a valid report before closing';
    elsif not (
        (old.status in ('not_started', 'assigned') and new.status in ('in_progress', 'completed'))
      or (old.status = 'in_progress' and new.status in ('pending_review', 'completed'))
      or (old.status = 'pending_review' and new.status = 'completed')
    ) then
      raise exception 'Invalid investigation workflow transition from % to %', old.status, new.status;
    end if;
    if not public.can_manage_investigation(old.organization_id, old.id) then
      raise exception 'You are not authorized to change this investigation status';
    end if;
  end if;

  if new.status = 'in_progress' and new.started_at is null then
    new.started_at := now();
  end if;
  if new.status = 'completed' and new.completed_at is null then
    new.completed_at := now();
  end if;
  if new.status = 'completed' and old.status is distinct from new.status then
    new.closed_at := coalesce(new.closed_at, now());
    insert into public.investigation_timeline_events(
      organization_id, investigation_id, event_type, actor_id, details
    ) values (
      old.organization_id, old.id, 'completed', auth.uid(),
      jsonb_build_object('record_saved', true, 'closed', true)
    );
  end if;
  return new;
end;
$$;
