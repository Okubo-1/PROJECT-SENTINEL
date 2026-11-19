grant execute on function sentinel_private.can_manage_investigation_for_incident(uuid, uuid)
  to authenticated;

notify pgrst, 'reload schema';
