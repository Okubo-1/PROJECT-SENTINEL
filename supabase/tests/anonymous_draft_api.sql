begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';
do $$
declare
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  token text;
  gate_active boolean;
  saved jsonb;
  replay jsonb;
  input jsonb := jsonb_build_object('reportType', 'incident', 'title', 'Private draft', 'digitalSignature', 'do not persist');
begin
  select exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
    and conname = 'incidents_anonymous_release_gate') into gate_active;
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
  perform set_config('role', 'authenticated', true);
  token := public.anonymous_draft_owner_token();
  if token like '%' || reporter::text || '%' then raise exception 'Token contains reporter ID'; end if;
  if gate_active then
    begin
      perform public.save_my_anonymous_draft(null, input, 'offline-test', token);
      raise exception 'Anonymous draft bypassed release gate';
    exception when check_violation then null;
    end;
  end if;
  perform set_config('role', 'postgres', true);
  if gate_active then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;
  perform set_config('role', 'authenticated', true);
  saved := public.save_my_anonymous_draft(null, input, 'offline-test', token);
  if saved::text like '%' || reporter::text || '%' or saved ? 'reported_by'
    or saved ? 'created_by' or saved ? 'digital_signature' then
    raise exception 'Anonymous draft response contains identity';
  end if;
  replay := public.save_my_anonymous_draft(null, input, 'offline-test', token);
  if replay->>'id' <> saved->>'id' or public.get_my_anonymous_draft((saved->>'id')::uuid)->>'id' <> saved->>'id' then
    raise exception 'Owner cannot retry or resume their draft';
  end if;
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  begin
    perform public.save_my_anonymous_draft(null, input, 'offline-test', token);
    raise exception 'Different user replayed owner token';
  exception when insufficient_privilege then null;
  end;
  begin
    perform public.get_my_anonymous_draft((saved->>'id')::uuid);
    raise exception 'Different user resumed private draft';
  exception when insufficient_privilege then null;
  end;
  perform set_config('role', 'postgres', true);
  if exists (select 1 from public.incidents where id = (saved->>'id')::uuid
      and (created_by is not null or reported_by is not null or digital_signature is not null))
    or exists (select 1 from public.activity_logs where metadata->>'incident_id' = saved->>'id') then
    raise exception 'Anonymous draft persisted reporter identity';
  end if;
end;
$$;
rollback;
