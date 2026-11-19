begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

do $$
declare
  admin_user uuid := gen_random_uuid();
  reporter uuid := gen_random_uuid();
  other_user uuid := gen_random_uuid();
  other_admin uuid := gen_random_uuid();
  organization uuid := gen_random_uuid();
  other_organization uuid := gen_random_uuid();
  owned public.incidents;
  other_report public.incidents;
  foreign_report public.incidents;
  role_name text;
  draft jsonb := '{"reportType":"incident","title":"Private draft","digitalSignature":"must not persist"}';
begin
  foreach role_name in array array['anon', 'authenticated', 'service_role'] loop
    if has_function_privilege(role_name, 'sentinel_private.my_anonymous_reports()', 'EXECUTE') then
      raise exception '% can execute the private report reader', role_name;
    end if;
  end loop;
  insert into auth.users(id, aud, role, email, encrypted_password, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
  select id, 'authenticated', 'authenticated', id::text || '@example.com', '', '{}'::jsonb, '{}'::jsonb, now(), now()
  from unnest(array[admin_user, reporter, other_user, other_admin]) as t(id);
  perform set_config('app.super_admin_initialization', 'on', true);
  insert into public.organizations(id, company_code, company_name, industry, company_size, country, state, contact_email, contact_phone, original_super_admin_id)
  values
    (organization, 'PRIVACY_' || upper(replace(organization::text, '-', '')), 'Privacy Test', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', admin_user),
    (other_organization, 'PRIVACY_' || upper(replace(other_organization::text, '-', '')), 'Privacy Test 2', 'Testing', '1-10', 'Nigeria', 'Lagos', 'privacy@example.com', '12345678', other_admin);
  insert into public.profiles(id, organization_id, full_name, account_status)
  values (admin_user, organization, 'Admin', 'active'), (reporter, organization, 'Reporter', 'active'),
    (other_user, organization, 'Other', 'active'), (other_admin, other_organization, 'Other admin', 'active');
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (admin_user, organization, 'Super Administrator'), (reporter, organization, 'Field Worker'),
    (other_user, organization, 'Field Worker');
  perform set_config('request.jwt.claim.sub', other_admin::text, true);
  insert into public.memberships(user_id, organization_id, role)
  values (other_admin, other_organization, 'Super Administrator');
  insert into public.company_settings(organization_id) values (organization), (other_organization);
  if exists (select 1 from pg_constraint where conrelid = 'public.incidents'::regclass
      and conname = 'incidents_anonymous_release_gate') then
    alter table public.incidents drop constraint incidents_anonymous_release_gate;
  end if;

  perform set_config('request.jwt.claim.sub', reporter::text, true);
  owned := sentinel_private.save_anonymous_incident_draft(null, draft, 'owned-reader-test');
  perform set_config('request.jwt.claim.sub', other_user::text, true);
  other_report := sentinel_private.save_anonymous_incident_draft(null, draft, 'other-reader-test');
  perform set_config('request.jwt.claim.sub', other_admin::text, true);
  foreign_report := sentinel_private.save_anonymous_incident_draft(null, draft, 'foreign-reader-test');

  perform set_config('request.jwt.claim.sub', reporter::text, true);
  if (select count(*) from sentinel_private.my_anonymous_reports()) <> 1
    or not exists (select 1 from sentinel_private.my_anonymous_reports() where id = owned.id)
    or exists (select 1 from sentinel_private.my_anonymous_reports() where id in (other_report.id, foreign_report.id)) then
    raise exception 'Anonymous reader did not isolate the owner';
  end if;
  if exists (select 1 from sentinel_private.my_anonymous_reports()
    where created_by is not null or reported_by is not null or digital_signature is not null) then
    raise exception 'Anonymous reader returned identity fields';
  end if;
  perform set_config('request.jwt.claim.sub', admin_user::text, true);
  if exists (select 1 from sentinel_private.my_anonymous_reports()) then
    raise exception 'Organization admin accessed another reporter''s drafts';
  end if;
  perform set_config('request.jwt.claim.sub', '', true);
  begin
    perform sentinel_private.my_anonymous_reports();
    raise exception 'Unauthenticated reader unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end;
$$;
rollback;
