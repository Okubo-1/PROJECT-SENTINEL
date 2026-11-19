-- Anonymous reporting remains protected by incidents_anonymous_release_gate.
create function public.get_my_incidents()
returns setof public.incidents
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare
  organization uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select p.organization_id into organization from public.profiles p
    join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
    where p.id = auth.uid() and p.account_status = 'active';
  if organization is null or not public.safety_policy_access_allowed(organization)
    or not public.has_org_permission(organization, 'view_own_reports') then
    raise exception 'Not authorized to view reports' using errcode = '42501';
  end if;
  return query select i.* from public.incidents i
    where i.organization_id = organization and (
      (not i.is_anonymous and (i.created_by = auth.uid() or (i.status <> 'draft' and i.reported_by = auth.uid())))
      or (i.is_anonymous and i.id in (select sentinel_private.my_anonymous_incident_ids()))
    );
end;
$$;
revoke all on function public.get_my_incidents() from public, anon, service_role;
grant execute on function public.get_my_incidents() to authenticated;

create function public.can_view_own_anonymous_incident(target_organization_id uuid, target_incident_id uuid)
returns boolean language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if auth.uid() is null or not exists (
    select 1 from public.profiles p
    join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
    where p.id = auth.uid() and p.organization_id = target_organization_id and p.account_status = 'active'
  ) or not public.safety_policy_access_allowed(target_organization_id)
    or not public.has_org_permission(target_organization_id, 'view_own_reports') then
    return false;
  end if;
  return exists (select 1 from sentinel_private.my_anonymous_incident_ids() id where id = target_incident_id);
end;
$$;
revoke all on function public.can_view_own_anonymous_incident(uuid, uuid) from public, anon, service_role;
grant execute on function public.can_view_own_anonymous_incident(uuid, uuid) to authenticated;
create policy incidents_select_own_anonymous on public.incidents
for select to authenticated using (public.can_view_own_anonymous_incident(organization_id, id));

create table sentinel_private.reporter_notifications (
  id bigint generated always as identity primary key,
  incident_id uuid not null references public.incidents(id) on delete cascade,
  status text not null check (status in ('investigation_assigned', 'investigated', 'closed'))
);
alter table sentinel_private.reporter_notifications enable row level security;
alter table sentinel_private.reporter_notifications force row level security;
revoke all on sentinel_private.reporter_notifications from public, anon, authenticated, service_role;

create function sentinel_private.record_reporter_status_notification()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if new.status is distinct from old.status and new.status::text = 'closed' then
    insert into sentinel_private.reporter_notifications(incident_id, status) values (new.id, new.status::text);
  end if;
  return new;
end;
$$;
revoke all on function sentinel_private.record_reporter_status_notification() from public, anon, authenticated, service_role;
create trigger reporter_status_notification after update of status on public.incidents
for each row execute function sentinel_private.record_reporter_status_notification();

create function sentinel_private.record_reporter_assignment_notification()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if new.type::text = 'investigation' and new.incident_id is not null
    and exists (select 1 from public.incidents i where i.id = new.incident_id
      and i.organization_id = new.organization_id and i.status <> 'draft') then
    if tg_op = 'INSERT' then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigation_assigned');
    elsif new.assignee_id is distinct from old.assignee_id then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigation_assigned');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function sentinel_private.record_reporter_assignment_notification() from public, anon, authenticated, service_role;
create trigger reporter_assignment_notification after insert or update of assignee_id on public.actions
for each row execute function sentinel_private.record_reporter_assignment_notification();

create function sentinel_private.record_investigation_notification()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_investigator_id is not null then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigation_assigned');
    end if;
    if new.status::text = 'completed' then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigated');
    end if;
  else
    if new.assigned_investigator_id is not null
      and new.assigned_investigator_id is distinct from old.assigned_investigator_id then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigation_assigned');
    end if;
    if new.status::text = 'completed' and new.status is distinct from old.status then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigated');
    end if;
  end if;
  return new;
end;
$$;
revoke all on function sentinel_private.record_investigation_notification() from public, anon, authenticated, service_role;
create trigger reporter_investigation_notification after insert or update on public.investigations
for each row execute function sentinel_private.record_investigation_notification();

create function public.get_my_report_notifications()
returns table(incident_id uuid, status text)
language plpgsql stable security definer set search_path = pg_catalog, pg_temp
as $$
declare organization uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode = '42501'; end if;
  select p.organization_id into organization from public.profiles p
    join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
    where p.id = auth.uid() and p.account_status = 'active';
  if organization is null or not public.safety_policy_access_allowed(organization)
    or not public.has_org_permission(organization, 'view_own_reports') then
    raise exception 'Not authorized to view notifications' using errcode = '42501';
  end if;
  return query select n.incident_id, n.status
    from sentinel_private.reporter_notifications n
    join public.incidents i on i.id = n.incident_id
    where i.organization_id = organization and i.status <> 'draft'
      and case when i.is_anonymous
        then case when i.id in (select sentinel_private.my_anonymous_incident_ids())
          then sentinel_private.anonymous_notification_recipient(i.id) = auth.uid()
          else false end
        else i.reported_by = auth.uid()
      end
    order by n.id desc;
end;
$$;
revoke all on function public.get_my_report_notifications() from public, anon, service_role;
grant execute on function public.get_my_report_notifications() to authenticated;
notify pgrst, 'reload schema';
