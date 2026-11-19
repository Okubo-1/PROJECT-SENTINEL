create or replace function public.can_manage_investigation(
  target_organization_id uuid,
  target_investigation_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1
    from public.investigations investigation
    where investigation.id = target_investigation_id
      and investigation.organization_id = target_organization_id
      and public.is_org_member(target_organization_id)
      and (
        public.has_org_permission(target_organization_id, 'manage_incidents')
        or investigation.assigned_investigator_id = auth.uid()
        or investigation.investigation_lead_id = auth.uid()
        or exists (
          select 1
          from public.investigation_team_members team
          where team.organization_id = investigation.organization_id
            and team.severity_level = investigation.level
            and team.user_id = auth.uid()
        )
      )
  );
$$;

notify pgrst, 'reload schema';
