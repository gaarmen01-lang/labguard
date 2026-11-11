-- =============================================================================
-- LabGuard — 0002_rls : privilèges et Row Level Security.
--
-- Modèle :
--   * anon             : aucun accès aux tables.
--   * authenticated    : lecture de la bibliothèque ACTIVE si profiles.allowed ;
--                        ses propres conversations ; écriture bibliothèque et
--                        utilisateurs réservée aux admins.
--   * service_role     : contourne la RLS (BYPASSRLS) ; utilisé uniquement côté
--                        serveur (ingestion, écriture des messages vérifiés,
--                        amorçage de la liste blanche).
-- Les politiques utilisent `(select fn())` pour que Postgres évalue les
-- helpers une seule fois par requête (initplan).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Privilèges de base (défense en profondeur ; la RLS reste la vraie barrière)
-- -----------------------------------------------------------------------------

grant usage on schema public to anon, authenticated, service_role;

revoke all on all tables in schema public from anon;
revoke all on all sequences in schema public from anon;

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

grant select on public.profiles to authenticated;
grant select, insert, update, delete on public.allowed_emails to authenticated;
grant select, insert, update, delete on public.documents to authenticated;
grant select, insert, update, delete on public.document_pages to authenticated;
grant select, insert, update, delete on public.chunks to authenticated;
grant select, insert, update, delete on public.analyses to authenticated;
grant select, insert, update, delete on public.analysis_field_sources to authenticated;
grant select, insert, update, delete on public.synonyms to authenticated;
grant select, insert, update, delete on public.ingestion_jobs to authenticated;
grant select, insert, update, delete on public.conversations to authenticated;
grant select on public.messages to authenticated;
grant select on public.message_sources to authenticated;
grant usage, select on all sequences in schema public to authenticated;

-- Fonctions : rien pour anon ; les triggers SECURITY DEFINER ne sont
-- exécutables par personne directement.
revoke execute on all functions in schema public from public, anon;
grant execute on function public.immutable_unaccent(text) to authenticated, service_role;
grant execute on function public.lg_normalize(text) to authenticated, service_role;
grant execute on function public.lg_tokens(text) to authenticated, service_role;
grant execute on function public.lg_array_text(text[]) to authenticated, service_role;
grant execute on function public.is_allowed() to authenticated, service_role;
grant execute on function public.is_admin() to authenticated, service_role;
grant execute on function public.activate_document(uuid) to authenticated, service_role;
grant execute on function public.archive_document(uuid) to authenticated, service_role;
grant execute on function public.set_updated_at() to authenticated, service_role;

-- -----------------------------------------------------------------------------
-- RLS
-- -----------------------------------------------------------------------------

alter table public.allowed_emails         enable row level security;
alter table public.profiles               enable row level security;
alter table public.documents              enable row level security;
alter table public.document_pages         enable row level security;
alter table public.chunks                 enable row level security;
alter table public.analyses               enable row level security;
alter table public.analysis_field_sources enable row level security;
alter table public.synonyms               enable row level security;
alter table public.ingestion_jobs         enable row level security;
alter table public.conversations          enable row level security;
alter table public.messages               enable row level security;
alter table public.message_sources        enable row level security;

-- profiles : chacun lit le sien, l'admin lit tout. Aucune écriture client
-- (rôle et autorisation viennent de allowed_emails via trigger).
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or (select public.is_admin()));

-- allowed_emails : admin uniquement.
drop policy if exists allowed_emails_admin on public.allowed_emails;
create policy allowed_emails_admin on public.allowed_emails
  for all to authenticated
  using ((select public.is_admin()))
  with check ((select public.is_admin()));

-- documents : les membres autorisés lisent les documents actifs ; l'admin
-- lit et écrit tout.
drop policy if exists documents_select on public.documents;
create policy documents_select on public.documents
  for select to authenticated
  using (
    (status = 'active' and (select public.is_allowed()))
    or (select public.is_admin())
  );

