create table public.inspections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  site_id uuid not null,
  inspection_title text not null check (char_length(btrim(inspection_title)) between 3 and 160),
  description text not null check (char_length(btrim(description)) > 0),
  findings text not null check (char_length(btrim(findings)) > 0),
  inspected_by uuid not null,
  inspection_date timestamptz not null default now(),
  file_storage_path text,
  file_name text,
  file_type text,
  file_size bigint,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (site_id, organization_id) references public.sites(id, organization_id) on delete restrict,
  foreign key (inspected_by, organization_id) references public.profiles(id, organization_id) on delete restrict,
  check ((file_storage_path is null and file_name is null and file_type is null and file_size is null)
    or (file_storage_path is not null and file_name is not null and file_type is not null and file_size between 1 and 10485760))
);

create table public.actions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type text not null check (type in ('preventive', 'corrective')),
  description text not null check (char_length(btrim(description)) > 0),
  site_id uuid not null,
  assignee_id uuid not null,
  created_by uuid not null,
  due_at timestamptz not null,
  status text not null default 'open' check (status in ('open', 'resolved')),
  resolved_at timestamptz,
  resolved_by uuid,
  resolution_notes text,
  proof_storage_path text,
  proof_file_name text,
  proof_file_type text,
  proof_file_size bigint,
  assigned_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, organization_id),
  foreign key (site_id, organization_id) references public.sites(id, organization_id) on delete restrict,
  foreign key (assignee_id, organization_id) references public.profiles(id, organization_id) on delete restrict,
  foreign key (created_by, organization_id) references public.profiles(id, organization_id) on delete restrict,
  foreign key (resolved_by, organization_id) references public.profiles(id, organization_id) on delete restrict,
  check ((status = 'open' and resolved_at is null and resolved_by is null)
    or (status = 'resolved' and resolved_at is not null and resolved_by is not null)),
  check ((proof_storage_path is null and proof_file_name is null and proof_file_type is null and proof_file_size is null)
    or (proof_storage_path is not null and proof_file_name is not null and proof_file_type is not null and proof_file_size between 1 and 10485760))
);

create index inspections_organization_id_idx on public.inspections (organization_id);
create index inspections_site_id_idx on public.inspections (site_id);
create index inspections_inspected_by_idx on public.inspections (inspected_by);
create index inspections_inspection_date_idx on public.inspections (inspection_date desc);
create index inspections_created_at_idx on public.inspections (created_at desc);
create index actions_organization_id_idx on public.actions (organization_id);
create index actions_site_id_idx on public.actions (site_id);
create index actions_assignee_id_idx on public.actions (assignee_id);
create index actions_status_idx on public.actions (status);
create index actions_type_idx on public.actions (type);
create index actions_due_at_idx on public.actions (due_at);
create index actions_created_at_idx on public.actions (created_at desc);
create unique index activity_logs_notification_key_uidx
  on public.activity_logs ((metadata ->> 'notification_key'))
  where left(metadata ->> 'notification_key', 7) = 'action_';

create or replace function public.has_inspection_action_permission(target_organization_id uuid, target_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships membership
    join public.profiles profile on profile.id = membership.user_id and profile.organization_id = membership.organization_id
    where membership.user_id = (select auth.uid()) and membership.organization_id = target_organization_id
      and profile.account_status = 'active'
      and (
        membership.role in ('Super Administrator', 'Organization Administrator')
        or (target_permission = 'create_inspection' and membership.role = 'Safety Officer / HSE Officer')
        or (target_permission = 'manage_actions' and membership.role = 'Safety Officer / HSE Officer')
        or exists (
          select 1 from public.custom_roles custom_role
          where custom_role.organization_id = membership.organization_id
            and custom_role.name = membership.role and custom_role.is_active
            and custom_role.permissions ? target_permission
        )
      )
  );
$$;

create or replace function public.can_view_action(target_organization_id uuid, target_action_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.actions action
    where action.id = target_action_id and action.organization_id = target_organization_id
      and public.is_org_member(target_organization_id)
      and (public.has_inspection_action_permission(target_organization_id, 'manage_actions') or action.assignee_id = (select auth.uid()))
  );
