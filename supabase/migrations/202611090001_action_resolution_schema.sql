-- Action resolution workflow schema.
-- This migration is additive. Workflow writes are intentionally not granted here;
-- trusted submission/decision functions and their authorization policies belong
-- to the separately approved server-security phase.
--
-- Rollback guidance: after dependent application code is removed, drop the newly
-- created action_* tables, bucket policies and bucket, remove
-- company_settings.require_verification, and restore the original actions status
-- check constraint. Do not remove or alter existing action, incident, audit, or
-- organization data.

alter table public.company_settings
  add column require_verification boolean not null default false;

create or replace function public.guard_action_resolution_setting()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.require_verification is distinct from old.require_verification
    and not public.has_org_role(
      old.organization_id,
      array['Super Administrator']::public.membership_role[]
    ) then
    raise exception 'Only a Super Administrator can change the action verification setting'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger company_settings_guard_action_resolution
before update of require_verification on public.company_settings
for each row execute function public.guard_action_resolution_setting();

revoke all on function public.guard_action_resolution_setting() from public, anon, authenticated;

alter table public.actions
  drop constraint actions_status_check;

alter table public.actions
  add constraint actions_status_check
  check (status in ('open', 'resolved', 'pending_verification'));

create unique index actions_id_organization_type_unique
  on public.actions (id, organization_id, type);

create table public.action_resolutions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  action_type text not null check (action_type in ('corrective', 'preventive', 'investigation')),
  submission_number integer not null check (submission_number > 0),
  resolution_summary text not null check (char_length(btrim(resolution_summary)) between 1 and 10000),
  completion_date date not null,
  what_was_fixed text,
  root_cause_addressed boolean,
  preventive_measure text,
  measure_applies text,
  effectiveness_check text,
  findings text,
  root_cause text,
  contributing_factors text,
  conclusion text,
  recommended_follow_up_actions text,
  additional_notes text check (additional_notes is null or char_length(additional_notes) <= 10000),
  submitted_by uuid not null,
  submitted_at timestamptz not null default now(),
  is_locked boolean not null default true check (is_locked),
  unique (action_id, submission_number),
  unique (id, organization_id, action_id),
  foreign key (action_id, organization_id, action_type)
    references public.actions(id, organization_id, type) on delete cascade,
  foreign key (submitted_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  check (
    (action_type = 'corrective'
      and what_was_fixed is not null
      and char_length(btrim(what_was_fixed)) between 1 and 10000
      and root_cause_addressed is not null
      and preventive_measure is null and measure_applies is null and effectiveness_check is null
      and findings is null and root_cause is null and contributing_factors is null
      and conclusion is null and recommended_follow_up_actions is null)
    or (action_type = 'preventive'
      and preventive_measure is not null
      and char_length(btrim(preventive_measure)) between 1 and 10000
      and measure_applies is not null
      and char_length(btrim(measure_applies)) between 1 and 10000
      and effectiveness_check is not null
      and char_length(btrim(effectiveness_check)) between 1 and 10000
      and what_was_fixed is null and root_cause_addressed is null
      and findings is null and root_cause is null and contributing_factors is null
      and conclusion is null and recommended_follow_up_actions is null)
    or (action_type = 'investigation'
      and findings is not null
      and char_length(btrim(findings)) between 1 and 10000
      and root_cause is not null
      and char_length(btrim(root_cause)) between 1 and 10000
      and conclusion is not null
      and char_length(btrim(conclusion)) between 1 and 10000
      and what_was_fixed is null and root_cause_addressed is null
      and preventive_measure is null and measure_applies is null and effectiveness_check is null)
  )
);

create unique index action_resolutions_primary_action_uidx
  on public.action_resolutions (action_id)
  where submission_number = 1;

create index action_resolutions_organization_action_idx
  on public.action_resolutions (organization_id, action_id, submission_number);

create table public.action_resolution_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  resolution_id uuid not null,
  storage_path text not null unique,
  original_filename text not null
    check (char_length(btrim(original_filename)) between 1 and 255),
  mime_type text not null check (mime_type in (
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'image/jpeg',
    'image/png'
  )),
  file_size bigint not null check (file_size between 1 and 26214400),
  uploaded_by uuid not null,
  uploaded_at timestamptz not null default now(),
  metadata jsonb not null default '{}'::jsonb check (jsonb_typeof(metadata) = 'object'),
  foreign key (action_id, organization_id)
    references public.actions(id, organization_id) on delete cascade,
  foreign key (resolution_id, organization_id, action_id)
    references public.action_resolutions(id, organization_id, action_id) on delete cascade,
  foreign key (uploaded_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict
);

create index action_resolution_attachments_organization_action_idx
  on public.action_resolution_attachments (organization_id, action_id);