drop policy if exists documents_admin_insert on public.documents;
create policy documents_admin_insert on public.documents
  for insert to authenticated with check ((select public.is_admin()));
drop policy if exists documents_admin_update on public.documents;
create policy documents_admin_update on public.documents
  for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));
drop policy if exists documents_admin_delete on public.documents;
create policy documents_admin_delete on public.documents
  for delete to authenticated using ((select public.is_admin()));

-- Tables filles de documents : même règle de lecture (document parent actif).
drop policy if exists document_pages_select on public.document_pages;
create policy document_pages_select on public.document_pages
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_allowed()) and exists (
      select 1 from public.documents d
      where d.id = document_pages.document_id and d.status = 'active'))
  );
drop policy if exists document_pages_admin_write on public.document_pages;
create policy document_pages_admin_write on public.document_pages
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists chunks_select on public.chunks;
create policy chunks_select on public.chunks
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_allowed()) and exists (
      select 1 from public.documents d
      where d.id = chunks.document_id and d.status = 'active'))
  );
drop policy if exists chunks_admin_write on public.chunks;
create policy chunks_admin_write on public.chunks
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists analyses_select on public.analyses;
create policy analyses_select on public.analyses
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_allowed()) and exists (
      select 1 from public.documents d
      where d.id = analyses.document_id and d.status = 'active'))
  );
drop policy if exists analyses_admin_write on public.analyses;
create policy analyses_admin_write on public.analyses
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

drop policy if exists analysis_field_sources_select on public.analysis_field_sources;
create policy analysis_field_sources_select on public.analysis_field_sources
  for select to authenticated
  using (
    (select public.is_admin())
    or ((select public.is_allowed()) and exists (
      select 1 from public.analyses a
      join public.documents d on d.id = a.document_id
      where a.id = analysis_field_sources.analysis_id and d.status = 'active'))
  );
drop policy if exists analysis_field_sources_admin_write on public.analysis_field_sources;
create policy analysis_field_sources_admin_write on public.analysis_field_sources
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- synonyms : lecture pour les membres autorisés, écriture admin.
drop policy if exists synonyms_select on public.synonyms;
create policy synonyms_select on public.synonyms
  for select to authenticated using ((select public.is_allowed()));
drop policy if exists synonyms_admin_write on public.synonyms;
create policy synonyms_admin_write on public.synonyms
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- ingestion_jobs : admin uniquement (le traitement lui-même tourne en
-- service_role).
drop policy if exists ingestion_jobs_admin on public.ingestion_jobs;
create policy ingestion_jobs_admin on public.ingestion_jobs
  for all to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- conversations : strictement personnelles (y compris pour les admins).
drop policy if exists conversations_owner_select on public.conversations;
create policy conversations_owner_select on public.conversations
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()));
drop policy if exists conversations_owner_insert on public.conversations;
create policy conversations_owner_insert on public.conversations
  for insert to authenticated
  with check (user_id = (select auth.uid()) and (select public.is_allowed()));
drop policy if exists conversations_owner_update on public.conversations;
create policy conversations_owner_update on public.conversations
  for update to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()))
  with check (user_id = (select auth.uid()));
drop policy if exists conversations_owner_delete on public.conversations;
create policy conversations_owner_delete on public.conversations
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- messages / message_sources : lecture par le propriétaire uniquement.
-- Écriture exclusivement par le serveur (service_role) : un client ne peut
-- pas fabriquer une réponse « vérifiée » avec de fausses citations.
drop policy if exists messages_owner_select on public.messages;
create policy messages_owner_select on public.messages
  for select to authenticated
  using (user_id = (select auth.uid()) and (select public.is_allowed()));

drop policy if exists message_sources_owner_select on public.message_sources;
create policy message_sources_owner_select on public.message_sources
  for select to authenticated
  using (
    (select public.is_allowed()) and exists (
      select 1 from public.messages m
      where m.id = message_sources.message_id and m.user_id = (select auth.uid()))
  );
