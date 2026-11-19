update storage.buckets
set
  public = false,
  allowed_mime_types = case when allowed_mime_types is null then null else array(
    select distinct mime_type
    from unnest(allowed_mime_types || array[
    'image/jpeg',
    'image/png',
    'image/gif',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/rtf',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.ms-excel',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/csv',
    'text/tab-separated-values',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.ms-powerpoint',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.presentation',
    'text/plain',
    'text/markdown',
    'application/json'
    ]::text[]) as mime_type
    order by mime_type
  ) end
where id in ('hsse-policy-documents', 'legal-compliance-documents');

do $$
declare
  target_table text;
  constraint_name text;
  existing_check text;
  additional_types text[] := array[
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
      'image/bmp',
      'image/tiff',
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/rtf',
      'application/vnd.oasis.opendocument.text',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv',
      'text/tab-separated-values',
      'application/vnd.oasis.opendocument.spreadsheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.oasis.opendocument.presentation',
      'text/plain',
      'text/markdown',
      'application/json'
      ]::text[];
begin
  foreach target_table in array array['organization_policy_objectives', 'legal_compliance_obligation_versions']
  loop
      constraint_name := target_table || '_document_mime_type_check';
      select pg_get_expr(conbin, conrelid) into existing_check
      from pg_constraint
      where conrelid = format('public.%I', target_table)::regclass
        and conname = constraint_name and contype = 'c';
      if existing_check is not null then
        execute format('alter table public.%I drop constraint %I', target_table, constraint_name);
        execute format(
          'alter table public.%I add constraint %I check ((%s) or document_mime_type = any (%L::text[]))',
          target_table, constraint_name, existing_check, additional_types
        );
      end if;
  end loop;
end;
$$;
