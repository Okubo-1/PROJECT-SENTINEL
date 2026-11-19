-- Investigation extended fields: investigation analysis workflow columns.
-- This migration adds investigation domain columns for structured analysis.
--
-- Rollback guidance: Drop the following columns from the investigations table:
-- level, due_at, witness_statement, immediate_causes, root_cause_method,
-- root_cause_breakdown, root_causes_summary, contributing_factors, closed_at
-- after removing dependent application code.

alter table public.investigations
  add column level text,
  add column due_at timestamptz,
  add column witness_statement text check (witness_statement is null or char_length(btrim(witness_statement)) between 1 and 10000),
  add column immediate_causes text check (immediate_causes is null or char_length(btrim(immediate_causes)) between 1 and 5000),
  add column root_cause_method text check (root_cause_method is null or char_length(btrim(root_cause_method)) <= 100),
  add column root_cause_breakdown jsonb default '[]'::jsonb,
  add column root_causes_summary text check (root_causes_summary is null or char_length(btrim(root_causes_summary)) between 1 and 10000),
  add column contributing_factors text check (contributing_factors is null or char_length(btrim(contributing_factors)) between 1 and 10000),
  add column closed_at timestamptz;

create index investigations_organization_id_level_idx
  on public.investigations(organization_id, level)
  where level is not null;

create index investigations_organization_id_due_at_idx
  on public.investigations(organization_id, due_at)
  where due_at is not null and status != 'completed';

create index investigations_organization_id_root_cause_method_idx
  on public.investigations(organization_id, root_cause_method)
  where root_cause_method is not null;

create or replace function public.update_investigation_due_at()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  deadline_hours integer;
  incident_severity text;
begin
  if new.level is distinct from old.level and new.level is not null then
    select case lower(new.level)
      when 'critical' then d.critical_hours
      when 'high' then d.high_hours
      when 'medium' then d.medium_hours
      when 'low' then d.low_hours
      else null
    end
    into deadline_hours
    from public.investigation_deadlines d
    where d.organization_id = new.organization_id
    limit 1;

    if deadline_hours is null then
      deadline_hours := case lower(new.level)
        when 'critical' then 24
        when 'high' then 72
        when 'medium' then 168
        when 'low' then 336
        else 72
      end;
    end if;

    new.due_at := new.created_at + (deadline_hours || ' hours')::interval;
  end if;

  return new;
end;
$$;

create trigger investigations_update_due_at
before insert or update on public.investigations
for each row execute function public.update_investigation_due_at();

revoke all on function public.update_investigation_due_at() from public, anon, authenticated;

notify pgrst, 'reload schema';
