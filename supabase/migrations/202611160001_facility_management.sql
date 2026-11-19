-- Preserve existing site facilities and their incident references.
alter table public.company_settings
  add column if not exists weather_conditions jsonb not null default '["Sunny","Rainy"]'::jsonb
  check (jsonb_typeof(weather_conditions) = 'array');

alter table public.facilities
  alter column site_id drop not null,
  add column if not exists department_key text,
  add column if not exists active boolean not null default true,
  add column if not exists archived_at timestamptz;

alter table public.facilities
  add constraint facilities_one_parent check (
    (site_id is not null and department_key is null)
    or (site_id is null and nullif(btrim(department_key), '') is not null)
  ),
  add constraint facilities_site_same_organization foreign key (site_id, organization_id)
    references public.sites (id, organization_id) on delete restrict;

create unique index facilities_active_site_name_idx
  on public.facilities (organization_id, site_id, lower(btrim(name)))
  where site_id is not null and archived_at is null;
create unique index facilities_active_department_name_idx
  on public.facilities (organization_id, department_key, lower(btrim(name)))
  where department_key is not null and archived_at is null;

create or replace function public.validate_facility_parent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  configured_departments jsonb;
  items jsonb;
begin
  if nullif(btrim(new.name), '') is null then
    raise exception 'Facility name is required.';
  end if;
  if tg_op = 'UPDATE' then
    if new.organization_id is distinct from old.organization_id
      or new.site_id is distinct from old.site_id
      or new.department_key is distinct from old.department_key then
      raise exception 'A facility cannot be moved to another parent.';
    end if;
    return new;
  end if;
  if new.department_key is not null then
    select departments into configured_departments from public.company_settings where organization_id = new.organization_id;
    items := case
      when jsonb_typeof(configured_departments) = 'array' then configured_departments
      when jsonb_typeof(configured_departments->'items') = 'array' then configured_departments->'items'
      when jsonb_typeof(configured_departments->'departments') = 'array' then configured_departments->'departments'
      else '[]'::jsonb
    end;
    if not exists (
      select 1 from jsonb_array_elements(items) item
      where coalesce(nullif(item->>'id', ''), 'legacy:department:' || lower(btrim(item->>'name'))) = new.department_key
        and coalesce(item->>'active', 'true') <> 'false'
        and coalesce(item->>'deleted', 'false') <> 'true'
    ) then
      raise exception 'The selected department is not active for this organization.';
    end if;
  elsif not exists (
    select 1 from public.sites s
    join public.company_settings c on c.organization_id = s.organization_id
    where s.id = new.site_id and s.organization_id = new.organization_id
      and public.company_setting_has_active_name(c.operational_sites, s.name)
  ) then
    raise exception 'The selected site is not active for this organization.';
  end if;
  return new;
end;
$$;

create trigger facilities_validate_parent
  before insert or update on public.facilities
  for each row execute function public.validate_facility_parent();
revoke all on function public.validate_facility_parent() from public, anon, authenticated;

alter table public.incidents add column if not exists location_type text
  check (location_type in ('site', 'department'));

create or replace function public.validate_incident_company_configuration()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  configured_settings public.company_settings;
  configured_site_name text;
  unchanged boolean := false;