$$;

create or replace function public.set_inspection_ownership()
returns trigger language plpgsql security definer set search_path = public as $$
declare current_organization_id uuid;
begin
  select profile.organization_id into current_organization_id
  from public.profiles profile join public.memberships membership
    on membership.user_id = profile.id and membership.organization_id = profile.organization_id
  where profile.id = (select auth.uid()) and profile.account_status = 'active';
  if current_organization_id is null then raise exception 'An active organization membership is required'; end if;
  if tg_op = 'INSERT' then
    new.organization_id := current_organization_id;
    new.inspected_by := (select auth.uid());
  elsif new.organization_id <> old.organization_id or new.inspected_by <> old.inspected_by or new.created_at <> old.created_at then
    raise exception 'Inspection ownership fields cannot be changed';
  elsif new.site_id is distinct from old.site_id
    or new.inspection_title is distinct from old.inspection_title
    or new.description is distinct from old.description
    or new.findings is distinct from old.findings
    or new.inspection_date is distinct from old.inspection_date then
    raise exception 'Inspection details cannot be changed';
  elsif old.file_storage_path is not null and (
    new.file_storage_path is distinct from old.file_storage_path
    or new.file_name is distinct from old.file_name
    or new.file_type is distinct from old.file_type
    or new.file_size is distinct from old.file_size
  ) then
    raise exception 'Inspection evidence cannot be changed';
  elsif old.file_storage_path is null and new.file_storage_path is not null
    and new.file_storage_path not like current_organization_id::text || '/inspections/' || new.id::text || '/' || (select auth.uid())::text || '/%' then
    raise exception 'Inspection evidence path is invalid';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger inspections_set_ownership before insert or update on public.inspections
for each row execute function public.set_inspection_ownership();

create or replace function public.set_action_ownership_and_resolution()
returns trigger language plpgsql security definer set search_path = public as $$
declare current_organization_id uuid; can_manage boolean; can_override boolean;
begin
  select profile.organization_id into current_organization_id
  from public.profiles profile join public.memberships membership
    on membership.user_id = profile.id and membership.organization_id = profile.organization_id
  where profile.id = (select auth.uid()) and profile.account_status = 'active';
  if current_organization_id is null then raise exception 'An active organization membership is required'; end if;
  can_manage := public.has_inspection_action_permission(current_organization_id, 'manage_actions');
  select exists (
    select 1 from public.memberships membership
    where membership.user_id = (select auth.uid())
      and membership.organization_id = current_organization_id
      and membership.role in ('Super Administrator', 'Organization Administrator')
  ) into can_override;

  if tg_op = 'INSERT' then
    if not can_manage then raise exception 'You are not authorized to create actions'; end if;
    if new.due_at <= now() then raise exception 'The due date and time must be in the future'; end if;
    if not exists (
      select 1 from public.memberships membership join public.profiles profile on profile.id = membership.user_id
      where membership.user_id = new.assignee_id and membership.organization_id = current_organization_id and profile.account_status = 'active'
    ) then raise exception 'The assignee must be an active member of this organization'; end if;
    new.organization_id := current_organization_id;
    new.created_by := (select auth.uid());
    new.status := 'open'; new.resolved_at := null; new.resolved_by := null; new.assigned_at := now();
  else
    if new.organization_id <> old.organization_id or new.created_by <> old.created_by or new.created_at <> old.created_at then
      raise exception 'Action ownership fields cannot be changed';
    end if;
    if old.status = 'resolved' then raise exception 'Resolved actions cannot be changed'; end if;
    if new.type is distinct from old.type
      or new.description is distinct from old.description
      or new.site_id is distinct from old.site_id
      or new.due_at is distinct from old.due_at
      or new.assignee_id is distinct from old.assignee_id and not can_manage then
      raise exception 'Action details cannot be changed';
    end if;
    if new.status = 'open' and (new.resolution_notes is distinct from old.resolution_notes
      or new.proof_storage_path is distinct from old.proof_storage_path
      or new.proof_file_name is distinct from old.proof_file_name
      or new.proof_file_type is distinct from old.proof_file_type
      or new.proof_file_size is distinct from old.proof_file_size) then
      raise exception 'Resolution details can only be submitted when resolving an action';
    end if;
    if new.assignee_id is distinct from old.assignee_id then
      if not can_manage then raise exception 'Only an action manager can reassign this action'; end if;
      if not exists (
        select 1 from public.memberships membership join public.profiles profile on profile.id = membership.user_id
        where membership.user_id = new.assignee_id and membership.organization_id = old.organization_id and profile.account_status = 'active'
      ) then raise exception 'The assignee must be an active member of this organization'; end if;
      new.assigned_at := now();
    else new.assigned_at := old.assigned_at;
    end if;
    if new.status = 'resolved' and old.status = 'open' then
      if old.assignee_id <> (select auth.uid()) and not can_override then
        raise exception 'Only the assigned user or an administrator can resolve this action';
      end if;
      if new.proof_storage_path is not null and new.proof_storage_path not like current_organization_id::text || '/actions/' || new.id::text || '/' || (select auth.uid())::text || '/%' then
        raise exception 'Action proof path is invalid';
      end if;
      new.resolved_at := now(); new.resolved_by := (select auth.uid());
    elsif new.status is distinct from old.status then raise exception 'Invalid action status transition';
    else new.resolved_at := null; new.resolved_by := null;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger actions_set_ownership_and_resolution before insert or update on public.actions
