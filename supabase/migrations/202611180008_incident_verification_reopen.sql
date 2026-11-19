create table public.incident_workflow_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  incident_id uuid not null,
  user_id uuid not null,
  notification_type text not null check (notification_type in ('verification_ready', 'reopened')),
  severity text not null,
  due_at timestamptz,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  foreign key (incident_id, organization_id)
    references public.incidents(id, organization_id) on delete cascade,
  foreign key (user_id, organization_id)
    references public.profiles(id, organization_id) on delete cascade
);

create index incident_workflow_notifications_user_unread_idx
  on public.incident_workflow_notifications(user_id, created_at desc)
  where read_at is null;

alter table public.incident_workflow_notifications enable row level security;
alter table public.incident_workflow_notifications force row level security;
revoke all on public.incident_workflow_notifications from public, anon, authenticated, service_role;
grant select on public.incident_workflow_notifications to authenticated;
grant update (read_at) on public.incident_workflow_notifications to authenticated;

create policy incident_workflow_notifications_read_own
  on public.incident_workflow_notifications for select to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(organization_id));

create policy incident_workflow_notifications_mark_own_read
  on public.incident_workflow_notifications for update to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(organization_id))
  with check (user_id = (select auth.uid()) and public.is_org_member(organization_id));

create table public.incident_investigation_views (
  organization_id uuid not null,
  incident_id uuid not null,
  investigation_id uuid not null,
  user_id uuid not null,
  viewed_at timestamptz not null default now(),
  primary key (investigation_id, user_id),
  foreign key (incident_id, organization_id)
    references public.incidents(id, organization_id) on delete cascade,
  foreign key (investigation_id, organization_id)
    references public.investigations(id, organization_id) on delete cascade,
  foreign key (user_id, organization_id)
    references public.profiles(id, organization_id) on delete cascade
);
alter table public.incident_investigation_views enable row level security;
alter table public.incident_investigation_views force row level security;
revoke all on public.incident_investigation_views from public, anon, authenticated, service_role;

create table public.incident_closeout_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  incident_id uuid not null,
  verified_by uuid not null,
  verified_at timestamptz not null default now(),
  foreign key (incident_id, organization_id)
    references public.incidents(id, organization_id) on delete cascade,
  foreign key (verified_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict
);
alter table public.incident_closeout_verifications enable row level security;
alter table public.incident_closeout_verifications force row level security;
revoke all on public.incident_closeout_verifications from public, anon, authenticated, service_role;

create table public.incident_reopen_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null,
  incident_id uuid not null,
  reopened_by uuid not null,
  assigned_to uuid not null,
  reason text check (reason is null or char_length(reason) <= 5000),
  created_at timestamptz not null default now(),
  foreign key (incident_id, organization_id)
    references public.incidents(id, organization_id) on delete cascade,
  foreign key (reopened_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  foreign key (assigned_to, organization_id)
    references public.profiles(id, organization_id) on delete restrict
);
alter table public.incident_reopen_events enable row level security;
alter table public.incident_reopen_events force row level security;
revoke all on public.incident_reopen_events from public, anon, authenticated, service_role;

alter table public.investigation_timeline_events
  drop constraint investigation_timeline_events_event_type_check;
alter table public.investigation_timeline_events
  add constraint investigation_timeline_events_event_type_check
  check (event_type in ('created', 'assigned', 'started', 'finding_added', 'status_changed', 'completed', 'verified', 'reopened'));

create or replace function public.can_reopen_incidents(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(target_organization_id)
    and public.has_org_role(target_organization_id, array['Super Administrator']::public.membership_role[]);
$$;
revoke all on function public.can_reopen_incidents(uuid) from public, anon;
grant execute on function public.can_reopen_incidents(uuid) to authenticated;

create or replace function public.can_view_investigation(
  target_organization_id uuid,
  target_investigation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.investigations investigation
    where investigation.id = target_investigation_id
      and investigation.organization_id = target_organization_id
      and public.is_org_member(target_organization_id)
      and (
        public.is_investigation_administrator(target_organization_id)
        or public.can_close_incidents(target_organization_id)
        or investigation.assigned_investigator_id = (select auth.uid())
        or exists (
          select 1 from public.investigation_team_members team
          where team.organization_id = investigation.organization_id
            and team.severity_level = investigation.level
            and team.user_id = (select auth.uid())
        )
      )
  );
$$;
revoke all on function public.can_view_investigation(uuid, uuid) from public, anon;
grant execute on function public.can_view_investigation(uuid, uuid) to authenticated;

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
    'can_edit', investigation.assigned_investigator_id = auth.uid()
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
revoke all on function public.get_investigation_record(uuid) from public, anon;
grant execute on function public.get_investigation_record(uuid) to authenticated;

create or replace function public.can_access_investigations()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.profiles profile
    join public.memberships membership
      on membership.user_id = profile.id
      and membership.organization_id = profile.organization_id
    where profile.id = (select auth.uid())
      and profile.account_status = 'active'
      and (
        public.is_investigation_administrator(profile.organization_id)
        or public.can_close_incidents(profile.organization_id)
        or exists (
          select 1 from public.investigation_team_members team
          where team.organization_id = profile.organization_id
            and team.user_id = profile.id
        )
        or exists (
          select 1 from public.investigations investigation
          where investigation.organization_id = profile.organization_id
            and investigation.assigned_investigator_id = profile.id
        )
      )
  );
