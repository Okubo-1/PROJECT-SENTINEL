create policy action_evidence_upload_open_assignee
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'incident-evidence'
    and (storage.foldername(name))[2] = 'actions'
    and (storage.foldername(name))[4] = (select auth.uid())::text
    and exists (
      select 1
      from public.actions action
      where action.organization_id::text = (storage.foldername(name))[1]
        and action.id::text = (storage.foldername(name))[3]
        and action.assignee_id = (select auth.uid())
        and action.status = 'open'
        and public.is_org_member(action.organization_id)
    )
  );

create or replace function public.require_action_resolution_evidence()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public
as $$
begin
  if old.status = 'open' and new.status = 'resolved' then
    if nullif(btrim(new.resolution_notes), '') is null
      or char_length(btrim(new.resolution_notes)) > 10000 then
      raise exception 'Resolution details are required';
    end if;
    if new.proof_storage_path is null
      or nullif(btrim(new.proof_file_name), '') is null
      or new.proof_file_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
      or new.proof_file_size not between 1 and 10485760
      or new.proof_storage_path !~ (
        '^' || old.organization_id::text || '/actions/' || old.id::text || '/'
        || auth.uid()::text || '/[^/]+$'
      )
      or not exists (
        select 1 from storage.objects object
        where object.bucket_id = 'incident-evidence'
          and object.name = new.proof_storage_path
          and object.metadata->>'mimetype' = new.proof_file_type
          and object.metadata->>'size' = new.proof_file_size::text
      ) then
      raise exception 'A valid photo or document upload is required';
    end if;
  end if;
  return new;
end;
$$;
