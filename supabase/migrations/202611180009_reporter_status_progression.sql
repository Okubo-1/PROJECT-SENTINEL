alter table sentinel_private.reporter_notifications
  drop constraint reporter_notifications_status_check;
alter table sentinel_private.reporter_notifications
  add constraint reporter_notifications_status_check
  check (status in ('investigation_assigned', 'investigated', 'closed', 'reopened'));

create or replace function sentinel_private.record_investigation_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.assigned_investigator_id is not null
      or (new.no_team_assigned is false and new.status::text in ('not_started', 'assigned')) then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigation_assigned');
    end if;
    if new.status::text = 'completed' then
      insert into sentinel_private.reporter_notifications(incident_id, status)
        values (new.incident_id, 'investigated');
    end if;
  else
    if new.assigned_investigator_id is not null
      and new.assigned_investigator_id is distinct from old.assigned_investigator_id
      and not (old.status::text = 'completed' and new.status::text = 'assigned') then
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
revoke all on function sentinel_private.record_investigation_notification()
  from public, anon, authenticated, service_role;

create function sentinel_private.record_reporter_reopen_notification()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
begin
  insert into sentinel_private.reporter_notifications(incident_id, status)
  values (new.incident_id, 'reopened');
  return new;
end;
$$;
revoke all on function sentinel_private.record_reporter_reopen_notification()
  from public, anon, authenticated, service_role;

create trigger incident_reopen_reporter_notification
  after insert on public.incident_reopen_events
  for each row execute function sentinel_private.record_reporter_reopen_notification();
