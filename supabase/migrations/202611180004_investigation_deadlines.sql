-- Investigation deadlines: severity-level-based deadline configuration.
-- This migration creates a table to manage investigation deadline settings per organization.
--
-- Rollback guidance: Drop the investigation_deadlines table and all
-- associated indexes and RLS policies after removing dependent application code.

create table public.investigation_deadlines (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  critical_hours integer not null default 24 check (critical_hours > 0),
  high_hours integer not null default 72 check (high_hours > 0),
  medium_hours integer not null default 168 check (medium_hours > 0),
  low_hours integer not null default 336 check (low_hours > 0),
  verification_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

create index investigation_deadlines_organization_id_idx
  on public.investigation_deadlines(organization_id);

alter table public.investigation_deadlines enable row level security;
alter table public.investigation_deadlines force row level security;

revoke all on public.investigation_deadlines from public, anon, authenticated, service_role;

create policy investigation_deadlines_view
  on public.investigation_deadlines for select
  to authenticated
  using (
    public.is_org_member(organization_id)
    and public.has_org_role(organization_id, array[
      'Super Administrator',
      'Organization Administrator',
      'QHSE Manager'
    ]::public.membership_role[])
  );

grant select on public.investigation_deadlines to authenticated;

create policy investigation_deadlines_admin_all
  on public.investigation_deadlines for all
  to authenticated
  using (
    public.is_org_member(organization_id)
    and public.has_org_role(organization_id, array[
      'Super Administrator',
      'Organization Administrator'
    ]::public.membership_role[])
  )
  with check (
    public.is_org_member(organization_id)
    and public.has_org_role(organization_id, array[
      'Super Administrator',
      'Organization Administrator'
    ]::public.membership_role[])
  );

grant insert, update, delete on public.investigation_deadlines to authenticated;

create or replace function public.get_investigation_deadlines(target_organization_id uuid)
returns table (critical_hours integer, high_hours integer, medium_hours integer, low_hours integer, verification_enabled boolean)
language sql
stable
security definer
set search_path = public
as $$
  select d.critical_hours, d.high_hours, d.medium_hours, d.low_hours, d.verification_enabled
  from public.investigation_deadlines d
  where d.organization_id = target_organization_id
    and public.has_org_role(target_organization_id, array[
      'Super Administrator',
      'Organization Administrator',
      'QHSE Manager'
    ]::public.membership_role[]);
$$;

revoke all on function public.get_investigation_deadlines(uuid) from public, anon, service_role;
grant execute on function public.get_investigation_deadlines(uuid) to authenticated;

notify pgrst, 'reload schema';
