do $$
begin
  if to_regclass('public.organizations') is null
    or to_regclass('public.profiles') is null
    or to_regclass('public.memberships') is null
    or to_regclass('public.custom_roles') is null
    or to_regclass('public.activity_logs') is null
    or to_regclass('public.incidents') is null
    or to_regclass('public.corrective_actions') is null
    or to_regclass('public.investigations') is null
    or to_regclass('public.investigation_root_causes') is null then
    raise exception 'Incident closure prerequisites are missing; reconcile the base schema first';
  end if;

  if to_regprocedure('public.is_org_member(uuid)') is null
    or to_regprocedure('public.has_org_role(uuid, text[])') is null
    or to_regprocedure('public.has_org_role(uuid, membership_role[])') is null
    or to_regprocedure('public.is_builtin_role_name(text)') is null
    or to_regprocedure('public.can_view_incident(uuid, uuid)') is null
    or to_regprocedure('public.enforce_incident_workflow_transition()') is null
    or to_regprocedure('public.enforce_corrective_action_parent_integrity()') is null
    or to_regprocedure('public.close_incident(uuid)') is null then
    raise exception 'Incident closure prerequisite function signatures are missing';
  end if;

  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.incidents'::regclass
      and contype = 'u'
      and pg_get_constraintdef(oid) = 'UNIQUE (id, organization_id)'
  ) then
    raise exception 'The incidents organization-scoped unique key is missing';
  end if;

  if (
    select count(*)
    from information_schema.columns
    where (table_schema, table_name, column_name) in (
      ('public', 'profiles', 'account_status'),
      ('public', 'profiles', 'full_name'),
      ('public', 'profiles', 'organization_id'),
      ('public', 'memberships', 'organization_id'),
      ('public', 'memberships', 'user_id'),
      ('public', 'memberships', 'role'),
      ('public', 'custom_roles', 'organization_id'),
      ('public', 'custom_roles', 'name'),
      ('public', 'custom_roles', 'is_active'),
      ('public', 'activity_logs', 'organization_id'),
      ('public', 'activity_logs', 'user_id'),
      ('public', 'activity_logs', 'activity'),
      ('public', 'activity_logs', 'metadata'),
      ('public', 'incidents', 'id'),
      ('public', 'incidents', 'organization_id'),
      ('public', 'incidents', 'status'),
      ('public', 'incidents', 'created_by'),
      ('public', 'incidents', 'reported_by'),
      ('public', 'corrective_actions', 'id'),
      ('public', 'corrective_actions', 'organization_id'),
      ('public', 'corrective_actions', 'incident_id'),
      ('public', 'corrective_actions', 'investigation_id'),
      ('public', 'corrective_actions', 'status'),
      ('public', 'corrective_actions', 'created_at'),
      ('public', 'corrective_actions', 'title'),
      ('public', 'corrective_actions', 'description'),
      ('public', 'investigations', 'id'),
      ('public', 'investigations', 'organization_id'),
      ('public', 'investigations', 'incident_id'),
      ('public', 'investigations', 'status'),
      ('public', 'investigations', 'created_at'),
      ('public', 'investigation_root_causes', 'organization_id'),
      ('public', 'investigation_root_causes', 'investigation_id'),
      ('public', 'investigation_root_causes', 'root_cause_statement'),
      ('public', 'investigation_root_causes', 'created_at')
    )
  ) <> 35 then
    raise exception 'Incident closure prerequisite columns are missing';
  end if;

end;
$$;

create table if not exists public.incident_closure_delegates (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  granted_role text not null,
  granted_by uuid not null references auth.users(id) on delete restrict,
  granted_at timestamptz not null default now(),
  primary key (organization_id, user_id)
);

do $$
declare
  function_definition text;
  is_security_definer boolean;
  function_settings text[];