$$;
revoke all on function public.can_access_investigations() from public, anon;
grant execute on function public.can_access_investigations() to authenticated;

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
        (old.status = 'not_started' and new.status = 'in_progress')
      or (old.status = 'assigned' and new.status = 'in_progress')
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
      or investigation.assigned_investigator_id = auth.uid()
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
revoke all on function public.list_investigations() from public, anon;
grant execute on function public.list_investigations() to authenticated;

create or replace function sentinel_private.can_manage_investigation_for_incident(
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
      select 1 from public.investigations investigation
      where investigation.organization_id = target_organization_id
        and investigation.incident_id = target_incident_id
        and (
          public.is_investigation_administrator(target_organization_id)
          or investigation.assigned_investigator_id = auth.uid()
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

create or replace function sentinel_private.can_upload_identified_investigation_evidence(
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
    join public.investigations investigation
      on investigation.incident_id = incident.id
      and investigation.organization_id = incident.organization_id
    where incident.id = target_incident_id
      and incident.organization_id = target_organization_id
      and not incident.is_anonymous
      and investigation.status <> 'completed'
      and sentinel_private.can_manage_investigation_for_incident(
        target_organization_id, target_incident_id
      )
  );
$$;
revoke all on function sentinel_private.can_upload_identified_investigation_evidence(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function sentinel_private.can_upload_investigation_evidence(
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
    select 1 from public.investigations investigation
    where investigation.organization_id = target_organization_id
      and investigation.incident_id = target_incident_id
      and investigation.status <> 'completed'
      and sentinel_private.can_manage_investigation_for_incident(
        target_organization_id, target_incident_id
      )
      and public.is_org_member(target_organization_id)
  );
$$;
revoke all on function sentinel_private.can_upload_investigation_evidence(uuid, uuid)
  from public, anon, authenticated, service_role;

create or replace function public.enforce_incident_workflow_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.organization_id <> old.organization_id then
    raise exception 'Incident organization cannot be changed';
  end if;
  if new.status = old.status then
    return new;
  end if;

  if new.status = 'closed' then
    if old.status <> 'pending_verification'
      or not exists (
        select 1 from public.incident_closeout_verifications verification
        where verification.incident_id = old.id
          and verification.organization_id = old.organization_id
          and verification.verified_by = auth.uid()
      ) then
      raise exception 'Only an authorized close-out verification can close this incident' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status = 'open' then
    if old.status not in ('closed', 'pending_verification')
      or not public.can_reopen_incidents(old.organization_id)
      or not exists (
        select 1 from public.incident_reopen_events reopening
        where reopening.incident_id = old.id
          and reopening.organization_id = old.organization_id
          and reopening.reopened_by = auth.uid()
      ) then
      raise exception 'Only a Super Administrator can reopen an incident' using errcode = '42501';
    end if;
    return new;
  end if;

  if new.status = 'pending_verification' then
    if not exists (
      select 1 from public.investigations investigation
      where investigation.incident_id = old.id
        and investigation.organization_id = old.organization_id
        and investigation.status = 'completed'
    ) or exists (
      select 1 from public.actions action
      where action.incident_id = old.id
        and action.organization_id = old.organization_id
        and action.status <> 'resolved'
    ) then
      raise exception 'Investigation and all assigned actions must be resolved before verification';
    end if;
    return new;
  end if;

  if old.status = 'closed' then
    raise exception 'A closed incident can only be reopened by a Super Administrator' using errcode = '42501';
  end if;
  if not public.has_org_role(old.organization_id, array[
    'Super Administrator', 'Organization Administrator', 'QHSE Manager',
    'Site Supervisor', 'Safety Officer / HSE Officer'
  ]::public.membership_role[]) then
    if not (old.status = 'draft' and new.status = 'submitted' and old.created_by = auth.uid()) then
      raise exception 'You are not authorized to change this incident status' using errcode = '42501';
    end if;
  end if;
  if not (
    (old.status = 'submitted' and new.status in ('under_review', 'investigation'))
    or (old.status = 'under_review' and new.status in ('investigation', 'open'))
    or (old.status = 'investigation' and new.status = 'corrective_action')
    or (old.status = 'corrective_action' and new.status = 'under_review')
    or (old.status = 'draft' and new.status = 'submitted')
  ) then
    raise exception 'Invalid incident workflow transition from % to %', old.status, new.status;
  end if;
  return new;
end;
$$;

create function public.reject_closed_incident_insert()
returns trigger
language plpgsql
as $$
begin
  if new.status = 'closed' then
    raise exception 'Incidents can only be closed through verifier close-out confirmation'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function public.reject_closed_incident_insert() from public, anon, authenticated, service_role;
create trigger incidents_reject_closed_insert
  before insert on public.incidents
  for each row execute function public.reject_closed_incident_insert();

create or replace function public.require_action_resolution_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'open' and new.status = 'resolved' then
    if nullif(btrim(new.resolution_notes), '') is null
      or char_length(btrim(new.resolution_notes)) > 10000 then
      raise exception 'Resolution details are required';
    end if;
    if new.proof_storage_path is null
      or nullif(btrim(new.proof_file_name), '') is null
      or new.proof_file_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      or new.proof_file_size not between 1 and 10485760
      or new.proof_storage_path !~ (
        '^' || old.organization_id::text || '/actions/' || old.id::text || '/'
        || auth.uid()::text || '/[^/]+$'
      )
      or not exists (
        select 1 from storage.objects object
        where object.bucket_id = 'incident-evidence'
          and object.name = new.proof_storage_path
      ) then
      raise exception 'A valid photo or document upload is required';
    end if;
  end if;
  return new;
end;
$$;
revoke all on function public.require_action_resolution_evidence() from public, anon, authenticated, service_role;
create trigger actions_require_resolution_evidence
  before update on public.actions
  for each row execute function public.require_action_resolution_evidence();

create function sentinel_private.notify_incident_verifiers(
  target_organization_id uuid,
  target_incident_id uuid,
  target_severity text,
  target_due_at timestamptz,
  target_type text
)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.incident_workflow_notifications(
    organization_id, incident_id, user_id, notification_type, severity, due_at
  )
  select target_organization_id, target_incident_id, profile.id, target_type, target_severity, target_due_at
  from public.profiles profile
  join public.memberships membership
    on membership.user_id = profile.id
    and membership.organization_id = profile.organization_id
  where profile.organization_id = target_organization_id
    and profile.account_status = 'active'
    and (
      membership.role = 'Super Administrator'
      or (
        exists (
          select 1 from public.incident_closure_delegates delegate
          where delegate.organization_id = target_organization_id
            and delegate.user_id = profile.id
            and delegate.granted_role = membership.role::text
        )
        and (
          public.is_builtin_role_name(membership.role::text)
          or exists (
            select 1 from public.custom_roles custom_role
            where custom_role.organization_id = target_organization_id
              and custom_role.name = membership.role::text
              and custom_role.is_active
          )
        )
      )
    );
$$;
revoke all on function sentinel_private.notify_incident_verifiers(uuid, uuid, text, timestamptz, text)
  from public, anon, authenticated, service_role;

create function sentinel_private.maybe_mark_incident_ready_for_verification(target_incident_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
declare
  incident_row public.incidents;
  investigation_due_at timestamptz;
begin
  select incident.* into incident_row
  from public.incidents incident
  where incident.id = target_incident_id
  for update;
  if not found or incident_row.status in ('closed', 'pending_verification', 'draft') then
    return;
  end if;

  select investigation.due_at into investigation_due_at
  from public.investigations investigation
  where investigation.incident_id = incident_row.id
    and investigation.organization_id = incident_row.organization_id
    and investigation.status = 'completed';
  if not found or exists (
    select 1 from public.actions action
    where action.incident_id = incident_row.id
      and action.organization_id = incident_row.organization_id
      and action.status <> 'resolved'
  ) then
    return;
  end if;

  update public.incidents set status = 'pending_verification'
  where id = incident_row.id and status <> 'pending_verification';
  if found then
    perform sentinel_private.notify_incident_verifiers(
      incident_row.organization_id, incident_row.id,
      coalesce(incident_row.severity, 'Unspecified'), investigation_due_at, 'verification_ready'
    );
  end if;
end;
$$;
revoke all on function sentinel_private.maybe_mark_incident_ready_for_verification(uuid)
  from public, anon, authenticated, service_role;

create function sentinel_private.check_incident_investigation_readiness()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
begin
  perform sentinel_private.maybe_mark_incident_ready_for_verification(new.incident_id);
  return new;
end;
$$;
revoke all on function sentinel_private.check_incident_investigation_readiness()
  from public, anon, authenticated, service_role;
create trigger investigations_check_verification_readiness
  after update of status on public.investigations
  for each row when (new.status = 'completed' and old.status is distinct from new.status)
  execute function sentinel_private.check_incident_investigation_readiness();

create function sentinel_private.check_action_investigation_readiness()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
begin
  if new.incident_id is not null then
    perform sentinel_private.maybe_mark_incident_ready_for_verification(new.incident_id);
  end if;
  return new;
end;
$$;
revoke all on function sentinel_private.check_action_investigation_readiness()
  from public, anon, authenticated, service_role;
create trigger actions_check_verification_readiness
  after update of status on public.actions
  for each row when (new.status = 'resolved' and old.status is distinct from new.status)
  execute function sentinel_private.check_action_investigation_readiness();

create function public.acknowledge_investigation_view(target_investigation_id uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  investigation_row public.investigations;
  incident_status public.incident_status;
begin
  select investigation.* into investigation_row
  from public.investigations investigation
  where investigation.id = target_investigation_id
  for share;
  if not found
    or not public.can_close_incidents(investigation_row.organization_id)
    or investigation_row.status <> 'completed' then
    raise exception 'Only a verifier can acknowledge a completed investigation' using errcode = '42501';
  end if;
  select incident.status into incident_status
  from public.incidents incident
  where incident.id = investigation_row.incident_id
    and incident.organization_id = investigation_row.organization_id;
  if incident_status <> 'pending_verification' then
    raise exception 'The incident is not awaiting verification';
  end if;
  perform public.get_investigation_record(target_investigation_id);
  insert into public.incident_investigation_views(
    organization_id, incident_id, investigation_id, user_id
  ) values (
    investigation_row.organization_id, investigation_row.incident_id,
    investigation_row.id, auth.uid()
  )
  on conflict (investigation_id, user_id)
  do update set viewed_at = excluded.viewed_at;
end;
$$;
revoke all on function public.acknowledge_investigation_view(uuid) from public, anon, service_role;
grant execute on function public.acknowledge_investigation_view(uuid) to authenticated;

create function public.confirm_incident_closeout(target_incident_id uuid)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  incident_row public.incidents;
  investigation_row public.investigations;
  result public.incidents;
begin
  select incident.* into incident_row
  from public.incidents incident
  where incident.id = target_incident_id
  for update;
  if not found or not public.can_close_incidents(incident_row.organization_id) then
    raise exception 'Only an authorized verifier can confirm close-out' using errcode = '42501';
  end if;
  if incident_row.status <> 'pending_verification' then
    raise exception 'The incident is not awaiting verification';
  end if;
  if exists (
    select 1 from public.actions action
    where action.incident_id = incident_row.id
      and action.organization_id = incident_row.organization_id
      and action.resolved_by = auth.uid()
  ) then
    raise exception 'A person who resolved an action on this incident cannot verify its close-out' using errcode = '42501';
  end if;
  if not exists (
    select 1
    from public.investigations investigation
    join public.incident_investigation_views viewed
      on viewed.investigation_id = investigation.id
      and viewed.incident_id = investigation.incident_id
      and viewed.user_id = auth.uid()
    where investigation.incident_id = incident_row.id
      and investigation.organization_id = incident_row.organization_id
      and investigation.status = 'completed'
  ) then
    raise exception 'View the completed investigation before confirming close-out';
  end if;
  if exists (
    select 1 from public.actions action
    where action.incident_id = incident_row.id
      and action.organization_id = incident_row.organization_id
      and action.status <> 'resolved'
  ) then
    raise exception 'All assigned actions must be resolved before close-out';
  end if;

  insert into public.incident_closeout_verifications(organization_id, incident_id, verified_by)
  values (incident_row.organization_id, incident_row.id, auth.uid());
  update public.incidents set status = 'closed'
  where id = incident_row.id returning * into result;

  select investigation.* into strict investigation_row
  from public.investigations investigation
  where investigation.incident_id = incident_row.id
    and investigation.organization_id = incident_row.organization_id;
  insert into public.investigation_timeline_events(
    organization_id, investigation_id, event_type, actor_id, details
  ) values (
    incident_row.organization_id, investigation_row.id, 'verified', auth.uid(),
    jsonb_build_object('status', 'closed')
  );
  insert into public.activity_logs(organization_id, user_id, activity, metadata)
  values (incident_row.organization_id, auth.uid(), 'Incident close-out verified',
    jsonb_build_object('event_code', 'incident_closeout_verified', 'incident_id', incident_row.id));
  return result;
end;
$$;
revoke all on function public.confirm_incident_closeout(uuid) from public, anon, service_role;
grant execute on function public.confirm_incident_closeout(uuid) to authenticated;

create function public.reopen_incident(
  target_incident_id uuid,
  p_assigned_to uuid,
  p_reason text default null
)
returns public.incidents
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
declare
  incident_row public.incidents;
  investigation_row public.investigations;
  result public.incidents;
begin
  select incident.* into incident_row
  from public.incidents incident
  where incident.id = target_incident_id
  for update;
  if not found or not public.can_reopen_incidents(incident_row.organization_id) then
    raise exception 'Only a Super Administrator can reopen an incident' using errcode = '42501';
  end if;
  if p_reason is not null and char_length(p_reason) > 5000 then
    raise exception 'The reopen reason must be 5000 characters or fewer';
  end if;
  if not exists (
    select 1 from public.profiles profile
    join public.memberships membership
      on membership.user_id = profile.id and membership.organization_id = profile.organization_id
    where profile.id = p_assigned_to
      and profile.organization_id = incident_row.organization_id
      and profile.account_status = 'active'
  ) then
    raise exception 'Choose an active user in this organization';
  end if;
  select investigation.* into investigation_row
  from public.investigations investigation
  where investigation.incident_id = incident_row.id
    and investigation.organization_id = incident_row.organization_id
  for update;
  if not found then raise exception 'The incident investigation is unavailable'; end if;
  if incident_row.status not in ('closed', 'pending_verification')
    and investigation_row.status <> 'completed' then
    raise exception 'Only a closed incident or completed investigation can be reopened';
  end if;

  insert into public.incident_reopen_events(
    organization_id, incident_id, reopened_by, assigned_to, reason
  ) values (
    incident_row.organization_id, incident_row.id, auth.uid(), p_assigned_to,
    nullif(btrim(p_reason), '')
  );
  delete from public.incident_investigation_views
  where investigation_id = investigation_row.id;

  update public.investigations
  set status = 'assigned',
      assigned_investigator_id = p_assigned_to,
      assigned_by = auth.uid(),
      assigned_at = now(),
      started_at = null,
      completed_at = null,
      closed_at = null
  where id = investigation_row.id;
  update public.incidents set status = 'open'
  where id = incident_row.id returning * into result;

  insert into public.investigation_timeline_events(
    organization_id, investigation_id, event_type, actor_id, details
  ) values (
    incident_row.organization_id, investigation_row.id, 'reopened', auth.uid(),
    jsonb_strip_nulls(jsonb_build_object('reason', nullif(btrim(p_reason), ''), 'assigned_to', p_assigned_to))
  );
  insert into public.incident_workflow_notifications(
    organization_id, incident_id, user_id, notification_type, severity, due_at
  )
  select incident_row.organization_id, incident_row.id, recipients.user_id,
    'reopened', coalesce(incident_row.severity, 'Unspecified'), investigation_row.due_at
  from (
    select p_assigned_to as user_id
    union
    select team.user_id
    from public.investigation_team_members team
    where team.organization_id = incident_row.organization_id
      and team.severity_level = investigation_row.level
  ) recipients
  where recipients.user_id is not null;
  insert into public.activity_logs(organization_id, user_id, activity, metadata)
  values (incident_row.organization_id, auth.uid(), 'Incident reopened',
    jsonb_build_object('event_code', 'incident_reopened', 'incident_id', incident_row.id));
  return result;
end;
$$;
revoke all on function public.reopen_incident(uuid, uuid, text) from public, anon, service_role;
grant execute on function public.reopen_incident(uuid, uuid, text) to authenticated;

create or replace function public.close_incident(
  target_incident_id uuid,
  p_root_cause text,
  p_corrective_action text,
  p_action_completed boolean
)
returns public.incidents
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Use verifier close-out confirmation to close incidents' using errcode = '42501';
end;
$$;
revoke all on function public.close_incident(uuid, text, text, boolean)
  from public, anon, authenticated, service_role;

create or replace function public.close_incident(target_incident_id uuid)
returns public.incidents
language plpgsql
security definer
set search_path = public
as $$
begin
  raise exception 'Use verifier close-out confirmation to close incidents' using errcode = '42501';
end;
$$;
revoke all on function public.close_incident(uuid) from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
