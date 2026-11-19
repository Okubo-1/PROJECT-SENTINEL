begin;
set local lock_timeout = '2s';
set local statement_timeout = '30s';

-- A permissive policy must not override the bucket's restrictive policies.
create policy anonymous_evidence_test_permissive on storage.objects
for all to anon, authenticated
using (bucket_id = 'anonymous-incident-evidence')
with check (bucket_id = 'anonymous-incident-evidence');

do $$
declare
  role_name text;
  policy_count integer;
begin
  if not exists (select 1 from storage.buckets where id = 'anonymous-incident-evidence' and public = false) then
    raise exception 'Anonymous evidence bucket is missing or public';
  end if;
  select count(*) into policy_count from pg_policies
    where schemaname = 'storage' and tablename = 'objects'
      and policyname in ('anonymous_evidence_bucket_deny_select', 'anonymous_evidence_bucket_deny_insert',
        'anonymous_evidence_bucket_deny_update', 'anonymous_evidence_bucket_deny_delete')
      and permissive = 'RESTRICTIVE' and roles @> array['anon', 'authenticated']::name[];
  if policy_count <> 4 then raise exception 'Missing restrictive bucket policies'; end if;
  insert into storage.objects(bucket_id, name) values ('anonymous-incident-evidence', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000003');
  foreach role_name in array array['anon', 'authenticated'] loop
    perform set_config('role', role_name, true);
    if exists (select 1 from storage.objects where bucket_id = 'anonymous-incident-evidence') then
      raise exception '% can list the anonymous bucket', role_name;
    end if;
    begin
      insert into storage.objects(bucket_id, name) values ('anonymous-incident-evidence', '00000000-0000-4000-8000-000000000001/00000000-0000-4000-8000-000000000002/00000000-0000-4000-8000-000000000005');
      raise exception '% can upload to the anonymous bucket', role_name;
    exception when insufficient_privilege then null;
    end;
    update storage.objects set name = 'modified' where bucket_id = 'anonymous-incident-evidence';
    if found then raise exception '% can update the anonymous bucket', role_name; end if;
    begin
      delete from storage.objects where bucket_id = 'anonymous-incident-evidence';
      if found then raise exception '% can delete from the anonymous bucket', role_name; end if;
    exception when insufficient_privilege then null;
    end;
    perform set_config('role', 'postgres', true);
  end loop;
end;
$$;
rollback;
