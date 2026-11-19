-- Create investigations atomically with incident submission, including the private
-- anonymous submission path. No reporter-link data is read by this workflow.

alter table public.investigations
  alter column created_by drop not null,
  add column no_team_assigned boolean not null default false;

alter table public.investigation_timeline_events
  alter column actor_id drop not null;

create table public.investigation_notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null,
  investigation_id uuid not null,
  incident_id uuid not null,
  notification_type text not null check (notification_type in ('assigned', 'due_soon')),
  severity text not null,
  due_at timestamptz not null,
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint investigation_notifications_user_same_organization
    foreign key (user_id, organization_id)
    references public.profiles(id, organization_id) on delete cascade,
  constraint investigation_notifications_investigation_same_organization
    foreign key (investigation_id, organization_id)
    references public.investigations(id, organization_id) on delete cascade,
  constraint investigation_notifications_incident_same_organization
    foreign key (incident_id, organization_id)
    references public.incidents(id, organization_id) on delete cascade,
  constraint investigation_notifications_per_user unique (investigation_id, user_id, notification_type)
);

create index investigation_notifications_user_unread_idx
  on public.investigation_notifications(user_id, created_at desc)
  where read_at is null;

alter table public.investigation_notifications enable row level security;
alter table public.investigation_notifications force row level security;
revoke all on public.investigation_notifications from public, anon, authenticated, service_role;
grant select on public.investigation_notifications to authenticated;
grant update (read_at) on public.investigation_notifications to authenticated;

create policy investigation_notifications_read_own
  on public.investigation_notifications for select to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(organization_id));

create policy investigation_notifications_mark_own_read
  on public.investigation_notifications for update to authenticated
  using (user_id = (select auth.uid()) and public.is_org_member(organization_id))
  with check (user_id = (select auth.uid()) and public.is_org_member(organization_id));

create or replace function public.update_investigation_due_at()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  configured_hours integer;
begin
  if new.level is null then
    return new;
  end if;

  if tg_op = 'INSERT' then
    if new.due_at is not null then
      return new;
    end if;
  elsif new.level is not distinct from old.level and new.due_at is not null then
    return new;
  end if;

  select case lower(new.level)
    when 'critical' then d.critical_hours
    when 'high' then d.high_hours
    when 'medium' then d.medium_hours
    when 'low' then d.low_hours
    else null
  end
  into configured_hours
  from public.investigation_deadlines d
  where d.organization_id = new.organization_id;

  configured_hours := coalesce(configured_hours, case lower(new.level)
    when 'critical' then 24
    when 'high' then 72
    when 'medium' then 168
    when 'low' then 336
    else 72
  end);

  new.due_at := coalesce(new.created_at, now()) + make_interval(hours => configured_hours);
  return new;
end;
$$;

create or replace function public.is_investigation_administrator(target_organization_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_org_member(target_organization_id)
    and public.has_org_role(target_organization_id, array[
      'Super Administrator',
      'Organization Administrator',
      'QHSE Manager'
    ]::public.membership_role[]);
$$;

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
        or exists (
          select 1
          from public.investigation_team_members team
          where team.organization_id = investigation.organization_id
            and team.severity_level = investigation.level
            and team.user_id = (select auth.uid())
        )
      )
  );
$$;

revoke all on function public.is_investigation_administrator(uuid) from public, anon;
revoke all on function public.can_view_investigation(uuid, uuid) from public, anon;
grant execute on function public.is_investigation_administrator(uuid) to authenticated;
grant execute on function public.can_view_investigation(uuid, uuid) to authenticated;

drop policy if exists investigation_timeline_events_org_members_view
  on public.investigation_timeline_events;
create policy investigation_timeline_events_org_members_view
  on public.investigation_timeline_events for select to authenticated
  using (public.can_view_investigation(organization_id, investigation_id));

create or replace function sentinel_private.guard_investigation_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  anonymous_incident boolean;
begin
  select incident.is_anonymous into strict anonymous_incident
  from public.incidents incident
  where incident.id = new.incident_id
    and incident.organization_id = new.organization_id;

  if anonymous_incident and new.created_by is not null then
    raise exception 'Anonymous investigations cannot include a reporter identity';
  end if;
  return new;
end;
$$;

revoke all on function sentinel_private.guard_investigation_identity()
  from public, anon, authenticated, service_role;
create trigger investigations_guard_reporter_identity
  before insert or update of incident_id, organization_id, created_by
  on public.investigations
  for each row execute function sentinel_private.guard_investigation_identity();

create or replace function sentinel_private.guard_investigation_timeline_identity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
declare
  anonymous_incident boolean;
begin
  select incident.is_anonymous into strict anonymous_incident
  from public.incidents incident
  join public.investigations investigation
    on investigation.incident_id = incident.id
    and investigation.organization_id = incident.organization_id
  where investigation.id = new.investigation_id
    and investigation.organization_id = new.organization_id;

  if anonymous_incident then
    new.actor_id := null;
    new.details := jsonb_strip_nulls(jsonb_build_object(
      'severity', new.details->'severity',
      'due_at', new.details->'due_at',
      'no_team_assigned', new.details->'no_team_assigned'
    ));
  end if;
  return new;
end;
$$;

revoke all on function sentinel_private.guard_investigation_timeline_identity()
  from public, anon, authenticated, service_role;
create trigger investigation_timeline_guard_reporter_identity
  before insert or update of investigation_id, organization_id, actor_id, details
  on public.investigation_timeline_events
  for each row execute function sentinel_private.guard_investigation_timeline_identity();