begin
  if tg_op = 'UPDATE' then unchanged := not (old.status = 'draft' and new.status = 'submitted'); end if;
  select * into configured_settings from public.company_settings where organization_id = new.organization_id;
  if new.site_id is not null then
    new.location_type := 'site';
  elsif nullif(btrim(new.department), '') is not null then
    new.location_type := 'department';
  else
    new.location_type := null;
  end if;
  if new.status = 'submitted' and (
    new.location_type is null or nullif(btrim(new.severity), '') is null
    or nullif(btrim(new.incident_category), '') is null
  ) then
    raise exception 'Submitted incidents require a location, severity, and incident category.';
  end if;
  if new.status = 'submitted' and (tg_op = 'INSERT' or old.status = 'draft') then
    if nullif(btrim(new.weather_conditions), '') is null
      or not exists (
        select 1 from jsonb_array_elements_text(configured_settings.weather_conditions) weather
        where lower(btrim(weather)) = lower(btrim(new.weather_conditions))
      ) then
      raise exception 'Select a configured weather condition.';
    end if;
    if nullif(btrim(new.shift), '') is null then
      raise exception 'Select a configured shift.';
    end if;
  end if;
  if new.site_id is not null then
    select name into configured_site_name from public.sites where id = new.site_id and organization_id = new.organization_id;
    if configured_site_name is null or
      (not public.company_setting_has_active_name(configured_settings.operational_sites, configured_site_name)
        and not (unchanged and new.site_id is not distinct from old.site_id)) then
      raise exception 'The selected site is not active for this organization.';
    end if;
  end if;
  if nullif(btrim(new.department), '') is not null
    and not public.company_setting_has_active_name(configured_settings.departments, new.department)
    and not (unchanged and new.department is not distinct from old.department) then
    raise exception 'The selected department is not active for this organization.';
  end if;
  if nullif(btrim(new.shift), '') is not null
    and not public.company_setting_has_active_name(configured_settings.working_hours->'shifts', new.shift)
    and not (unchanged and new.shift is not distinct from old.shift) then
    raise exception 'The selected shift is not active for this organization.';
  end if;
  if nullif(btrim(new.severity), '') is not null
    and not public.company_setting_has_active_name(configured_settings.severity_levels, new.severity)
    and not (unchanged and new.severity is not distinct from old.severity) then
    raise exception 'The selected severity is not active for this organization.';
  end if;
  if nullif(btrim(new.potential_severity), '') is not null
    and not public.company_setting_has_active_name(configured_settings.severity_levels, new.potential_severity)
    and not (unchanged and new.potential_severity is not distinct from old.potential_severity) then
    raise exception 'The selected potential severity is not active for this organization.';
  end if;
  if nullif(btrim(new.incident_category), '') is not null
    and not public.company_setting_has_active_name(configured_settings.incident_categories, new.incident_category)
    and not (unchanged and new.incident_category is not distinct from old.incident_category) then
    raise exception 'The selected incident category is not active for this organization.';
  end if;
  return new;
end;
$$;

create or replace function public.validate_incident_facility_parent()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  selected_department_key text;
  departments jsonb;
begin
  if new.site_id is null and nullif(btrim(new.department), '') is not null then
    select c.departments into departments from public.company_settings c where c.organization_id = new.organization_id;
    departments := case
      when jsonb_typeof(departments) = 'array' then departments
      when jsonb_typeof(departments->'items') = 'array' then departments->'items'
      when jsonb_typeof(departments->'departments') = 'array' then departments->'departments'
      else '[]'::jsonb end;
    select coalesce(nullif(item->>'id', ''), 'legacy:department:' || lower(btrim(item->>'name')))
      into selected_department_key from jsonb_array_elements(departments) item
      where lower(btrim(item->>'name')) = lower(btrim(new.department)) limit 1;
  end if;
  if new.status = 'submitted' and new.site_id is not null and nullif(btrim(new.department), '') is not null
    and (tg_op = 'INSERT' or old.status = 'draft') then
    raise exception 'Select either a site or a department.';
  end if;
  if new.status = 'submitted' and new.facility_id is null
    and (tg_op = 'INSERT' or old.status = 'draft')
    and exists (
      select 1 from public.facilities f
      where f.organization_id = new.organization_id
        and ((new.site_id is not null and f.site_id = new.site_id) or (new.site_id is null and f.department_key = selected_department_key))
        and f.active and f.archived_at is null
    ) then
    raise exception 'Select an active facility for this site.';
  end if;
  if new.facility_id is null then return new; end if;
  if tg_op = 'UPDATE' then
    if new.facility_id is not distinct from old.facility_id
      and new.site_id is not distinct from old.site_id
      and new.department is not distinct from old.department
      and old.status <> 'draft' then return new; end if;
  end if;
  if not exists (
    select 1 from public.facilities f
    where f.id = new.facility_id and f.organization_id = new.organization_id
      and ((new.site_id is not null and f.site_id = new.site_id) or (new.site_id is null and f.department_key = selected_department_key))
      and f.active and f.archived_at is null
  ) then
    raise exception 'The selected facility is not active for the selected site.';
  end if;
  return new;
end;
$$;
create trigger incidents_validate_facility_parent
  before insert or update on public.incidents
  for each row execute function public.validate_incident_facility_parent();
revoke all on function public.validate_incident_facility_parent() from public, anon, authenticated;

-- Facility deletion is intentionally disabled: historical references remain intact.
revoke delete on public.facilities from authenticated;

notify pgrst, 'reload schema';