begin
  if to_regprocedure('public.can_close_incidents(uuid)') is null then
    execute $ddl$
      create function public.can_close_incidents(target_organization_id uuid)
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select exists (
          select 1 from public.memberships m
          join public.profiles p on p.id = m.user_id and p.organization_id = m.organization_id
          where m.user_id = auth.uid() and m.organization_id = target_organization_id
            and p.account_status = 'active'
            and (public.is_builtin_role_name(m.role) or exists (
              select 1 from public.custom_roles cr where cr.organization_id = m.organization_id
                and cr.name = m.role and cr.is_active
            ))
            and (m.role = 'Super Administrator' or exists (
              select 1 from public.incident_closure_delegates d
              where d.organization_id = m.organization_id and d.user_id = m.user_id
                and d.granted_role = m.role
            ))
        );
      $body$;
    $ddl$;
  else
    select pg_get_functiondef(proc.oid), proc.prosecdef, proc.proconfig
    into function_definition, is_security_definer, function_settings
    from pg_proc proc
    where proc.oid = to_regprocedure('public.can_close_incidents(uuid)');
    if not is_security_definer
      or function_settings is null
      or array_position(function_settings, 'search_path=public') is null
      or position('incident_closure_delegates' in function_definition) = 0 then
      raise exception 'Existing can_close_incidents(uuid) is incompatible; inspect it before reconciling';
    end if;
  end if;
end;
$$;
revoke all on function public.can_close_incidents(uuid) from public, anon;
grant execute on function public.can_close_incidents(uuid) to authenticated;

alter table public.incident_closure_delegates enable row level security;
revoke all on public.incident_closure_delegates from public, anon, authenticated;
grant select on public.incident_closure_delegates to authenticated;
drop policy if exists incident_closure_delegates_read on public.incident_closure_delegates;
create policy incident_closure_delegates_read on public.incident_closure_delegates
for select to authenticated using (
  public.is_org_member(organization_id)
  and (user_id = auth.uid() or public.has_org_role(organization_id, array['Super Administrator']::text[]))
);

create or replace function public.invalidate_incident_closure_delegation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    delete from public.incident_closure_delegates
    where organization_id = old.organization_id and user_id = old.user_id;
    return old;
  end if;
  if new.role is distinct from old.role
    or new.organization_id is distinct from old.organization_id
    or new.user_id is distinct from old.user_id then
    delete from public.incident_closure_delegates
    where organization_id = old.organization_id and user_id = old.user_id;
  end if;
  return new;
end;
$$;
revoke all on function public.invalidate_incident_closure_delegation() from public, anon, authenticated;
do $$
declare
  existing_function oid;
  existing_trigger_type smallint;
  existing_trigger_enabled text;
begin
  select tgfoid, tgtype, tgenabled
  into existing_function, existing_trigger_type, existing_trigger_enabled
  from pg_trigger
  where tgrelid = 'public.memberships'::regclass
    and tgname = 'memberships_invalidate_incident_closure_delegation'
    and not tgisinternal;

  if not found then
    execute $ddl$
      create trigger memberships_invalidate_incident_closure_delegation
      after update or delete on public.memberships
      for each row execute function public.invalidate_incident_closure_delegation()
    $ddl$;
  elsif existing_function <> to_regprocedure('public.invalidate_incident_closure_delegation()')::oid
    or existing_trigger_type <> 25
    or existing_trigger_enabled <> 'O' then
    raise exception 'Existing membership invalidation trigger is incompatible; inspect it before reconciling';
  end if;
end;
$$;

create or replace function public.list_incident_closure_candidates()
returns table(user_id uuid, full_name text, role text, account_status text, delegated boolean)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  select p.organization_id into org_id
  from public.profiles p
  where p.id = auth.uid() and p.account_status = 'active';
  if org_id is null or not public.has_org_role(org_id, array['Super Administrator']::text[]) then
    raise exception 'Only the Super Administrator can manage incident closure delegates'
      using errcode = '42501';
  end if;
  return query
  select p.id, p.full_name, m.role, p.account_status::text,
    coalesce(d.granted_role = m.role, false)
  from public.profiles p
  join public.memberships m on m.user_id = p.id and m.organization_id = p.organization_id
  left join public.incident_closure_delegates d
    on d.user_id = p.id and d.organization_id = p.organization_id
  where p.organization_id = org_id
    and (public.is_builtin_role_name(m.role) or exists (
      select 1 from public.custom_roles cr
      where cr.organization_id = org_id and cr.name = m.role and cr.is_active
    ))
  order by p.full_name, p.id;
