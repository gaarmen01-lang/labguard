-- =============================================================================
-- LabGuard — 0001_init : extensions, fonctions utilitaires, tables, index,
-- triggers. Les politiques RLS sont dans 0002, la recherche dans 0003, le
-- stockage dans 0004, le glossaire dans 0005.
--
-- Conventions :
--   * identifiants en anglais snake_case ;
--   * toutes les fonctions fixent leur search_path ('' = tout est qualifié) ;
--   * migrations rejouables autant que raisonnable (if not exists / or replace).
-- =============================================================================

create schema if not exists extensions;

create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;
create extension if not exists fuzzystrmatch with schema extensions;
-- gen_random_uuid() est natif depuis Postgres 13 : pas besoin de pgcrypto.

-- -----------------------------------------------------------------------------
-- Normalisation de texte
-- -----------------------------------------------------------------------------

-- unaccent() n'est pas IMMUTABLE (il dépend du dictionnaire chargé), ce qui
-- interdit son usage dans une colonne générée ou un index. Ce wrapper fige le
-- dictionnaire (qualifié explicitement) et peut donc être déclaré IMMUTABLE.
create or replace function public.immutable_unaccent(input text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select extensions.unaccent('extensions.unaccent'::regdictionary, input)
$$;

-- Minuscules + sans accents. Base de toutes les comparaisons « humaines ».
create or replace function public.lg_normalize(input text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select lower(public.immutable_unaccent(input))
$$;

-- Normalisation en « tokens » : minuscules, sans accents, tout ce qui n'est pas
-- [a-z0-9] devient une espace, espaces multiples réduites. Sert aux
-- correspondances de synonymes (« Tube mauve » -> « tube mauve »,
-- « K2-EDTA » -> « k2 edta »). Doit rester aligné avec normalizeTokens()
-- côté TypeScript (src/lib/contracts/text.ts).
create or replace function public.lg_tokens(input text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select btrim(regexp_replace(public.lg_normalize(input), '[^a-z0-9]+', ' ', 'g'))
$$;

-- Concatène un text[] (array_to_string est STABLE, d'où ce wrapper).
create or replace function public.lg_array_text(input text[])
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select coalesce(string_agg(item, ' '), '') from unnest(input) as item
$$;

-- Trigger générique updated_at.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- Utilisateurs
-- -----------------------------------------------------------------------------

-- Liste blanche gérée par les admins. Une adresse absente ne peut rien lire,
-- même si un compte Auth existe pour elle.
create table if not exists public.allowed_emails (
  email       text primary key
              check (email = lower(btrim(email)) and position('@' in email) > 1),
  role        text not null default 'member' check (role in ('admin', 'member')),
  note        text,
  created_by  uuid,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.profiles (
  id           uuid primary key references auth.users (id) on delete cascade,
  email        text not null,
  display_name text,
  role         text not null default 'member' check (role in ('admin', 'member')),
  allowed      boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create index if not exists profiles_email_idx on public.profiles (lower(email));

alter table public.allowed_emails
  drop constraint if exists allowed_emails_created_by_fkey;
alter table public.allowed_emails
  add constraint allowed_emails_created_by_fkey
  foreign key (created_by) references public.profiles (id) on delete set null;

-- Création du profil à l'inscription : rôle et autorisation dérivés de
-- allowed_emails. SECURITY DEFINER car déclenché par le service Auth.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text;
begin
  select a.role into v_role
  from public.allowed_emails a
  where a.email = lower(btrim(new.email));

  insert into public.profiles (id, email, role, allowed)
  values (
    new.id,
    lower(btrim(coalesce(new.email, ''))),
    coalesce(v_role, 'member'),
    v_role is not null
  )
  on conflict (id) do update
    set email = excluded.email,
        role = excluded.role,
        allowed = excluded.allowed;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Toute modification de la liste blanche est répercutée sur les profils
-- existants (ajout, changement de rôle, révocation).
create or replace function public.sync_profile_from_allowed_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'DELETE' then
    update public.profiles
      set allowed = false, role = 'member'
      where lower(email) = old.email;
    return old;
  end if;

  if tg_op = 'UPDATE' and old.email <> new.email then
    update public.profiles
      set allowed = false, role = 'member'
      where lower(email) = old.email;
  end if;

  update public.profiles
    set allowed = true, role = new.role
    where lower(email) = new.email;
  return new;
end;
$$;

drop trigger if exists allowed_emails_sync on public.allowed_emails;
create trigger allowed_emails_sync
  after insert or update or delete on public.allowed_emails
  for each row execute function public.sync_profile_from_allowed_email();

drop trigger if exists allowed_emails_updated_at on public.allowed_emails;
create trigger allowed_emails_updated_at
  before update on public.allowed_emails
  for each row execute function public.set_updated_at();

drop trigger if exists profiles_updated_at on public.profiles;
create trigger profiles_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Helpers utilisés par les politiques RLS. SECURITY DEFINER pour lire
-- profiles sans récursion RLS ; ils ne révèlent que l'état de l'appelant.
create or replace function public.is_allowed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.allowed from public.profiles p where p.id = auth.uid()),
    false
  )
$$;

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(
    (select p.allowed and p.role = 'admin' from public.profiles p where p.id = auth.uid()),
    false
  )
$$;

-- -----------------------------------------------------------------------------
-- Bibliothèque documentaire
-- -----------------------------------------------------------------------------

do $$
begin
  if not exists (select 1 from pg_type where typname = 'document_status' and typnamespace = 'public'::regnamespace) then
    create type public.document_status as enum ('draft', 'active', 'archived');
  end if;
end;
$$;

create table if not exists public.documents (
  id                uuid primary key default gen_random_uuid(),
  -- Identifiant logique stable entre versions (ex. « MP-PRE-001 »).
  code              text not null check (length(btrim(code)) between 1 and 100),
  title             text not null check (length(btrim(title)) between 1 and 300),
  -- Libellé de version tel qu'écrit dans le document (« 3 », « 2024-02 »…).
  version           text not null check (length(btrim(version)) between 1 and 50),
  doc_type          text not null default 'procedure'
                    check (doc_type in ('sampling_manual', 'test_catalog', 'procedure', 'other')),
  status            public.document_status not null default 'draft',
  effective_date    date,
  -- Fichier original dans le bucket privé « documents » : <document_id>/<nom>.
  storage_path      text unique,
  original_filename text,
  mime_type         text,
  file_size         bigint check (file_size is null or file_size >= 0),
  sha256            text check (sha256 is null or sha256 ~ '^[0-9a-f]{64}$'),
  page_count        integer check (page_count is null or page_count >= 0),
  -- État de l'ingestion (piloté par la tâche 2 via ingestion_jobs).
  ingestion_status  text not null default 'pending'
                    check (ingestion_status in ('pending', 'processing', 'ready', 'failed')),
  ingestion_error   text,
  activated_at      timestamptz,
  archived_at       timestamptz,
  created_by        uuid references public.profiles (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  constraint documents_code_version_key unique (code, version)
);

-- Au plus une version active par code.
create unique index if not exists documents_one_active_per_code
  on public.documents (code) where status = 'active';
create index if not exists documents_status_idx on public.documents (status);

drop trigger if exists documents_updated_at on public.documents;
create trigger documents_updated_at
  before update on public.documents
  for each row execute function public.set_updated_at();

-- Texte intégral par page (pagination 1-based ; un DOCX/TXT/CSV sans
-- pagination native est découpé en « pages » logiques par l'ingestion).
create table if not exists public.document_pages (
  document_id uuid not null references public.documents (id) on delete cascade,
  page_number integer not null check (page_number >= 1),
  content     text not null,
  -- Libellé affichable (« p. 3 », « Feuille Tarifs », « Section 2 »).
  label       text,
  primary key (document_id, page_number)
);

create table if not exists public.chunks (
  id           uuid primary key default gen_random_uuid(),
  document_id  uuid not null references public.documents (id) on delete cascade,
  page_number  integer not null,
  -- Ordre global du chunk dans le document (0-based).
  chunk_index  integer not null check (chunk_index >= 0),
  kind         text not null default 'text' check (kind in ('text', 'table_row', 'table')),
  -- Titre de section / chemin (« 3. Prélèvements > Hématologie »).
  heading      text,
  content      text not null check (length(content) > 0),
  -- Position du contenu dans document_pages.content (si connue).
  char_start   integer,
  char_end     integer,
  metadata     jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now(),
  fts          tsvector generated always as (
                 to_tsvector('french'::regconfig,
                   public.immutable_unaccent(coalesce(heading, '') || ' ' || content))
               ) stored,
  search_norm  text generated always as (
                 public.lg_normalize(coalesce(heading, '') || ' ' || content)
               ) stored,
  constraint chunks_document_index_key unique (document_id, chunk_index),
  constraint chunks_page_fkey foreign key (document_id, page_number)
    references public.document_pages (document_id, page_number) on delete cascade
);

create index if not exists chunks_fts_idx on public.chunks using gin (fts);
create index if not exists chunks_trgm_idx on public.chunks using gin (search_norm extensions.gin_trgm_ops);
create index if not exists chunks_document_page_idx on public.chunks (document_id, page_number);

-- Fiches d'analyses extraites des documents. Chaque champ renseigné doit avoir
-- sa citation dans analysis_field_sources ; source_chunk_id/source_quote
-- désignent la citation qui identifie la fiche (nom de l'analyse).
create table if not exists public.analyses (
  id                uuid primary key default gen_random_uuid(),
  document_id       uuid not null references public.documents (id) on delete cascade,
  name              text not null check (length(btrim(name)) > 0),
  synonyms          text[] not null default '{}',
  codes             text[] not null default '{}',
  accepted_tubes    text[] not null default '{}',
  rejected_tubes    text[] not null default '{}',
  volume            text,
  transport         text,
  storage           text,
  stability         text,
  turnaround_time   text,
  remarks           text,
  source_chunk_id   uuid not null references public.chunks (id) on delete cascade,
  source_quote      text not null check (length(source_quote) > 0),
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  search_norm       text generated always as (
                      public.lg_tokens(name || ' ' || public.lg_array_text(synonyms)
                        || ' ' || public.lg_array_text(codes))
                    ) stored,
  fts               tsvector generated always as (
                      setweight(to_tsvector('french'::regconfig,
                        public.immutable_unaccent(name || ' ' || public.lg_array_text(synonyms)
                          || ' ' || public.lg_array_text(codes))), 'A')
                      || setweight(to_tsvector('french'::regconfig,
                        public.immutable_unaccent(public.lg_array_text(accepted_tubes)
                          || ' ' || public.lg_array_text(rejected_tubes)
                          || ' ' || coalesce(remarks, ''))), 'C')
                    ) stored
);

create index if not exists analyses_document_idx on public.analyses (document_id);
create index if not exists analyses_fts_idx on public.analyses using gin (fts);
create index if not exists analyses_trgm_idx on public.analyses using gin (search_norm extensions.gin_trgm_ops);

drop trigger if exists analyses_updated_at on public.analyses;
create trigger analyses_updated_at
  before update on public.analyses
  for each row execute function public.set_updated_at();

-- Citation vérifiée par champ de fiche (une par champ).
create table if not exists public.analysis_field_sources (
  analysis_id uuid not null references public.analyses (id) on delete cascade,
  field       text not null check (field in (
                'name', 'synonyms', 'codes', 'accepted_tubes', 'rejected_tubes', 'volume',
                'transport', 'storage', 'stability', 'turnaround_time', 'remarks')),
  chunk_id    uuid not null references public.chunks (id) on delete cascade,
  quote       text not null check (length(quote) > 0),
  primary key (analysis_id, field)
);

create index if not exists analysis_field_sources_chunk_idx on public.analysis_field_sources (chunk_id);

-- Glossaire de synonymes labo. Les termes d'un même group_key sont
-- équivalents pour la recherche (« tube mauve » = « EDTA » = « tube violet »).
create table if not exists public.synonyms (
  id          bigint generated always as identity primary key,
  group_key   text not null check (group_key ~ '^[a-z0-9_]+$'),
  term        text not null check (length(btrim(term)) > 0),
  term_norm   text generated always as (public.lg_tokens(term)) stored,
  note        text,
  created_at  timestamptz not null default now(),
  constraint synonyms_group_term_key unique (group_key, term_norm)
);

create index if not exists synonyms_term_norm_idx on public.synonyms (term_norm);

-- Ingestion par lots (une ligne = un traitement d'un document, repris en
-- plusieurs invocations courtes via `cursor`).
create table if not exists public.ingestion_jobs (
  id            uuid primary key default gen_random_uuid(),
  document_id   uuid not null references public.documents (id) on delete cascade,
  status        text not null default 'queued'
                check (status in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  stage         text not null default 'parse'
                check (stage in ('parse', 'chunk', 'extract_analyses', 'finalize')),
  -- Point de reprise libre (ex. { "next_page": 12 }), propriété de la tâche 2.
  cursor        jsonb not null default '{}'::jsonb,
  progress      integer not null default 0 check (progress >= 0),
  total         integer check (total is null or total >= 0),
  attempts      integer not null default 0 check (attempts >= 0),
  last_error    text,
  locked_at     timestamptz,
  locked_by     text,
  created_by    uuid references public.profiles (id) on delete set null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  finished_at   timestamptz
);

create index if not exists ingestion_jobs_document_idx on public.ingestion_jobs (document_id);
create index if not exists ingestion_jobs_pending_idx on public.ingestion_jobs (created_at)
  where status in ('queued', 'running');

drop trigger if exists ingestion_jobs_updated_at on public.ingestion_jobs;
create trigger ingestion_jobs_updated_at
  before update on public.ingestion_jobs
  for each row execute function public.set_updated_at();

-- Activation d'une version : archive la version active du même code puis
-- active celle-ci, dans la même transaction. Exige une ingestion terminée.
-- SECURITY INVOKER : les RLS imposent que l'appelant soit admin.
create or replace function public.activate_document(p_document_id uuid)
returns public.documents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  select * into v_doc from public.documents where id = p_document_id for update;
  if not found then
    raise exception 'document % introuvable', p_document_id using errcode = 'P0002';
  end if;
  if v_doc.ingestion_status <> 'ready' then
    raise exception 'le document % n''est pas prêt (ingestion : %)', p_document_id, v_doc.ingestion_status
      using errcode = '22023';
  end if;
  if v_doc.status = 'active' then
    return v_doc;
  end if;

  update public.documents
    set status = 'archived', archived_at = now()
    where code = v_doc.code and status = 'active' and id <> p_document_id;

  update public.documents
    set status = 'active', activated_at = now(), archived_at = null
    where id = p_document_id
    returning * into v_doc;

  if not found then
    raise exception 'activation refusée pour %', p_document_id using errcode = '42501';
  end if;
  return v_doc;
end;
$$;

create or replace function public.archive_document(p_document_id uuid)
returns public.documents
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_doc public.documents;
begin
  update public.documents
    set status = 'archived', archived_at = now()
    where id = p_document_id
    returning * into v_doc;
  if not found then
    raise exception 'document % introuvable ou accès refusé', p_document_id using errcode = 'P0002';
  end if;
  return v_doc;
end;
$$;

-- -----------------------------------------------------------------------------
-- Conversations
-- -----------------------------------------------------------------------------

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.profiles (id) on delete cascade,
  title       text not null default 'Nouvelle conversation' check (length(title) <= 200),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists conversations_user_idx on public.conversations (user_id, updated_at desc);

drop trigger if exists conversations_updated_at on public.conversations;
create trigger conversations_updated_at
  before update on public.conversations
  for each row execute function public.set_updated_at();

create table if not exists public.messages (
  id               uuid primary key default gen_random_uuid(),
  conversation_id  uuid not null references public.conversations (id) on delete cascade,
  -- Dénormalisé pour des politiques RLS simples ; contrôlé par trigger.
  user_id          uuid not null references public.profiles (id) on delete cascade,
  role             text not null check (role in ('user', 'assistant')),
  -- Texte affichable (question, ou réponse finale mise à plat).
  content          text not null,
  -- Réponse structurée vérifiée (FinalAnswer, cf. src/lib/contracts/answer.ts).
  answer           jsonb,
  status           text not null default 'complete'
                   check (status in ('complete', 'insufficient', 'error')),
  verdict          text check (verdict in ('conforme', 'non_conforme', 'a_verifier')),
  llm_provider     text,
  llm_model        text,
  usage            jsonb,
  latency_ms       integer check (latency_ms is null or latency_ms >= 0),
  created_at       timestamptz not null default now()
);

create index if not exists messages_conversation_idx on public.messages (conversation_id, created_at);

create or replace function public.messages_check_owner()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.conversations c
    where c.id = new.conversation_id and c.user_id = new.user_id
  ) then
    raise exception 'messages.user_id doit être le propriétaire de la conversation'
      using errcode = '23514';
  end if;
  return new;
end;
$$;

drop trigger if exists messages_owner_check on public.messages;
create trigger messages_owner_check
  before insert or update of conversation_id, user_id on public.messages
  for each row execute function public.messages_check_owner();

-- Sources citées d'une réponse. Snapshot (titre, version, page, extrait) pour
-- rester consultable après archivage ou suppression du document.
create table if not exists public.message_sources (
  id                uuid primary key default gen_random_uuid(),
  message_id        uuid not null references public.messages (id) on delete cascade,
  paragraph_index   integer not null check (paragraph_index >= 0),
  citation_index    integer not null check (citation_index >= 0),
  chunk_id          uuid references public.chunks (id) on delete set null,
  document_id       uuid references public.documents (id) on delete set null,
  document_code     text not null,
  document_title    text not null,
  document_version  text not null,
  page_number       integer not null,
  quote             text not null,
  excerpt           text not null,
  created_at        timestamptz not null default now(),
  constraint message_sources_position_key unique (message_id, paragraph_index, citation_index)
);

create index if not exists message_sources_message_idx on public.message_sources (message_id);
