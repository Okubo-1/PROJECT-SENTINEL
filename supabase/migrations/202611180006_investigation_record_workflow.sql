alter table public.incident_evidence
  add constraint incident_evidence_id_organization_unique unique (id, organization_id);

create table public.investigation_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  investigation_id uuid not null,
  incident_evidence_id uuid not null,
  attachment_type text not null check (attachment_type in ('report', 'attachment')),
  created_at timestamptz not null default now(),
  constraint investigation_attachments_investigation_fk
    foreign key (investigation_id, organization_id)
    references public.investigations(id, organization_id) on delete cascade,
  constraint investigation_attachments_evidence_fk
    foreign key (incident_evidence_id, organization_id)
    references public.incident_evidence(id, organization_id) on delete cascade,
  constraint investigation_attachments_unique
    unique (investigation_id, incident_evidence_id)
);

create unique index investigation_attachments_one_report_idx
  on public.investigation_attachments(investigation_id)
  where attachment_type = 'report';

create index investigation_attachments_org_investigation_idx
  on public.investigation_attachments(organization_id, investigation_id);

alter table public.investigation_attachments enable row level security;
alter table public.investigation_attachments force row level security;
revoke all on public.investigation_attachments from public, anon, authenticated, service_role;
grant select on public.investigation_attachments to authenticated;

create policy investigation_attachments_read
  on public.investigation_attachments for select to authenticated
  using (public.can_view_investigation(organization_id, investigation_id));

alter table public.investigation_timeline_events
  drop constraint investigation_timeline_events_event_type_check;
alter table public.investigation_timeline_events
  add constraint investigation_timeline_events_event_type_check
  check (event_type in ('created', 'assigned', 'started', 'finding_added', 'status_changed', 'completed'));

create or replace function sentinel_private.investigation_root_cause(
  root_method text,
  breakdown jsonb
)
returns text
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  answer text;
  answers jsonb;
  root_causes text[] := array[]::text[];
  entry jsonb;
  node jsonb;
  pending jsonb[] := array[]::jsonb[];
  children jsonb;
  root_flag boolean;
  node_count integer := 0;
  heading text;