for each row execute function public.set_action_ownership_and_resolution();

create or replace function public.log_inspection_action_events()
returns trigger language plpgsql security definer set search_path = public as $$
declare actor_id uuid := (select auth.uid());
begin
  if tg_table_name = 'inspections' then
    insert into public.activity_logs (organization_id, user_id, activity, metadata)
    values (new.organization_id, actor_id, 'Inspection created', jsonb_build_object(
      'event_code', 'inspection_created', 'entity_type', 'inspection', 'entity_id', new.id, 'site_id', new.site_id, 'notification_ready', false));
    return new;
  end if;
  if tg_op = 'INSERT' then
    insert into public.activity_logs (organization_id, user_id, activity, metadata)
    values (new.organization_id, actor_id, 'Action created', jsonb_build_object(
      'event_code', 'action_created', 'entity_type', 'action', 'entity_id', new.id, 'site_id', new.site_id, 'notification_ready', false));
    insert into public.activity_logs (organization_id, user_id, activity, metadata)
    values (new.organization_id, actor_id, 'Action assigned', jsonb_build_object(
      'event_code', 'action_assigned', 'entity_type', 'action', 'entity_id', new.id, 'recipient_id', new.assignee_id,
      'notification_key', 'action_assigned:' || new.id || ':' || new.assignee_id || ':' || new.assigned_at, 'notification_ready', true));
  else
    if new.assignee_id is distinct from old.assignee_id then
      insert into public.activity_logs (organization_id, user_id, activity, metadata)
      values (new.organization_id, actor_id, 'Action reassigned', jsonb_build_object(
        'event_code', 'action_reassigned', 'entity_type', 'action', 'entity_id', new.id, 'previous_assignee_id', old.assignee_id,
        'recipient_id', new.assignee_id, 'notification_key', 'action_assigned:' || new.id || ':' || new.assignee_id || ':' || new.assigned_at,
        'notification_ready', true));
    end if;
    if old.status = 'open' and new.status = 'resolved' then
      insert into public.activity_logs (organization_id, user_id, activity, metadata)
      values (new.organization_id, actor_id, 'Action resolved', jsonb_build_object(
        'event_code', case when old.assignee_id = actor_id then 'action_resolved' else 'action_overridden' end,
        'entity_type', 'action', 'entity_id', new.id, 'assignee_id', old.assignee_id, 'resolved_by', actor_id, 'notification_ready', false));
    end if;
  end if;
  return new;
