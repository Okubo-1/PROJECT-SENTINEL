grant execute on function sentinel_private.can_upload_identified_investigation_evidence(uuid, uuid)
  to authenticated;
grant execute on function sentinel_private.can_upload_investigation_evidence(uuid, uuid)
  to authenticated;

notify pgrst, 'reload schema';