begin
  if jsonb_typeof(breakdown) is distinct from 'object' then
    return null;
  end if;
  if breakdown->>'method' is distinct from root_method then
    return null;
  end if;

  if root_method = '5_whys' then
    answers := breakdown->'answers';
    if jsonb_typeof(answers) is distinct from 'array' then return null; end if;
    if jsonb_array_length(answers) > 5 then
      raise exception 'The 5 Whys method allows at most five answers';
    end if;
    if jsonb_array_length(answers) = 0 then return null; end if;
    for entry in select value from jsonb_array_elements(answers) loop
      if jsonb_typeof(entry) is distinct from 'string' or nullif(btrim(entry #>> '{}'), '') is null then
        return null;
      end if;
      answer := btrim(entry #>> '{}');
    end loop;
    return answer;
  elsif root_method = 'fishbone' then
    if jsonb_typeof(breakdown->'categories') is distinct from 'object' then return null; end if;
    foreach heading in array array['People', 'Process', 'Equipment', 'Environment', 'Management'] loop
      if jsonb_typeof(breakdown->'categories'->heading) is distinct from 'array' then return null; end if;
      for entry in select value from jsonb_array_elements(breakdown->'categories'->heading) loop
        if jsonb_typeof(entry) is distinct from 'object'
          or jsonb_typeof(entry->'cause') is distinct from 'string'
          or jsonb_typeof(entry->'is_root_cause') is distinct from 'boolean' then
          return null;
        end if;
        if (entry->>'is_root_cause')::boolean then
          answer := nullif(btrim(entry->>'cause'), '');
          if answer is null then return null; end if;
          root_causes := array_append(root_causes, answer);
        end if;
      end loop;
    end loop;
    return nullif(array_to_string(root_causes, '; '), '');
  elsif root_method = 'fault_tree' then
    if nullif(btrim(breakdown->>'top_event'), '') is null
      or coalesce(breakdown->>'gate', '') not in ('AND', 'OR')
      or jsonb_typeof(breakdown->'causes') is distinct from 'array' then
      return null;
    end if;
    for entry in select value from jsonb_array_elements(breakdown->'causes') loop
      pending := array_append(pending, entry);
    end loop;
    while coalesce(array_length(pending, 1), 0) > 0 loop
      node := pending[array_length(pending, 1)];
      pending := pending[1:array_length(pending, 1) - 1];
      node_count := node_count + 1;
      if node_count > 200 or jsonb_typeof(node) is distinct from 'object'
        or nullif(btrim(node->>'cause'), '') is null
        or jsonb_typeof(node->'is_root_cause') is distinct from 'boolean' then
        return null;
      end if;
      children := node->'children';
      if children is null then children := '[]'::jsonb; end if;
      if jsonb_typeof(children) is distinct from 'array' then return null; end if;
      root_flag := (node->>'is_root_cause')::boolean;
      if jsonb_array_length(children) > 0 then
        if root_flag or coalesce(node->>'gate', '') not in ('AND', 'OR') then return null; end if;
        for entry in select value from jsonb_array_elements(children) loop
          pending := array_append(pending, entry);
        end loop;
      elsif root_flag then
        root_causes := array_append(root_causes, btrim(node->>'cause'));
      end if;
    end loop;
    return nullif(array_to_string(root_causes, '; '), '');
  end if;
  return null;
end;
$$;

revoke all on function sentinel_private.investigation_root_cause(text, jsonb)
  from public, anon, authenticated, service_role;

create function sentinel_private.can_manage_investigation_for_incident(
  target_organization_id uuid,
  target_incident_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select public.is_org_member(target_organization_id)
    and exists (
      select 1
      from public.investigations investigation
      where investigation.organization_id = target_organization_id
        and investigation.incident_id = target_incident_id
        and (
          public.is_investigation_administrator(target_organization_id)
          or exists (
            select 1 from public.investigation_team_members team
            where team.organization_id = investigation.organization_id
              and team.severity_level = investigation.level
              and team.user_id = auth.uid()
          )
        )
    );
$$;
revoke all on function sentinel_private.can_manage_investigation_for_incident(uuid, uuid)
  from public, anon, authenticated, service_role;

create function sentinel_private.can_upload_identified_investigation_evidence(
  target_organization_id uuid,
  target_incident_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
  select exists (
    select 1 from public.incidents incident
    where incident.id = target_incident_id
      and incident.organization_id = target_organization_id
      and not incident.is_anonymous
      and public.is_org_member(target_organization_id)
      and exists (
        select 1 from public.investigations investigation
        where investigation.organization_id = target_organization_id
          and investigation.incident_id = target_incident_id
          and investigation.status <> 'completed'
          and (
            public.is_investigation_administrator(target_organization_id)
            or exists (
              select 1 from public.investigation_team_members team
              where team.organization_id = investigation.organization_id
                and team.severity_level = investigation.level
                and team.user_id = auth.uid()
            )
          )
      )
  );
$$;
revoke all on function sentinel_private.can_upload_identified_investigation_evidence(uuid, uuid)
  from public, anon, authenticated, service_role;

create function sentinel_private.can_upload_investigation_evidence(
  target_organization_id uuid,
  target_incident_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog, public
as $$
  select exists (
    select 1
    from public.investigations investigation
    where investigation.organization_id = target_organization_id
      and investigation.incident_id = target_incident_id
      and investigation.status <> 'completed'
      and (
        public.is_investigation_administrator(target_organization_id)
        or exists (
          select 1 from public.investigation_team_members team
          where team.organization_id = investigation.organization_id
            and team.severity_level = investigation.level
            and team.user_id = auth.uid()
        )
      )
      and public.is_org_member(target_organization_id)
  );
$$;
revoke all on function sentinel_private.can_upload_investigation_evidence(uuid, uuid)
  from public, anon, authenticated, service_role;

create function public.get_investigation_evidence_context(target_incident_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'organization_id', incident.organization_id,
    'is_anonymous', incident.is_anonymous
  ) into result
  from public.incidents incident
  where incident.id = target_incident_id
    and sentinel_private.can_manage_investigation_for_incident(
      incident.organization_id, incident.id
    );
  if result is null then
    raise exception 'Investigation evidence is unavailable' using errcode = '42501';
  end if;
  return result;
end;
$$;
revoke all on function public.get_investigation_evidence_context(uuid) from public, anon;
grant execute on function public.get_investigation_evidence_context(uuid) to authenticated;

create policy incident_evidence_select_investigation_team
  on public.incident_evidence for select to authenticated
  using (sentinel_private.can_manage_investigation_for_incident(organization_id, incident_id));

create policy incident_evidence_insert_investigation_team
  on public.incident_evidence for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and sentinel_private.can_upload_identified_investigation_evidence(organization_id, incident_id)
  );

create policy incident_evidence_storage_select_investigation_team
  on storage.objects for select to authenticated
  using (
    bucket_id = 'incident-evidence'
    and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
    and (storage.foldername(name))[2] ~* '^[0-9a-f-]{36}$'
    and sentinel_private.can_manage_investigation_for_incident(
      (storage.foldername(name))[1]::uuid, (storage.foldername(name))[2]::uuid
    )
  );

create policy incident_evidence_storage_insert_investigation_team
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'incident-evidence'
    and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
    and (storage.foldername(name))[2] ~* '^[0-9a-f-]{36}$'
    and (storage.foldername(name))[3] = auth.uid()::text
    and sentinel_private.can_upload_identified_investigation_evidence(
      (storage.foldername(name))[1]::uuid, (storage.foldername(name))[2]::uuid
    )
  );

create or replace function public.can_access_anonymous_evidence(
  target_organization_id uuid,
  target_incident_id uuid,
  for_upload boolean
)
returns boolean
language plpgsql
stable
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
declare
  incident_status public.incident_status;
begin
  if auth.uid() is null or not public.safety_policy_access_allowed(target_organization_id) then
    return false;
  end if;
  select incident.status into incident_status
  from public.incidents incident
  where incident.id = target_incident_id
    and incident.organization_id = target_organization_id
    and incident.is_anonymous;
  if incident_status is null then return false; end if;
  if incident_status <> 'draft' and (
    (for_upload and (
      public.can_manage_incident(target_organization_id, target_incident_id)
      or sentinel_private.can_upload_investigation_evidence(target_organization_id, target_incident_id)
    ))
    or (not for_upload and (
      public.can_view_incident(target_organization_id, target_incident_id)
      or sentinel_private.can_manage_investigation_for_incident(target_organization_id, target_incident_id)
    ))
  ) then
    return true;
  end if;
  if not public.has_org_permission(target_organization_id, 'view_own_reports') then
    return false;
  end if;
  return exists (
    select 1 from sentinel_private.my_anonymous_incident_ids() own(id)
    where own.id = target_incident_id
  );
end;
$$;
revoke all on function public.can_access_anonymous_evidence(uuid, uuid, boolean) from public, anon;
grant execute on function public.can_access_anonymous_evidence(uuid, uuid, boolean) to authenticated;

create or replace function public.get_investigation_record(target_investigation_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  result jsonb;
begin
  if not public.can_view_investigation(
    (select i.organization_id from public.investigations i where i.id = target_investigation_id),
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
    'can_edit', public.is_investigation_administrator(investigation.organization_id)
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

revoke all on function public.get_investigation_record(uuid) from public, anon;
grant execute on function public.get_investigation_record(uuid) to authenticated;

create function public.save_investigation_record(
  target_investigation_id uuid,
  p_record jsonb,
  close_investigation boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
declare
  current_record public.investigations;
  method text := nullif(btrim(p_record->>'root_cause_method'), '');
  breakdown jsonb := p_record->'root_cause_breakdown';
  root_cause text;
  report_id uuid;
  evidence_row public.incident_evidence;
  attachment_id uuid;
  attachment_ids jsonb := coalesce(p_record->'attachment_ids', '[]'::jsonb);
  actor uuid := auth.uid();
begin
  if actor is null or jsonb_typeof(p_record) is distinct from 'object' then
    raise exception 'A valid authenticated investigation record is required' using errcode = '42501';
  end if;

  select investigation.* into current_record
  from public.investigations investigation
  where investigation.id = target_investigation_id
  for update;
  if not found or not public.can_view_investigation(current_record.organization_id, current_record.id)
    or not (
      public.is_investigation_administrator(current_record.organization_id)
      or exists (
        select 1 from public.investigation_team_members team
        where team.organization_id = current_record.organization_id
          and team.severity_level = current_record.level
          and team.user_id = actor
      )
    ) then
    raise exception 'Not authorized to update this investigation' using errcode = '42501';
  end if;
  if current_record.status = 'completed' then
    raise exception 'This investigation is already closed';
  end if;

  if jsonb_typeof(attachment_ids) is distinct from 'array' then
    raise exception 'Investigation attachments must be a list';
  end if;
  if jsonb_array_length(attachment_ids) > 50 then
    raise exception 'An investigation can have at most 50 additional attachments';
  end if;
  if method is not null and method not in ('5_whys', 'fishbone', 'fault_tree') then
    raise exception 'Choose a supported root cause method';
  end if;
  if breakdown is not null and jsonb_typeof(breakdown) is distinct from 'object' then
    raise exception 'Root cause breakdown must be structured JSON';
  end if;

  if close_investigation then
    if nullif(btrim(p_record->>'immediate_causes'), '') is null then
      raise exception 'Immediate causes are required';
    end if;
    if method is null or breakdown is null then
      raise exception 'A root cause method and breakdown are required';
    end if;
    root_cause := sentinel_private.investigation_root_cause(method, breakdown);
    if root_cause is null then
      raise exception 'Complete the root cause analysis and mark at least one root cause';
    end if;
  elsif method is not null and breakdown is not null then
    root_cause := sentinel_private.investigation_root_cause(method, breakdown);
  end if;

  if nullif(p_record->>'report_evidence_id', '') is not null then
    begin
      report_id := (p_record->>'report_evidence_id')::uuid;
    exception when invalid_text_representation then
      raise exception 'Investigation report reference is invalid';
    end;
    select evidence.* into evidence_row
    from public.incident_evidence evidence
    where evidence.id = report_id
      and evidence.organization_id = current_record.organization_id
      and evidence.incident_id = current_record.incident_id;
    if not found or evidence_row.file_size > 10485760
      or evidence_row.mime_type not in (
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
      )
      or not (
        (lower(evidence_row.original_filename) ~ '\.pdf$' and evidence_row.mime_type = 'application/pdf')
        or (lower(evidence_row.original_filename) ~ '\.doc$' and evidence_row.mime_type = 'application/msword')
        or (lower(evidence_row.original_filename) ~ '\.docx$'
          and evidence_row.mime_type = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
        or (lower(evidence_row.original_filename) = 'evidence'
          and evidence_row.mime_type in (
            'application/pdf',
            'application/msword',
            'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
          ))
      ) then
      raise exception 'The investigation report must be a PDF or Word document';
    end if;
  elsif close_investigation then
    raise exception 'An investigation report is required';
  end if;

  for attachment_id in
    select value::text::uuid from jsonb_array_elements_text(attachment_ids)
  loop
    if not exists (
      select 1 from public.incident_evidence evidence
      where evidence.id = attachment_id
        and evidence.organization_id = current_record.organization_id
        and evidence.incident_id = current_record.incident_id
    ) then
      raise exception 'An attachment does not belong to this incident';
    end if;
  end loop;

  if report_id is not null then
    delete from public.investigation_attachments
    where investigation_id = target_investigation_id and attachment_type = 'report'
      and incident_evidence_id <> report_id;
    insert into public.investigation_attachments(
      organization_id, investigation_id, incident_evidence_id, attachment_type
    ) values (
      current_record.organization_id, target_investigation_id, report_id, 'report'
    )
    on conflict (investigation_id, incident_evidence_id)
    do update set attachment_type = 'report';
  else
    delete from public.investigation_attachments
    where investigation_id = target_investigation_id and attachment_type = 'report';
  end if;

  delete from public.investigation_attachments linked
  where linked.investigation_id = target_investigation_id
    and linked.attachment_type = 'attachment'
    and not exists (
      select 1 from jsonb_array_elements_text(attachment_ids) selected(value)
      where selected.value::uuid = linked.incident_evidence_id
    );
  for attachment_id in
    select value::text::uuid from jsonb_array_elements_text(attachment_ids)
  loop
    insert into public.investigation_attachments(
      organization_id, investigation_id, incident_evidence_id, attachment_type
    ) values (
      current_record.organization_id, target_investigation_id, attachment_id, 'attachment'
    )
    on conflict (investigation_id, incident_evidence_id)
    do update set attachment_type = 'attachment';
  end loop;

  update public.investigations
  set witness_statement = nullif(btrim(p_record->>'witness_statement'), ''),
      immediate_causes = nullif(btrim(p_record->>'immediate_causes'), ''),
      root_cause_method = method,
      root_cause_breakdown = case when method is null then null else breakdown end,
      root_causes_summary = root_cause,
      contributing_factors = nullif(btrim(p_record->>'contributing_factors'), ''),
      started_at = coalesce(started_at, now()),
      status = case when close_investigation then 'completed'::public.investigation_status
                    else 'in_progress'::public.investigation_status end,
      closed_at = case when close_investigation then now() else null end,
      completed_at = case when close_investigation then now() else null end
  where id = target_investigation_id;

  if not close_investigation then
    insert into public.investigation_timeline_events(
      organization_id, investigation_id, event_type, actor_id, details
    ) values (
      current_record.organization_id, target_investigation_id, 'finding_added',
      actor, jsonb_build_object('record_saved', true, 'closed', false)
    );
  end if;

  return public.get_investigation_record(target_investigation_id);
end;
$$;

revoke all on function public.save_investigation_record(uuid, jsonb, boolean) from public, anon;
grant execute on function public.save_investigation_record(uuid, jsonb, boolean) to authenticated;

drop function public.list_investigations();
create function public.list_investigations()
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
declare
  current_organization_id uuid;
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
      select jsonb_agg(jsonb_build_object('user_id', member.id, 'full_name', member.full_name) order by member.full_name)
      from public.investigation_team_members team
      join public.profiles member on member.id = team.user_id
        and member.organization_id = team.organization_id
      where team.organization_id = investigation.organization_id
        and team.severity_level = investigation.level
    ), '[]'::jsonb),
    public.is_investigation_administrator(current_organization_id)
      or exists (
        select 1 from public.investigation_team_members team
        where team.organization_id = investigation.organization_id
          and team.severity_level = investigation.level
          and team.user_id = auth.uid()
      )
  from public.investigations investigation
  join public.incidents incident on incident.id = investigation.incident_id
    and incident.organization_id = investigation.organization_id
  where investigation.organization_id = current_organization_id
    and public.can_view_investigation(investigation.organization_id, investigation.id)
  order by investigation.due_at nulls last, incident.reference_number;
end;
$$;
revoke all on function public.list_investigations() from public, anon;
grant execute on function public.list_investigations() to authenticated;

notify pgrst, 'reload schema';