end;
$$;

create trigger inspections_log_created after insert on public.inspections
for each row execute function public.log_inspection_action_events();
create trigger actions_log_events after insert or update on public.actions
for each row execute function public.log_inspection_action_events();

alter table public.inspections enable row level security;
alter table public.actions enable row level security;

create policy inspections_select_authorized on public.inspections for select to authenticated
using (public.is_org_member(organization_id) and public.has_inspection_action_permission(organization_id, 'create_inspection'));
create policy inspections_insert_authorized on public.inspections for insert to authenticated
with check (public.has_inspection_action_permission(organization_id, 'create_inspection') and inspected_by = (select auth.uid()));
create policy inspections_update_authorized on public.inspections for update to authenticated
using (public.has_inspection_action_permission(organization_id, 'create_inspection'))
with check (public.has_inspection_action_permission(organization_id, 'create_inspection'));

create policy actions_select_authorized on public.actions for select to authenticated
using (public.can_view_action(organization_id, id));
create policy actions_insert_authorized on public.actions for insert to authenticated
with check (public.has_inspection_action_permission(organization_id, 'manage_actions') and created_by = (select auth.uid()) and status = 'open');
create policy actions_update_authorized on public.actions for update to authenticated
using (public.can_view_action(organization_id, id)
  and (public.has_inspection_action_permission(organization_id, 'manage_actions') or assignee_id = (select auth.uid())))
with check (public.is_org_member(organization_id)
  and (public.has_inspection_action_permission(organization_id, 'manage_actions') or assignee_id = (select auth.uid())));

revoke all on public.inspections, public.actions from public, anon, authenticated;
grant select, insert, update on public.inspections, public.actions to authenticated;

insert into storage.buckets (id, name, public, file_size_limit)
values ('incident-evidence', 'incident-evidence', false, 10485760)
on conflict (id) do update
set name = excluded.name, public = excluded.public, file_size_limit = excluded.file_size_limit;

create policy inspection_action_evidence_select on storage.objects for select to authenticated
using (
  bucket_id = 'incident-evidence'
  and (storage.foldername(name))[1] = (select profile.organization_id::text from public.profiles profile where profile.id = (select auth.uid()))
  and (((storage.foldername(name))[2] = 'inspections' and exists (
    select 1 from public.inspections inspection where inspection.id::text = (storage.foldername(name))[3]
      and inspection.organization_id::text = (storage.foldername(name))[1]
      and public.has_inspection_action_permission(inspection.organization_id, 'create_inspection')))
    or ((storage.foldername(name))[2] = 'actions' and public.can_view_action(
      (storage.foldername(name))[1]::uuid, (storage.foldername(name))[3]::uuid)))
);
create policy inspection_action_evidence_insert on storage.objects for insert to authenticated
with check (
  bucket_id = 'incident-evidence'
  and (storage.foldername(name))[1] = (select profile.organization_id::text from public.profiles profile where profile.id = (select auth.uid()))
  and (storage.foldername(name))[4] = (select auth.uid())::text
  and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 10485760
  and coalesce(metadata ->> 'mimetype', '') in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
  and (((storage.foldername(name))[2] = 'inspections' and exists (
    select 1 from public.inspections inspection where inspection.id::text = (storage.foldername(name))[3]
      and inspection.organization_id::text = (storage.foldername(name))[1]
      and public.has_inspection_action_permission(inspection.organization_id, 'create_inspection')))
    or ((storage.foldername(name))[2] = 'actions' and public.can_view_action(
      (storage.foldername(name))[1]::uuid, (storage.foldername(name))[3]::uuid)))
);
create policy inspection_action_evidence_delete_unattached on storage.objects for delete to authenticated
using (
  bucket_id = 'incident-evidence'
  and (storage.foldername(name))[1] = (select profile.organization_id::text from public.profiles profile where profile.id = (select auth.uid()))
  and (storage.foldername(name))[4] = (select auth.uid())::text
  and (((storage.foldername(name))[2] = 'inspections' and exists (
    select 1 from public.inspections inspection where inspection.id::text = (storage.foldername(name))[3]
      and inspection.organization_id::text = (storage.foldername(name))[1]
      and inspection.file_storage_path is distinct from name
      and public.has_inspection_action_permission(inspection.organization_id, 'create_inspection')))
    or ((storage.foldername(name))[2] = 'actions' and exists (
      select 1 from public.actions action where action.id::text = (storage.foldername(name))[3]
        and action.organization_id::text = (storage.foldername(name))[1]
        and action.status = 'open' and action.proof_storage_path is distinct from name
        and public.can_view_action(action.organization_id, action.id))))
);

