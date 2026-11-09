begin;
create extension if not exists pgtap with schema extensions;
select extensions.plan(32);

select extensions.ok(
  (select relrowsecurity from pg_class where oid = 'public.inspections'::regclass),
  'inspections has row-level security enabled'
);
select extensions.ok(
  (select relrowsecurity from pg_class where oid = 'public.actions'::regclass),
  'actions has row-level security enabled'
);

select extensions.ok(has_table_privilege('authenticated', 'public.inspections', 'SELECT'), 'authenticated can select inspections');
select extensions.ok(has_table_privilege('authenticated', 'public.inspections', 'INSERT'), 'authenticated can insert inspections');
select extensions.ok(has_table_privilege('authenticated', 'public.inspections', 'UPDATE'), 'authenticated can update inspections');
select extensions.ok(has_table_privilege('authenticated', 'public.actions', 'SELECT'), 'authenticated can select actions');
select extensions.ok(has_table_privilege('authenticated', 'public.actions', 'INSERT'), 'authenticated can insert actions');
select extensions.ok(has_table_privilege('authenticated', 'public.actions', 'UPDATE'), 'authenticated can update actions');

select extensions.ok(not has_table_privilege('authenticated', 'public.inspections', 'DELETE'), 'authenticated cannot delete inspections');
select extensions.ok(not has_table_privilege('authenticated', 'public.inspections', 'TRUNCATE'), 'authenticated cannot truncate inspections');
select extensions.ok(not has_table_privilege('authenticated', 'public.inspections', 'REFERENCES'), 'authenticated cannot reference inspections');
select extensions.ok(not has_table_privilege('authenticated', 'public.inspections', 'TRIGGER'), 'authenticated cannot create inspection triggers');
select extensions.ok(not has_table_privilege('authenticated', 'public.actions', 'DELETE'), 'authenticated cannot delete actions');
select extensions.ok(not has_table_privilege('authenticated', 'public.actions', 'TRUNCATE'), 'authenticated cannot truncate actions');
select extensions.ok(not has_table_privilege('authenticated', 'public.actions', 'REFERENCES'), 'authenticated cannot reference actions');
select extensions.ok(not has_table_privilege('authenticated', 'public.actions', 'TRIGGER'), 'authenticated cannot create action triggers');

select extensions.ok(not has_table_privilege('anon', 'public.inspections', 'SELECT'), 'anon cannot select inspections');
select extensions.ok(not has_table_privilege('anon', 'public.inspections', 'INSERT'), 'anon cannot insert inspections');
select extensions.ok(not has_table_privilege('anon', 'public.inspections', 'UPDATE'), 'anon cannot update inspections');
select extensions.ok(not has_table_privilege('anon', 'public.inspections', 'DELETE'), 'anon cannot delete inspections');
select extensions.ok(not has_table_privilege('anon', 'public.inspections', 'TRUNCATE'), 'anon cannot truncate inspections');
select extensions.ok(not has_table_privilege('anon', 'public.inspections', 'REFERENCES'), 'anon cannot reference inspections');
select extensions.ok(not has_table_privilege('anon', 'public.inspections', 'TRIGGER'), 'anon cannot create inspection triggers');
select extensions.ok(not has_table_privilege('anon', 'public.actions', 'SELECT'), 'anon cannot select actions');
select extensions.ok(not has_table_privilege('anon', 'public.actions', 'INSERT'), 'anon cannot insert actions');
select extensions.ok(not has_table_privilege('anon', 'public.actions', 'UPDATE'), 'anon cannot update actions');
select extensions.ok(not has_table_privilege('anon', 'public.actions', 'DELETE'), 'anon cannot delete actions');
select extensions.ok(not has_table_privilege('anon', 'public.actions', 'TRUNCATE'), 'anon cannot truncate actions');
select extensions.ok(not has_table_privilege('anon', 'public.actions', 'REFERENCES'), 'anon cannot reference actions');
select extensions.ok(not has_table_privilege('anon', 'public.actions', 'TRIGGER'), 'anon cannot create action triggers');

select extensions.is(
  (select file_size_limit from storage.buckets where id = 'incident-evidence'),
  10485760::bigint,
  'incident evidence bucket enforces the 10 MiB upload limit'
);
select extensions.is(
  (select public from storage.buckets where id = 'incident-evidence'),
  false,
  'incident evidence bucket remains private'
);

select * from extensions.finish();
rollback;