create or replace function sentinel_private.create_investigation_for_submitted_incident()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, sentinel_private
as $$
declare
  investigation_level text := nullif(btrim(new.severity), '');
  deadline_hours integer;
  team_count integer;
  created_investigation_id uuid;
begin
  select case lower(investigation_level)
    when 'critical' then d.critical_hours
    when 'high' then d.high_hours
    when 'medium' then d.medium_hours
    when 'low' then d.low_hours
    else null
  end
  into deadline_hours
  from public.investigation_deadlines d
  where d.organization_id = new.organization_id;

  deadline_hours := coalesce(deadline_hours, case lower(investigation_level)
    when 'critical' then 24
    when 'high' then 72
    when 'medium' then 168
    when 'low' then 336
    else 72
  end);

  select count(*)::integer into team_count
  from public.investigation_team_members team
  join public.profiles member
    on member.id = team.user_id
    and member.organization_id = team.organization_id
    and member.account_status = 'active'
  join public.memberships membership
    on membership.user_id = member.id
    and membership.organization_id = member.organization_id
  where team.organization_id = new.organization_id
    and team.severity_level = investigation_level;

  insert into public.investigations (
    organization_id,
    incident_id,
    level,
    due_at,
    no_team_assigned,
    created_by
  )
  values (
    new.organization_id,
    new.id,
    investigation_level,
    now() + make_interval(hours => deadline_hours),
    team_count = 0,
    case when new.is_anonymous then null else coalesce(new.created_by, new.reported_by) end
  )
  on conflict (organization_id, incident_id) do nothing
  returning id into created_investigation_id;

  if created_investigation_id is null then
    return new;
  end if;

  insert into public.investigation_timeline_events (
    organization_id, investigation_id, event_type, actor_id, details
  )
  values (
    new.organization_id,
    created_investigation_id,
    'created',
    case when new.is_anonymous then null else coalesce(new.created_by, new.reported_by) end,
    jsonb_build_object(
      'severity', investigation_level,
      'due_at', now() + make_interval(hours => deadline_hours),
      'no_team_assigned', team_count = 0
    )
  );

  insert into public.investigation_notifications (
    organization_id, user_id, investigation_id, incident_id,
    notification_type, severity, due_at
  )
  select new.organization_id, team.user_id, created_investigation_id, new.id,
    'assigned', investigation_level, now() + make_interval(hours => deadline_hours)
  from public.investigation_team_members team
  join public.profiles member
    on member.id = team.user_id
    and member.organization_id = team.organization_id
    and member.account_status = 'active'
  join public.memberships membership
    on membership.user_id = member.id
    and membership.organization_id = member.organization_id
  where team.organization_id = new.organization_id
    and team.severity_level = investigation_level
  on conflict (investigation_id, user_id, notification_type) do nothing;

  return new;
end;
$$;

revoke all on function sentinel_private.create_investigation_for_submitted_incident()
  from public, anon, authenticated, service_role;
create trigger incidents_create_investigation_after_submit
  after insert on public.incidents
  for each row when (new.status = 'submitted')
  execute function sentinel_private.create_investigation_for_submitted_incident();
create trigger incidents_create_investigation_after_draft_submit
  after update of status on public.incidents
  for each row when (old.status = 'draft' and new.status = 'submitted')
  execute function sentinel_private.create_investigation_for_submitted_incident();

create function sentinel_private.enqueue_investigation_due_reminders(target_organization_id uuid)
returns void
language sql
security definer
set search_path = pg_catalog, public
as $$
  insert into public.investigation_notifications (
    organization_id, user_id, investigation_id, incident_id,
    notification_type, severity, due_at
  )
  select investigation.organization_id, team.user_id, investigation.id, investigation.incident_id,
    'due_soon', investigation.level, investigation.due_at
  from public.investigations investigation
  join public.investigation_team_members team
    on team.organization_id = investigation.organization_id
    and team.severity_level = investigation.level
  join public.profiles member
    on member.id = team.user_id
    and member.organization_id = team.organization_id
    and member.account_status = 'active'
  join public.memberships membership
    on membership.user_id = member.id
    and membership.organization_id = member.organization_id
  where investigation.organization_id = target_organization_id
    and investigation.status <> 'completed'
    and investigation.due_at > now()
    and investigation.due_at <= now() + case
      when lower(investigation.level) = 'critical' then interval '6 hours'
      else interval '24 hours'
    end
  on conflict (investigation_id, user_id, notification_type) do nothing;
$$;
revoke all on function sentinel_private.enqueue_investigation_due_reminders(uuid)
  from public, anon, authenticated, service_role;

create function public.can_access_investigations()
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
          select 1
          from public.investigation_team_members team
          where team.organization_id = profile.organization_id
            and team.user_id = profile.id
        )
      )
  );
$$;
revoke all on function public.can_access_investigations() from public, anon;
grant execute on function public.can_access_investigations() to authenticated;

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
  assigned_team jsonb
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
      select jsonb_agg(jsonb_build_object(
        'user_id', member.id,
        'full_name', member.full_name
      ) order by member.full_name)
      from public.investigation_team_members team
      join public.profiles member
        on member.id = team.user_id
        and member.organization_id = team.organization_id
      where team.organization_id = investigation.organization_id
        and team.severity_level = investigation.level
    ), '[]'::jsonb)
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

notify pgrst, 'reload schema';