create or replace function public.enforce_action_resolution_attachment_limit()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  perform 1
  from public.actions action
  where action.id = new.action_id
    and action.organization_id = new.organization_id
  for update;

  if not found then
    raise exception 'The action is unavailable in this organization';
  end if;

  if (
    select count(*)
    from public.action_resolution_attachments attachment
    where attachment.resolution_id = new.resolution_id
  ) >= 10 then
    raise exception 'A resolution cannot have more than 10 attachments';
  end if;

  return new;
end;
$$;

create trigger action_resolution_attachments_limit
before insert on public.action_resolution_attachments
for each row execute function public.enforce_action_resolution_attachment_limit();

revoke all on function public.enforce_action_resolution_attachment_limit() from public, anon, authenticated;

create table public.action_progress_updates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  author_id uuid not null,
  note text not null check (char_length(btrim(note)) between 1 and 10000),
  created_at timestamptz not null default now(),
  foreign key (action_id, organization_id)
    references public.actions(id, organization_id) on delete cascade,
  foreign key (author_id, organization_id)
    references public.profiles(id, organization_id) on delete restrict
);

create index action_progress_updates_organization_action_created_idx
  on public.action_progress_updates (organization_id, action_id, created_at);

create table public.action_extension_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  requested_due_at timestamptz not null,
  reason text not null check (char_length(btrim(reason)) between 1 and 10000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 10000),
  previous_due_at timestamptz,
  applied_due_at timestamptz,
  foreign key (action_id, organization_id)
    references public.actions(id, organization_id) on delete cascade,
  foreign key (requested_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  foreign key (decided_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  check (
    (status = 'pending' and decided_by is null and decided_at is null and applied_due_at is null)
    or (status = 'approved' and decided_by is not null and decided_at is not null
      and previous_due_at is not null and applied_due_at = requested_due_at)
    or (status = 'declined' and decided_by is not null and decided_at is not null
      and previous_due_at is not null and applied_due_at is null)
  )
);

create index action_extension_requests_organization_status_idx
  on public.action_extension_requests (organization_id, status, requested_at);

create index action_extension_requests_action_idx
  on public.action_extension_requests (organization_id, action_id, requested_at);

create table public.action_assignment_requests (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  request_type text not null check (request_type in ('reassignment', 'blocker')),
  reason text not null check (char_length(btrim(reason)) between 1 and 10000),
  proposed_assignee_id uuid,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  requested_by uuid not null,
  requested_at timestamptz not null default now(),
  decided_by uuid,
  decided_at timestamptz,
  decision_note text check (decision_note is null or char_length(decision_note) <= 10000),
  previous_assignee_id uuid,
  applied_assignee_id uuid,
  foreign key (action_id, organization_id)
    references public.actions(id, organization_id) on delete cascade,
  foreign key (requested_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  foreign key (proposed_assignee_id, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  foreign key (decided_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  foreign key (previous_assignee_id, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  foreign key (applied_assignee_id, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  check (request_type = 'reassignment' or proposed_assignee_id is null),
  check (
    (status = 'pending' and decided_by is null and decided_at is null
      and previous_assignee_id is null and applied_assignee_id is null)
    or (status = 'approved' and decided_by is not null and decided_at is not null
      and previous_assignee_id is not null
      and ((request_type = 'reassignment' and applied_assignee_id is not null)
        or (request_type = 'blocker' and applied_assignee_id is null)))
    or (status = 'declined' and decided_by is not null and decided_at is not null
      and applied_assignee_id is null)
  )
);

create index action_assignment_requests_organization_status_idx
  on public.action_assignment_requests (organization_id, status, requested_at);

create index action_assignment_requests_action_idx
  on public.action_assignment_requests (organization_id, action_id, requested_at);

create table public.action_resolution_addenda (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  resolution_id uuid not null,
  note text not null check (char_length(btrim(note)) between 1 and 10000),
  author_id uuid not null,
  created_at timestamptz not null default now(),
  foreign key (action_id, organization_id)
    references public.actions(id, organization_id) on delete cascade,
  foreign key (resolution_id, organization_id, action_id)
    references public.action_resolutions(id, organization_id, action_id) on delete cascade,
  foreign key (author_id, organization_id)
    references public.profiles(id, organization_id) on delete restrict
);

create index action_resolution_addenda_organization_action_created_idx
  on public.action_resolution_addenda (organization_id, action_id, created_at);

create table public.action_resolution_verifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  action_id uuid not null,
  resolution_id uuid not null,
  decision text not null check (decision in ('approved', 'rejected')),
  reason text,
  verified_by uuid not null,
  verified_at timestamptz not null default now(),
  foreign key (action_id, organization_id)
    references public.actions(id, organization_id) on delete cascade,
  foreign key (resolution_id, organization_id, action_id)
    references public.action_resolutions(id, organization_id, action_id) on delete cascade,
  foreign key (verified_by, organization_id)
    references public.profiles(id, organization_id) on delete restrict,
  check (
    (decision = 'approved' and reason is null)
    or (decision = 'rejected' and reason is not null
      and char_length(btrim(reason)) between 1 and 10000)
  ),
  unique (resolution_id)
);

create index action_resolution_verifications_organization_action_idx
  on public.action_resolution_verifications (organization_id, action_id, verified_at);

alter table public.action_resolutions enable row level security;
alter table public.action_resolution_attachments enable row level security;
alter table public.action_progress_updates enable row level security;
alter table public.action_extension_requests enable row level security;
alter table public.action_assignment_requests enable row level security;
alter table public.action_resolution_addenda enable row level security;
alter table public.action_resolution_verifications enable row level security;

revoke all on public.action_resolutions,
  public.action_resolution_attachments,
  public.action_progress_updates,
  public.action_extension_requests,
  public.action_assignment_requests,
  public.action_resolution_addenda,
  public.action_resolution_verifications
from public, anon, authenticated;

create policy action_resolutions_select_authorized
  on public.action_resolutions for select to authenticated
  using (public.can_view_action(organization_id, action_id));

create policy action_resolution_attachments_select_authorized
  on public.action_resolution_attachments for select to authenticated
  using (public.can_view_action(organization_id, action_id));

create policy action_progress_updates_select_authorized
  on public.action_progress_updates for select to authenticated
  using (public.can_view_action(organization_id, action_id));

create policy action_extension_requests_select_authorized
  on public.action_extension_requests for select to authenticated
  using (public.can_view_action(organization_id, action_id));

create policy action_assignment_requests_select_authorized
  on public.action_assignment_requests for select to authenticated
  using (public.can_view_action(organization_id, action_id));

create policy action_resolution_addenda_select_authorized
  on public.action_resolution_addenda for select to authenticated
  using (public.can_view_action(organization_id, action_id));

create policy action_resolution_verifications_select_authorized
  on public.action_resolution_verifications for select to authenticated
  using (public.can_view_action(organization_id, action_id));

grant select on public.action_resolutions to authenticated;
grant select on public.action_resolution_attachments to authenticated;
grant select on public.action_progress_updates to authenticated;
grant select on public.action_extension_requests to authenticated;
grant select on public.action_assignment_requests to authenticated;
grant select on public.action_resolution_addenda to authenticated;
grant select on public.action_resolution_verifications to authenticated;

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'action-resolution-evidence',
  'action-resolution-evidence',
  false,
  26214400,
  array[
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'image/jpeg',
    'image/png'
  ]
)
on conflict (id) do update
set name = excluded.name,
    public = false,
    file_size_limit = case when storage.buckets.file_size_limit is null then null
      else greatest(storage.buckets.file_size_limit, excluded.file_size_limit) end,
    allowed_mime_types = excluded.allowed_mime_types;

create policy action_resolution_evidence_select_authorized
  on storage.objects for select to authenticated
  using (
    bucket_id = 'action-resolution-evidence'
    and exists (
      select 1
      from public.action_resolution_attachments attachment
      where attachment.storage_path = storage.objects.name
        and attachment.organization_id::text = (storage.foldername(storage.objects.name))[1]
        and attachment.action_id::text = (storage.foldername(storage.objects.name))[2]
        and public.can_view_action(attachment.organization_id, attachment.action_id)
    )
  );

create policy action_resolution_evidence_insert_assignee
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'action-resolution-evidence'
    and (storage.foldername(name))[1] =
      (select profile.organization_id::text
       from public.profiles profile
       where profile.id = (select auth.uid()))
    and (storage.foldername(name))[3] = (select auth.uid())::text
    and coalesce((metadata ->> 'size')::bigint, 0) between 1 and 26214400
    and coalesce(metadata ->> 'mimetype', '') in (
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'image/jpeg',
      'image/png'
    )
    and exists (
      select 1
      from public.actions action
      where action.id::text = (storage.foldername(name))[2]
        and action.organization_id::text = (storage.foldername(name))[1]
        and action.assignee_id = (select auth.uid())
        and action.status = 'open'
    )
  );

create policy action_resolution_evidence_delete_unlinked_assignee
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'action-resolution-evidence'
    and (storage.foldername(name))[1] =
      (select profile.organization_id::text
       from public.profiles profile
       where profile.id = (select auth.uid()))
    and (storage.foldername(name))[3] = (select auth.uid())::text
    and not exists (
      select 1
      from public.action_resolution_attachments attachment
      where attachment.storage_path = storage.objects.name
    )
    and exists (
      select 1
      from public.actions action
      where action.id::text = (storage.foldername(name))[2]
        and action.organization_id::text = (storage.foldername(name))[1]
        and action.assignee_id = (select auth.uid())
        and action.status = 'open'
    )
  );
