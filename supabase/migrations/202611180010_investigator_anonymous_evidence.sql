drop policy if exists incident_evidence_insert_investigation_team
  on public.incident_evidence;
create policy incident_evidence_insert_investigation_team
  on public.incident_evidence for insert to authenticated
  with check (
    uploaded_by = (select auth.uid())
    and (
      sentinel_private.can_upload_identified_investigation_evidence(organization_id, incident_id)
      or sentinel_private.can_upload_investigation_evidence(organization_id, incident_id)
    )
  );

drop policy if exists incident_evidence_storage_insert_investigation_team
  on storage.objects;
create policy incident_evidence_storage_insert_investigation_team
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'incident-evidence'
    and (storage.foldername(name))[1] ~* '^[0-9a-f-]{36}$'
    and (storage.foldername(name))[2] ~* '^[0-9a-f-]{36}$'
    and (storage.foldername(name))[3] = (select auth.uid())::text
    and (
      sentinel_private.can_upload_identified_investigation_evidence(
        (storage.foldername(name))[1]::uuid,
        (storage.foldername(name))[2]::uuid
      )
      or sentinel_private.can_upload_investigation_evidence(
        (storage.foldername(name))[1]::uuid,
        (storage.foldername(name))[2]::uuid
      )
    )
  );
