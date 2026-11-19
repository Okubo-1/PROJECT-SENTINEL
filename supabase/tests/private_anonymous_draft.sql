begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  saved public.incidents;
  replay public.incidents;
  input jsonb := '{"reportType":"incident","title":"Private draft","digitalSignature":"identity must be ignored","draftStage":1}';
  api_role text;
begin
  foreach api_role in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(api_role, 'sentinel_private.save_anonymous_incident_draft(uuid,jsonb,text)', 'EXECUTE') then
      raise exception '% can directly invoke the private draft writer', api_role;
    end if;
  end loop;
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[reporter, other_user]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', reporter);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (reporter, organization, 'Reporter', 'active'), (other_user, organization, 'Other', 'active');
  perform set_config('request.jwt.claim.sub', reporter::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (reporter, organization, 'Super Administrator'), (other_user, organization, 'Field Worker');
  insert into public.company_settings(organization_id) values (organization);

  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    begin
      perform sentinel_private.save_anonymous_incident_draft(null, input, 'private-test');
      raise exception 'Anonymous draft bypassed the release gate';
    exception when check_violation then null;
    end;
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;
  saved := sentinel_private.save_anonymous_incident_draft(null, input, 'private-test');
  if saved.created_by is not null or saved.reported_by is not null or saved.digital_signature is not null
    or not saved.is_anonymous or saved.status <> 'draft' then
    raise exception 'Anonymous draft contains reporter identity';
  end if;
  if not exists (select 1 from sentinel_private.my_anonymous_incident_ids() own(id) where id = saved.id)
    or exists (select 1 from public.activity_logs where metadata->>'incident_id' = saved.id::text) then
    raise exception 'Draft ownership or audit privacy failed';
  end if;
  replay := sentinel_private.save_anonymous_incident_draft(null, input, 'private-test');
  if replay.id <> saved.id then raise exception 'Draft retry created a duplicate'; end if;
  replay := sentinel_private.save_anonymous_incident_draft(saved.id, input || '{"title":"Updated"}', null);
  if replay.title <> 'Updated' or replay.digital_signature is not null then
    raise exception 'Owner could not safely update the draft';
  end if;

  perform set_config('request.jwt.claim.sub', other_user::text, true);
  begin
    perform sentinel_private.save_anonymous_incident_draft(saved.id, input, null);
    raise exception 'Another user updated the private draft';
  exception when insufficient_privilege then
    null;
  end;
  begin
    perform sentinel_private.save_anonymous_incident_draft(null, input, 'private-test');
    raise exception 'Another user recovered the private draft through retry';
  exception when insufficient_privilege then
    null;
  end;
end;
$$;
rollback;
