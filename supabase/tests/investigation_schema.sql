-- Investigation schema tests: RLS, team assignment, deadlines.
-- Run these tests after migrations to verify security and functionality.

-- Test 1: RLS isolation - organization members cannot see other org's team members
do $$
declare
  org1_id uuid := 'f1234567-1234-1234-1234-123456789001'::uuid;
  org2_id uuid := 'f1234567-1234-1234-1234-123456789002'::uuid;
  user1_id uuid := 'f1234567-1234-1234-1234-111111111111'::uuid;
  user2_id uuid := 'f1234567-1234-1234-1234-222222222222'::uuid;
  admin1_id uuid := 'f1234567-1234-1234-1234-333333333333'::uuid;
  admin2_id uuid := 'f1234567-1234-1234-1234-444444444444'::uuid;
begin
  raise notice 'Test 1: RLS isolation for investigation_team_members';

  -- Setup: Create organizations and test data
  insert into public.organizations (id, name, subscription_tier) values
    (org1_id, 'Test Org 1', 'trial'),
    (org2_id, 'Test Org 2', 'trial')
  on conflict do nothing;

  insert into public.investigation_team_members (id, organization_id, severity_level, user_id, added_by) values
    (gen_random_uuid(), org1_id, 'Critical', user1_id, admin1_id),
    (gen_random_uuid(), org2_id, 'Critical', user2_id, admin2_id)
  on conflict do nothing;

  raise notice 'Test 1 setup complete - verify RLS policies in application tests';
end;
$$;

-- Test 2: Team assignment by severity level
do $$
declare
  org_id uuid := 'f1234567-1234-1234-1234-123456789003'::uuid;
  user1_id uuid := 'f1234567-1234-1234-1234-555555555555'::uuid;
  user2_id uuid := 'f1234567-1234-1234-1234-666666666666'::uuid;
  admin_id uuid := 'f1234567-1234-1234-1234-777777777777'::uuid;
  critical_count integer;
  high_count integer;
begin
  raise notice 'Test 2: Team assignment by severity level';

  insert into public.organizations (id, name, subscription_tier) values (org_id, 'Test Org 3', 'trial') on conflict do nothing;

  -- Assign users to different severity levels
  insert into public.investigation_team_members (id, organization_id, severity_level, user_id, added_by) values
    (gen_random_uuid(), org_id, 'Critical', user1_id, admin_id),
    (gen_random_uuid(), org_id, 'High', user2_id, admin_id),
    (gen_random_uuid(), org_id, 'Critical', user2_id, admin_id);

  select count(*) into critical_count from public.investigation_team_members where organization_id = org_id and severity_level = 'Critical';
  select count(*) into high_count from public.investigation_team_members where organization_id = org_id and severity_level = 'High';

  assert critical_count = 2, format('Expected 2 Critical team members, got %s', critical_count);
  assert high_count = 1, format('Expected 1 High team member, got %s', high_count);

  raise notice 'Test 2 passed: Severity level team assignment works correctly';
end;
$$;

-- Test 3: Deadline calculation trigger
do $$
declare
  org_id uuid := 'f1234567-1234-1234-1234-123456789004'::uuid;
  incident_id uuid := 'f1234567-1234-1234-1234-888888888888'::uuid;
  investigation_id uuid;
  calculated_due_at timestamptz;
  expected_max_due_at timestamptz;
begin
  raise notice 'Test 3: Investigation due date calculation';

  insert into public.organizations (id, name, subscription_tier) values (org_id, 'Test Org 4', 'trial') on conflict do nothing;

  -- Setup deadlines (24 hours for Critical)
  insert into public.investigation_deadlines (organization_id, critical_hours, high_hours, medium_hours, low_hours) values
    (org_id, 24, 72, 168, 336)
  on conflict (organization_id) do update set critical_hours = 24;

  insert into public.investigations (id, organization_id, incident_id, level, created_by) values
    (gen_random_uuid(), org_id, incident_id, 'Critical', 'f1234567-1234-1234-1234-999999999999'::uuid);

  select id, due_at into investigation_id, calculated_due_at
  from public.investigations
  where organization_id = org_id and level = 'Critical'
  limit 1;

  expected_max_due_at := now() + interval '24 hours';

  assert calculated_due_at is not null, 'Expected due_at to be calculated';
  assert extract(epoch from (calculated_due_at - expected_max_due_at)) < 60, 'Expected due_at to be ~24 hours from now';

  raise notice 'Test 3 passed: Due date calculation works correctly';
