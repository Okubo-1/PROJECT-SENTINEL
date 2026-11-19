-- Investigation team members: severity-level-based team assignment configuration.
-- This migration creates a table to manage investigation team members by severity level.
--
-- Rollback guidance: Drop the investigation_team_members table and all
-- associated indexes and RLS policies after removing dependent application code.

create table public.investigation_team_members (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  severity_level text not null check (char_length(btrim(severity_level)) between 1 and 100),
  user_id uuid not null,
  added_by uuid not null,
  added_at timestamptz not null default now(),
  constraint investigation_team_members_id_organization_unique unique (id, organization_id),
  constraint investigation_team_members_severity_user_unique unique (organization_id, severity_level, user_id),
  constraint investigation_team_members_user_same_organization
    foreign key (user_id, organization_id)
    references public.profiles(id, organization_id)
    on delete cascade,
  constraint investigation_team_members_added_by_same_organization
    foreign key (added_by, organization_id)
    references public.profiles(id, organization_id)
    on delete restrict
);

create index investigation_team_members_organization_id_severity_level_idx
  on public.investigation_team_members(organization_id, severity_level);

create index investigation_team_members_organization_id_user_id_idx
  on public.investigation_team_members(organization_id, user_id);

create index investigation_team_members_organization_id_added_at_idx
  on public.investigation_team_members(organization_id, added_at);

alter table public.investigation_team_members enable row level security;
alter table public.investigation_team_members force row level security;

revoke all on public.investigation_team_members from public, anon, authenticated, service_role;

create policy investigation_team_members_view
  on public.investigation_team_members for select
  to authenticated
  using (
    public.is_org_member(organization_id)
    and public.has_org_role(organization_id, array[
      'Super Administrator',
      'Organization Administrator',
      'QHSE Manager'
    ]::public.membership_role[])
  );

grant select on public.investigation_team_members to authenticated;

create policy investigation_team_members_admin_all
  on public.investigation_team_members for all
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

grant insert, update, delete on public.investigation_team_members to authenticated;

notify pgrst, 'reload schema';