end;
$$;

create or replace function public.set_incident_closure_delegate(p_user_id uuid, p_enabled boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  target_role text;
  target_status text;
begin
  select organization_id into org_id
  from public.profiles
  where id = auth.uid() and account_status = 'active';
  if org_id is null or not public.has_org_role(org_id, array['Super Administrator']::text[]) then
    raise exception 'Only the Super Administrator can manage incident closure delegates'
      using errcode = '42501';
  end if;
  if p_enabled is null then
    raise exception 'Choose whether closure access is enabled';
  end if;
  select m.role, p.account_status::text into target_role, target_status
  from public.memberships m
  join public.profiles p on p.id = m.user_id and p.organization_id = m.organization_id
  where m.user_id = p_user_id and m.organization_id = org_id
  for update of m, p;
  if not found then
    raise exception 'Choose an existing user in this organization' using errcode = '42501';
  end if;
  if target_role = 'Super Administrator' then
    raise exception 'Super Administrators always retain closure access';
  end if;
  if p_enabled and (target_status <> 'active' or not (
    public.is_builtin_role_name(target_role) or exists (
      select 1 from public.custom_roles
      where organization_id = org_id and name = target_role and is_active
    )
  )) then
    raise exception 'The delegate must have an active account and a defined active role';
  end if;
  if p_enabled then
    insert into public.incident_closure_delegates(organization_id, user_id, granted_role, granted_by)
    values (org_id, p_user_id, target_role, auth.uid())
    on conflict (organization_id, user_id) do update
      set granted_role = excluded.granted_role,
          granted_by = excluded.granted_by,
          granted_at = now();
  else
    delete from public.incident_closure_delegates
    where organization_id = org_id and user_id = p_user_id;
  end if;
  insert into public.activity_logs(organization_id, user_id, activity, metadata)
  values (
    org_id, auth.uid(), 'Incident closure delegation changed',
    jsonb_build_object(
      'event_code', 'incident_closure_delegation_changed',
      'delegate_user_id', p_user_id,
      'delegate_role', target_role,
      'enabled', p_enabled
    )
  );
end;
$$;
revoke all on function public.list_incident_closure_candidates(), public.set_incident_closure_delegate(uuid, boolean)
  from public, anon;
grant execute on function public.list_incident_closure_candidates(), public.set_incident_closure_delegate(uuid, boolean)
  to authenticated;

do $$
declare
  function_definition text;
  is_security_definer boolean;
  function_settings text[];
begin
  select pg_get_functiondef(proc.oid), proc.prosecdef, proc.proconfig
  into function_definition, is_security_definer, function_settings
  from pg_proc proc
  where proc.oid = to_regprocedure('public.can_view_incident(uuid, uuid)');
  if position('can_close_incidents' in function_definition) = 0 then
    if position('has_org_permission' in function_definition) > 0
      or position('view_all_incidents' in function_definition) > 0 then
      raise exception 'Later can_view_incident(uuid, uuid) version lacks closure authorization; inspect it before reconciling';
    end if;
    execute $ddl$
      create or replace function public.can_view_incident(
        target_organization_id uuid,
        target_incident_id uuid
      )
      returns boolean
      language sql
      stable
      security definer
      set search_path = public
      as $body$
        select exists (
          select 1 from public.incidents i
          where i.id = target_incident_id and i.organization_id = target_organization_id
            and public.is_org_member(target_organization_id)
            and (public.can_close_incidents(target_organization_id)
              or public.has_org_role(target_organization_id, array[
                'Super Administrator', 'Organization Administrator', 'QHSE Manager', 'Site Supervisor',
                'Safety Officer / HSE Officer', 'Auditor', 'Executive / Management'
              ]::text[])
              or i.created_by = auth.uid() or i.reported_by = auth.uid())
        );
      $body$;
    $ddl$;
  elsif position('is_org_member' in function_definition) = 0
    or not is_security_definer
    or function_settings is null
    or array_position(function_settings, 'search_path=public') is null then
    raise exception 'Existing can_view_incident(uuid, uuid) lacks organization isolation';
  end if;
end;
$$;

create table if not exists public.incident_closures (
  incident_id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  root_cause text not null check (length(btrim(root_cause)) between 3 and 5000),
  corrective_action text not null check (length(btrim(corrective_action)) between 3 and 5000),
  action_completed boolean not null check (action_completed),
  closed_by uuid not null references auth.users(id) on delete restrict,
  closed_at timestamptz not null default now(),
  foreign key (incident_id, organization_id)
    references public.incidents(id, organization_id) on delete cascade
);

do $$
begin
  if not exists (
    select 1 from pg_class
    where oid = 'public.incident_closure_delegates'::regclass and relkind = 'r'
  ) or not exists (
    select 1 from pg_class
    where oid = 'public.incident_closures'::regclass and relkind = 'r'
  ) then
    raise exception 'An incident closure relation is not an ordinary table';
  end if;

  if (
    select count(*)
    from pg_attribute
    where attrelid = 'public.incident_closure_delegates'::regclass
      and attnum > 0 and not attisdropped
  ) <> 5
    or (
      select count(*)
      from pg_attribute
      where attrelid = 'public.incident_closures'::regclass
        and attnum > 0 and not attisdropped
    ) <> 7 then
    raise exception 'Existing incident closure table has an unexpected column set';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closure_delegates'::regclass
      and attname = 'organization_id' and atttypid = 'uuid'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closure_delegates'::regclass
      and attname = 'user_id' and atttypid = 'uuid'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closure_delegates'::regclass
      and attname = 'granted_role' and atttypid = 'text'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closure_delegates'::regclass
      and attname = 'granted_by' and atttypid = 'uuid'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute attribute_row
    where attrelid = 'public.incident_closure_delegates'::regclass
      and attname = 'granted_at' and atttypid = 'timestamp with time zone'::regtype
      and attnotnull and exists (
        select 1 from pg_attrdef default_row
        where default_row.adrelid = attribute_row.attrelid
          and default_row.adnum = attribute_row.attnum
          and pg_get_expr(default_row.adbin, default_row.adrelid) = 'now()'
      )
  ) then
    raise exception 'Existing incident_closure_delegates columns are incompatible';
  end if;

  if not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closures'::regclass
      and attname = 'incident_id' and atttypid = 'uuid'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closures'::regclass
      and attname = 'organization_id' and atttypid = 'uuid'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closures'::regclass
      and attname = 'root_cause' and atttypid = 'text'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closures'::regclass
      and attname = 'corrective_action' and atttypid = 'text'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closures'::regclass
      and attname = 'action_completed' and atttypid = 'boolean'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute
    where attrelid = 'public.incident_closures'::regclass
      and attname = 'closed_by' and atttypid = 'uuid'::regtype and attnotnull
  ) or not exists (
    select 1 from pg_attribute attribute_row
    where attrelid = 'public.incident_closures'::regclass
      and attname = 'closed_at' and atttypid = 'timestamp with time zone'::regtype
      and attnotnull and exists (
        select 1 from pg_attrdef default_row
        where default_row.adrelid = attribute_row.attrelid
          and default_row.adnum = attribute_row.attnum
          and pg_get_expr(default_row.adbin, default_row.adrelid) = 'now()'
      )
  ) then
    raise exception 'Existing incident_closures columns are incompatible';
  end if;

  if exists (
    select expected.name
    from (values
      ('incident_closure_delegates_pkey', 'PRIMARY KEY (organization_id, user_id)'),
      ('incident_closure_delegates_organization_id_fkey', 'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE'),
      ('incident_closure_delegates_user_id_fkey', 'FOREIGN KEY (user_id) REFERENCES profiles(id) ON DELETE CASCADE'),
      ('incident_closure_delegates_granted_by_fkey', 'FOREIGN KEY (granted_by) REFERENCES auth.users(id) ON DELETE RESTRICT')
    ) expected(name, definition)
    where not exists (
      select 1 from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.incident_closure_delegates'::regclass
        and constraint_row.conname = expected.name
        and constraint_row.convalidated
        and pg_get_constraintdef(constraint_row.oid) = expected.definition
    )
  ) or exists (
    select expected.name
    from (values
      ('incident_closures_pkey', 'PRIMARY KEY (incident_id)'),
      ('incident_closures_organization_id_fkey', 'FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE'),
      ('incident_closures_closed_by_fkey', 'FOREIGN KEY (closed_by) REFERENCES auth.users(id) ON DELETE RESTRICT'),
      ('incident_closures_incident_id_organization_id_fkey', 'FOREIGN KEY (incident_id, organization_id) REFERENCES incidents(id, organization_id) ON DELETE CASCADE')
    ) expected(name, definition)
    where not exists (
      select 1 from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.incident_closures'::regclass
        and constraint_row.conname = expected.name
        and constraint_row.convalidated
        and pg_get_constraintdef(constraint_row.oid) = expected.definition
    )
  ) or exists (
    select expected.name
    from (values
      ('incident_closures_root_cause_check', 'root_cause'),
      ('incident_closures_corrective_action_check', 'corrective_action')
    ) expected(name, checked_column)
    where not exists (
      select 1 from pg_constraint constraint_row
      where constraint_row.conrelid = 'public.incident_closures'::regclass
        and constraint_row.conname = expected.name
        and constraint_row.contype = 'c'
        and constraint_row.convalidated
        and position('length(btrim(' || expected.checked_column || '))' in pg_get_constraintdef(constraint_row.oid)) > 0
        and position('>= 3' in pg_get_constraintdef(constraint_row.oid)) > 0
        and position('<= 5000' in pg_get_constraintdef(constraint_row.oid)) > 0
    )
  ) or not exists (
    select 1 from pg_constraint constraint_row
    where constraint_row.conrelid = 'public.incident_closures'::regclass
      and constraint_row.conname = 'incident_closures_action_completed_check'
      and constraint_row.contype = 'c'
      and constraint_row.convalidated
      and position('CHECK (action_completed)' in pg_get_constraintdef(constraint_row.oid)) > 0
  ) then
    raise exception 'Existing incident closure constraints are incompatible';
  end if;
