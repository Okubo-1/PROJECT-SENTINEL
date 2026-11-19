-- Investigation timeline events: audit trail and event tracking for investigations.
-- This migration creates a table to track investigation lifecycle events.
--
-- Rollback guidance: Drop the investigation_timeline_events table and all
-- associated indexes and RLS policies after removing dependent application code.

create table public.investigation_timeline_events (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  investigation_id uuid not null,
  event_type text not null check (event_type in ('created', 'assigned', 'started', 'finding_added', 'status_changed', 'completed')),
  actor_id uuid not null,
  details jsonb default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint investigation_timeline_events_id_organization_unique unique (id, organization_id),
  constraint investigation_timeline_events_investigation_same_organization
    foreign key (investigation_id, organization_id)
    references public.investigations(id, organization_id)
    on delete cascade,
  constraint investigation_timeline_events_actor_same_organization
    foreign key (actor_id, organization_id)
    references public.profiles(id, organization_id)
    on delete restrict
);

create index investigation_timeline_events_organization_id_investigation_id_idx
  on public.investigation_timeline_events(organization_id, investigation_id);

create index investigation_timeline_events_organization_id_created_at_idx
  on public.investigation_timeline_events(organization_id, created_at);

create index investigation_timeline_events_organization_id_event_type_idx
  on public.investigation_timeline_events(organization_id, event_type);

alter table public.investigation_timeline_events enable row level security;
alter table public.investigation_timeline_events force row level security;

revoke all on public.investigation_timeline_events from public, anon, authenticated, service_role;

create policy investigation_timeline_events_org_members_view
  on public.investigation_timeline_events for select
  to authenticated
  using (
    public.is_org_member(organization_id)
    and public.has_org_role(organization_id, array[
      'Super Administrator',
      'Organization Administrator',
      'QHSE Manager',
      'Site Supervisor',
      'Safety Officer / HSE Officer',
      'Auditor',
      'Executive / Management'
    ]::public.membership_role[])
  );

grant select on public.investigation_timeline_events to authenticated;

create policy investigation_timeline_events_org_admin_insert
  on public.investigation_timeline_events for insert
  to authenticated
  with check (
    public.is_org_member(organization_id)
    and public.has_org_role(organization_id, array[
      'Super Administrator',
      'Organization Administrator',
      'QHSE Manager'
    ]::public.membership_role[])
  );

grant insert on public.investigation_timeline_events to authenticated;

notify pgrst, 'reload schema';