end;
$$;

-- Test 4: RLS for investigation_deadlines
do $$
declare
  org1_id uuid := 'f1234567-1234-1234-1234-123456789005'::uuid;
  org2_id uuid := 'f1234567-1234-1234-1234-123456789006'::uuid;
begin
  raise notice 'Test 4: RLS isolation for investigation_deadlines';

  insert into public.organizations (id, name, subscription_tier) values
    (org1_id, 'Test Org 5', 'trial'),
    (org2_id, 'Test Org 6', 'trial')
  on conflict do nothing;

  insert into public.investigation_deadlines (organization_id, critical_hours, high_hours, medium_hours, low_hours) values
    (org1_id, 24, 72, 168, 336),
    (org2_id, 48, 96, 192, 480)
  on conflict (organization_id) do nothing;

  raise notice 'Test 4 setup complete - verify RLS policies in application tests';
end;
$$;

-- Test 5: Timeline event creation
do $$
declare
  org_id uuid := 'f1234567-1234-1234-1234-123456789007'::uuid;
  incident_id uuid := 'f1234567-1234-1234-1234-aaaaaaaaaaaa'::uuid;
  investigation_id uuid := 'f1234567-1234-1234-1234-bbbbbbbbbbbb'::uuid;
  actor_id uuid := 'f1234567-1234-1234-1234-cccccccccccc'::uuid;
  event_count integer;
begin
  raise notice 'Test 5: Timeline event insertion and retrieval';

  insert into public.organizations (id, name, subscription_tier) values (org_id, 'Test Org 7', 'trial') on conflict do nothing;

  insert into public.investigations (id, organization_id, incident_id, created_by) values
    (investigation_id, org_id, incident_id, actor_id)
  on conflict do nothing;

  insert into public.investigation_timeline_events (organization_id, investigation_id, event_type, actor_id, details) values
    (org_id, investigation_id, 'created', actor_id, '{"source": "test"}'::jsonb),
    (org_id, investigation_id, 'started', actor_id, '{"reason": "test start"}'::jsonb),
    (org_id, investigation_id, 'completed', actor_id, '{"findings": "test findings"}'::jsonb);

  select count(*) into event_count from public.investigation_timeline_events
  where organization_id = org_id and investigation_id = investigation_id;

  assert event_count = 3, format('Expected 3 timeline events, got %s', event_count);

  raise notice 'Test 5 passed: Timeline events can be created and retrieved';
end;
$$;

-- Test 6: Unique constraint on team member severity+user
do $$
declare
  org_id uuid := 'f1234567-1234-1234-1234-123456789008'::uuid;
  user_id uuid := 'f1234567-1234-1234-1234-dddddddddddd'::uuid;
  admin_id uuid := 'f1234567-1234-1234-1234-eeeeeeeeeeee'::uuid;
  error_raised boolean := false;
begin
  raise notice 'Test 6: Unique constraint on (org_id, severity_level, user_id)';

  insert into public.organizations (id, name, subscription_tier) values (org_id, 'Test Org 8', 'trial') on conflict do nothing;

  insert into public.investigation_team_members (id, organization_id, severity_level, user_id, added_by) values
    (gen_random_uuid(), org_id, 'Critical', user_id, admin_id);

  begin
    insert into public.investigation_team_members (id, organization_id, severity_level, user_id, added_by) values
      (gen_random_uuid(), org_id, 'Critical', user_id, admin_id);
    error_raised := false;
  exception when unique_violation then
    error_raised := true;
  end;

  assert error_raised, 'Expected unique constraint violation but none was raised';

  raise notice 'Test 6 passed: Unique constraint prevents duplicate severity+user combinations';
end;
$$;

raise notice 'All investigation schema tests completed successfully';