end;
$$;

alter table public.incident_closures enable row level security;
revoke all on public.incident_closures from public, anon, authenticated;
grant select on public.incident_closures to authenticated;
drop policy if exists incident_closures_read on public.incident_closures;
create policy incident_closures_read on public.incident_closures
for select to authenticated
using (public.can_view_incident(organization_id, incident_id));

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
    if old.status in ('draft', 'closed')
      or not public.can_close_incidents(old.organization_id)
      or not exists (
        select 1 from public.incident_closures c
        where c.incident_id = old.id
          and c.organization_id = old.organization_id
          and c.closed_by = auth.uid()
      ) then
      raise exception 'Use the authorized closure form with root cause and completed corrective action'
        using errcode = '42501';
    end if;
    if exists (
      select 1 from public.corrective_actions a
      where a.incident_id = old.id
        and a.organization_id = old.organization_id
        and a.status not in ('verified', 'closed')
    ) then
      raise exception 'All linked corrective actions must be verified or closed before closing this incident';
    end if;
    return new;
  end if;
  if not public.has_org_role(old.organization_id, array[
    'Super Administrator', 'Organization Administrator', 'QHSE Manager',
    'Site Supervisor', 'Safety Officer / HSE Officer'
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
  ) then
    raise exception 'Invalid incident workflow transition from % to %', old.status, new.status;
  end if;
  return new;
end;
$$;

create or replace function public.enforce_corrective_action_parent_integrity()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  parent_status public.incident_status;
begin
  select status into parent_status
  from public.incidents
  where id = new.incident_id and organization_id = new.organization_id
  for update;
  if parent_status = 'closed' and new.status not in ('verified', 'closed') then
    raise exception 'A closed incident cannot have unfinished corrective actions';
  end if;
  if new.investigation_id is not null and not exists (
    select 1 from public.investigations i
    where i.id = new.investigation_id
      and i.organization_id = new.organization_id
      and i.incident_id = new.incident_id
  ) then
    raise exception 'Corrective action investigation must belong to the same incident';
  end if;
  return new;
end;
$$;

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
declare
  incident_row public.incidents;
  result public.incidents;
begin
  select * into incident_row
  from public.incidents
  where id = target_incident_id
  for update;
  if not found or not public.can_close_incidents(incident_row.organization_id) then
    raise exception 'You are not authorized to close this incident' using errcode = '42501';
  end if;
  if incident_row.status in ('draft', 'closed') then
    raise exception 'Only an open, reported incident can be closed';
  end if;
  if p_root_cause is null or length(btrim(p_root_cause)) not between 3 and 5000
    or p_corrective_action is null or length(btrim(p_corrective_action)) not between 3 and 5000
    or p_action_completed is distinct from true then
    raise exception 'Enter a root cause and corrective action (3-5000 characters each) and confirm the action is completed';
  end if;
  if exists (
    select 1 from public.corrective_actions
    where incident_id = incident_row.id
      and organization_id = incident_row.organization_id
      and status not in ('verified', 'closed')
  ) then
    raise exception 'All linked corrective actions must be verified or closed before closing this incident';
  end if;
  insert into public.incident_closures(
    incident_id, organization_id, root_cause, corrective_action, action_completed, closed_by
  )
  values (
    incident_row.id, incident_row.organization_id, btrim(p_root_cause),
    btrim(p_corrective_action), true, auth.uid()
  );
  update public.incidents
  set status = 'closed'
  where id = incident_row.id
  returning * into result;
  insert into public.activity_logs(organization_id, user_id, activity, metadata)
  values (
    incident_row.organization_id, auth.uid(), 'Incident closed',
    jsonb_build_object(
      'event_code', 'incident_closed',
      'incident_id', incident_row.id,
      'notification_key', 'incident_closed',
      'notification_ready', true
    )
  );
  return result;
end;
$$;
revoke all on function public.close_incident(uuid, text, text, boolean) from public, anon;
grant execute on function public.close_incident(uuid, text, text, boolean) to authenticated;

create or replace function public.close_incident(target_incident_id uuid)
returns public.incidents
language plpgsql
security definer
set search_path = public
as $$
declare
  root_text text;
  action_text text;
  org_id uuid;
begin
  select organization_id into org_id
  from public.incidents
  where id = target_incident_id;
  if org_id is null or not public.can_close_incidents(org_id) then
    raise exception 'You are not authorized to close this incident' using errcode = '42501';
  end if;
  select string_agg(r.root_cause_statement, E'\n' order by r.created_at, r.id)
  into root_text
  from public.investigation_root_causes r
  join public.investigations i on i.id = r.investigation_id
  where i.incident_id = target_incident_id
    and i.organization_id = org_id
    and i.status = 'completed';
  select string_agg(coalesce(nullif(btrim(description), ''), title), E'\n' order by created_at, id)
  into action_text
  from public.corrective_actions
  where incident_id = target_incident_id
    and organization_id = org_id
    and status in ('verified', 'closed');
  return public.close_incident(target_incident_id, root_text, action_text, true);
end;
$$;

notify pgrst, 'reload schema';
