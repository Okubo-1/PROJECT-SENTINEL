revoke all on public.inspections, public.actions from public, anon, authenticated;
grant select, insert, update on public.inspections, public.actions to authenticated;

do $$
begin
  update storage.buckets
  set public = false
  where id = 'incident-evidence';

  if not found then
    raise exception 'The incident-evidence bucket must exist before applying this migration';
  end if;
end;
$$;

do $$
declare
  tenant_table text;
begin
  foreach tenant_table in array array[
    'organization_policy_objectives',
    'organization_policy_objective_permission_overrides',
    'legal_compliance_obligations',
    'legal_compliance_obligation_versions',
    'action_resolutions',
    'action_resolution_attachments',
    'action_progress_updates',
    'action_extension_requests',
    'action_assignment_requests',
    'action_resolution_addenda',
    'action_resolution_verifications'
  ]
  loop
    execute format('alter table public.%I enable row level security', tenant_table);
    execute format(
      'drop policy if exists safety_policy_acknowledgement_required on public.%I',
      tenant_table
    );
    execute format(
      'create policy safety_policy_acknowledgement_required on public.%I as restrictive for all to authenticated using (public.safety_policy_access_allowed(organization_id)) with check (public.safety_policy_access_allowed(organization_id))',
      tenant_table
    );
  end loop;
end;
$$;

drop policy if exists safety_policy_acknowledgement_required_documents on storage.objects;
create policy safety_policy_acknowledgement_required_documents
on storage.objects as restrictive for all to authenticated
using (
  bucket_id not in (
    'hsse-policy-documents',
    'legal-compliance-documents',
    'action-resolution-evidence'
  )
  or exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and public.safety_policy_access_allowed(profile.organization_id)
  )
)
with check (
  bucket_id not in (
    'hsse-policy-documents',
    'legal-compliance-documents',
    'action-resolution-evidence'
  )
  or exists (
    select 1
    from public.profiles profile
    where profile.id = (select auth.uid())
      and public.safety_policy_access_allowed(profile.organization_id)
  )
);