create or replace function public.process_action_notifications()
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.activity_logs (organization_id, user_id, activity, metadata)
  select action.organization_id, action.assignee_id, 'Action due', jsonb_build_object(
    'event_code', 'action_due', 'entity_type', 'action', 'entity_id', action.id, 'recipient_id', action.assignee_id,
    'notification_key', 'action_due:' || action.id || ':' || action.assignee_id, 'notification_ready', true)
  from public.actions action where action.status = 'open' and action.due_at <= now()
  on conflict do nothing;
  insert into public.activity_logs (organization_id, user_id, activity, metadata)
  select action.organization_id, action.assignee_id, 'Action overdue', jsonb_build_object(
    'event_code', 'action_overdue', 'entity_type', 'action', 'entity_id', action.id, 'recipient_id', action.assignee_id,
    'notification_key', 'action_overdue:' || action.id || ':' || action.assignee_id, 'notification_ready', true)
  from public.actions action where action.status = 'open' and action.due_at < now()
  on conflict do nothing;
end;
$$;

create or replace function public.get_inspection_action_metrics(p_since timestamptz default null, p_site_id uuid default null)
returns table (inspections_completed bigint, open_corrective_actions bigint, overdue_actions bigint)
language sql stable security definer set search_path = public as $$
  with current_organization as (
    select profile.organization_id
    from public.profiles profile
    join public.memberships membership
      on membership.user_id = profile.id and membership.organization_id = profile.organization_id
    where profile.id = (select auth.uid()) and profile.account_status = 'active'
  )
  select
    (select count(*) from public.inspections inspection, current_organization organization
      where inspection.organization_id = organization.organization_id
        and (p_since is null or inspection.inspection_date >= p_since)
        and (p_site_id is null or inspection.site_id = p_site_id)),
    (select count(*) from public.actions action, current_organization organization
      where action.organization_id = organization.organization_id and action.status = 'open'
        and action.type = 'corrective' and action.due_at >= now()
        and (p_site_id is null or action.site_id = p_site_id)),
    (select count(*) from public.actions action, current_organization organization
      where action.organization_id = organization.organization_id and action.status = 'open'
        and action.due_at < now() and (p_site_id is null or action.site_id = p_site_id));
$$;

revoke all on function public.has_inspection_action_permission(uuid, text) from public, anon;
revoke all on function public.can_view_action(uuid, uuid) from public, anon;
revoke all on function public.set_inspection_ownership() from public, anon, authenticated;
revoke all on function public.set_action_ownership_and_resolution() from public, anon, authenticated;
revoke all on function public.log_inspection_action_events() from public, anon, authenticated;
revoke all on function public.process_action_notifications() from public, anon, authenticated;
revoke all on function public.get_inspection_action_metrics(timestamptz, uuid) from public, anon;
grant execute on function public.has_inspection_action_permission(uuid, text) to authenticated;
grant execute on function public.can_view_action(uuid, uuid) to authenticated;
grant execute on function public.process_action_notifications() to service_role;
grant execute on function public.get_inspection_action_metrics(timestamptz, uuid) to authenticated;

create extension if not exists pg_cron;
select cron.schedule('sentinel-action-notifications', '* * * * *', 'select public.process_action_notifications()')
where not exists (select 1 from cron.job where jobname = 'sentinel-action-notifications');