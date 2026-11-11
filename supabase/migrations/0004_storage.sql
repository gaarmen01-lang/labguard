-- =============================================================================
-- LabGuard — 0004_storage : bucket privé « documents » et politiques.
--
-- Convention de chemin : <document_id>/<nom-de-fichier-assaini>
-- (documents.storage_path contient exactement storage.objects.name).
-- Les admins gèrent les fichiers ; les membres autorisés peuvent lire
-- l'original d'un document ACTIF (téléchargement via URL signée côté serveur
-- de préférence).
-- =============================================================================

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documents',
  'documents',
  false,
  52428800, -- 50 Mo
  array[
    'application/pdf',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'text/plain',
    'text/csv'
  ]
)
on conflict (id) do update
  set public = false,
      file_size_limit = excluded.file_size_limit,
      allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists labguard_documents_admin_all on storage.objects;
create policy labguard_documents_admin_all on storage.objects
  for all to authenticated
  using (bucket_id = 'documents' and (select public.is_admin()))
  with check (bucket_id = 'documents' and (select public.is_admin()));

drop policy if exists labguard_documents_member_read on storage.objects;
create policy labguard_documents_member_read on storage.objects
  for select to authenticated
  using (
    bucket_id = 'documents'
    and (select public.is_allowed())
    and exists (
      select 1 from public.documents d
      where d.storage_path = storage.objects.name and d.status = 'active'
    )
  );
