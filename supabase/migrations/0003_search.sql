-- =============================================================================
-- LabGuard — 0003_search : fonctions RPC de recherche (sans vecteurs).
--
--   prepare_search_query(q)        -> plan de requête (normalisation, synonymes)
--   search_chunks(q, max_results)  -> passages des documents ACTIFS
--   search_analyses(q, max_results)-> fiches d'analyses des documents ACTIFS
--   read_document_page(id, page, context) -> texte intégral de page(s)
--
-- Toutes en SECURITY INVOKER : la RLS de l'appelant s'applique EN PLUS du
-- filtre explicite status = 'active'.
--
-- Plan de requête :
--   1. normalisation (minuscules, sans accents, ponctuation -> espaces) ;
--   2. expressions du glossaire reconnues -> groupes de synonymes ; on retire
--      du résidu ces expressions ET les mots de leur vocabulaire (« tube »
--      n'a plus de poids propre une fois « tube mauve » reconnu) ;
--   3. fautes de frappe sur un terme d'un mot du glossaire (Levenshtein) ;
--   4. mots restants significatifs (hors mots vides) = tokens.
--
-- Score de search_chunks (0..1) = moyenne pondérée des signaux disponibles :
--   0.45 * fts_score      part des tokens présents dans le passage (FTS français)
--   0.40 * synonym_score  part des groupes de synonymes présents dans le passage
--   0.15 * trigram_score  moyenne des word_similarity des tokens >= 4 lettres
--                         (tolérance aux fautes de frappe)
--   0.10 * densité        ts_rank_cd normalisé (départage)
-- Un signal sans objet (pas de token, pas de synonyme) est exclu de la moyenne.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Plan de requête
-- -----------------------------------------------------------------------------
drop function if exists public.prepare_search_query(text);
create function public.prepare_search_query(
  q text,
  out normalized text,
  out residual text,
  out tokens text[],
  out token_queries tsquery[],
  out fts_query tsquery,
  out synonym_groups text[],
  out synonym_terms text[],
  out group_queries tsquery[],
  out synonym_query tsquery
)
language plpgsql
stable
security invoker
set search_path = ''
as $$
declare
  v_padded text;
  v_tok text;
  v_group text;
  v_plain tsquery;
  v_group_query tsquery;
  v_term text;
begin
  normalized := coalesce(public.lg_tokens(left(coalesce(q, ''), 1000)), '');
  residual := normalized;
  tokens := '{}';
  token_queries := '{}';
  synonym_groups := '{}';
  synonym_terms := '{}';
  group_queries := '{}';
  if normalized = '' then
    return;
  end if;

  -- 1. Expressions du glossaire présentes telles quelles (bornes de mots).
  v_padded := ' ' || normalized || ' ';
  select coalesce(array_agg(distinct s.group_key), '{}')
    into synonym_groups
    from public.synonyms s
    where s.term_norm <> '' and v_padded like '% ' || s.term_norm || ' %';

  -- Retire ces expressions du résidu (les plus longues d'abord).
  for v_term in
    select s.term_norm from public.synonyms s
    where s.term_norm <> '' and v_padded like '% ' || s.term_norm || ' %'
    order by length(s.term_norm) desc
  loop
    residual := btrim(regexp_replace(
      replace(' ' || residual || ' ', ' ' || v_term || ' ', ' '), '\s+', ' ', 'g'));
  end loop;

  -- 2. Fautes de frappe sur un terme d'un seul mot (>= 5 lettres) du glossaire
  --    (« lavende » -> lavande) : distance de Levenshtein <= 1 (<= 2 à partir
  --    de 8 lettres). Le mot reste dans le résidu : il est aussi cherché tel
  --    quel, au cas où le rapprochement serait faux.
  for v_tok in
    select distinct t from unnest(string_to_array(residual, ' ')) as t
    where length(t) between 5 and 60 and t !~ '[0-9]'
  loop
    select s.group_key into v_group
      from public.synonyms s
      where position(' ' in s.term_norm) = 0
        and length(s.term_norm) >= 5
        and abs(length(s.term_norm) - length(v_tok)) <= 2
        and extensions.levenshtein(s.term_norm, v_tok)
            <= case when length(v_tok) >= 8 then 2 else 1 end
      order by extensions.levenshtein(s.term_norm, v_tok), s.group_key
      limit 1;
    if v_group is not null then
      synonym_groups := array(select distinct g from unnest(synonym_groups || v_group) g order by 1);
    end if;
    v_group := null;
  end loop;

  -- 3. Vocabulaire des groupes reconnus et une tsquery « OU » par groupe.
  if cardinality(synonym_groups) > 0 then
    synonym_terms := array(
      select distinct s.term_norm from public.synonyms s
      where s.group_key = any(synonym_groups) order by 1);
    foreach v_group in array synonym_groups loop
      v_group_query := null;
      for v_term in
        select s.term_norm from public.synonyms s where s.group_key = v_group order by 1
      loop
        v_plain := phraseto_tsquery('french'::regconfig, v_term);
        if numnode(v_plain) > 0 then
          v_group_query := case when v_group_query is null then v_plain
                                else v_group_query || v_plain end;
        end if;
      end loop;
      if v_group_query is not null then
        group_queries := group_queries || v_group_query;
        synonym_query := case when synonym_query is null then v_group_query
                              else synonym_query || v_group_query end;
      end if;
    end loop;
  end if;

  -- 4. Mots significatifs restants : hors mots vides du français et hors
  --    vocabulaire des groupes reconnus.
  tokens := array(
    select distinct t
    from unnest(string_to_array(residual, ' ')) as t
    where length(t) >= 2
      and numnode(plainto_tsquery('french'::regconfig, t)) > 0
      and not exists (
        select 1 from unnest(synonym_terms) as term
        where (' ' || term || ' ') like ('% ' || t || ' %')
      )
    order by 1
  );

  -- 5. Une tsquery par token, et leur « OU » : une question en langage naturel
  --    ne doit pas exiger tous les mots ; le score favorise la couverture.
  foreach v_tok in array tokens loop
    v_plain := plainto_tsquery('french'::regconfig, v_tok);
    token_queries := token_queries || v_plain;
    fts_query := case when fts_query is null then v_plain else fts_query || v_plain end;
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- search_chunks
-- -----------------------------------------------------------------------------
create or replace function public.search_chunks(q text, max_results integer default 8)
returns table (
  chunk_id          uuid,
  document_id       uuid,
  document_code     text,
  document_title    text,
  document_version  text,
  doc_type          text,
  page_number       integer,
  chunk_index       integer,
  kind              text,
  heading           text,
  content           text,
  score             real,
  fts_score         real,
  synonym_score     real,
  trigram_score     real,
  matched_synonyms  text[]
)
language sql
stable
security invoker
set search_path = ''
set pg_trgm.word_similarity_threshold = '0.5'
as $$
  with p as (
    select pq.*,
           case
             when pq.fts_query is null then pq.synonym_query
             when pq.synonym_query is null then pq.fts_query
             else pq.fts_query || pq.synonym_query
           end as any_query,
           array(select t from unnest(pq.tokens) t where length(t) >= 4) as trgm_tokens
    from public.prepare_search_query(q) pq
  ),
  cand as (
    select c.id
      from p, public.chunks c
      where p.any_query is not null and c.fts @@ p.any_query
    union
    select c.id
      from p
      cross join lateral unnest(p.trgm_tokens) as t(tok)
      join public.chunks c on c.search_norm operator(extensions.%>) t.tok
  ),
  scored as (
    select
      c.id, c.document_id, d.code, d.title, d.version, d.doc_type,
      c.page_number, c.chunk_index, c.kind, c.heading, c.content,
      -- part des tokens présents
      case when cardinality(p.token_queries) = 0 then null else (
        select count(*) filter (where c.fts @@ tq)::real / cardinality(p.token_queries)
        from unnest(p.token_queries) as tq
      ) end as fts_s,
      -- part des groupes de synonymes présents
      case when cardinality(p.group_queries) = 0 then null else (
        select count(*) filter (where c.fts @@ gq)::real / cardinality(p.group_queries)
        from unnest(p.group_queries) as gq
      ) end as syn_s,
      case when cardinality(p.trgm_tokens) = 0 then null else (
        select avg(extensions.word_similarity(t, c.search_norm))::real
        from unnest(p.trgm_tokens) as t
      ) end as trgm_s,
      coalesce(least(ts_rank_cd(c.fts, p.any_query, 32) * 4, 1), 0)::real as density_s,
      p.synonym_groups
    from cand
    join public.chunks c on c.id = cand.id
    join public.documents d on d.id = c.document_id and d.status = 'active'
    cross join p
  )
  select
    s.id, s.document_id, s.code, s.title, s.version, s.doc_type,
    s.page_number, s.chunk_index, s.kind, s.heading, s.content,
    ((0.45 * coalesce(s.fts_s, 0) + 0.40 * coalesce(s.syn_s, 0)
      + 0.15 * coalesce(s.trgm_s, 0) + 0.10 * s.density_s)
     / (case when s.fts_s is null then 0 else 0.45 end
        + case when s.syn_s is null then 0 else 0.40 end
        + case when s.trgm_s is null then 0 else 0.15 end
        + 0.10))::real,
    coalesce(s.fts_s, 0)::real, coalesce(s.syn_s, 0)::real, coalesce(s.trgm_s, 0)::real,
    s.synonym_groups
  from scored s
  order by 12 desc, s.id
  limit least(greatest(coalesce(max_results, 8), 1), 50)
$$;

-- -----------------------------------------------------------------------------
-- search_analyses
--
-- Score (0..1) : 0.55 * nom (meilleure word_similarity entre la fiche
-- [nom + synonymes + codes] et la question entière, ses tokens ou les termes
-- des groupes reconnus) + 0.25 * densité FTS (nom poids A, tubes/remarques
-- poids C) + 0.20 si un code de la fiche est un mot de la question.
-- -----------------------------------------------------------------------------
create or replace function public.search_analyses(q text, max_results integer default 5)
returns table (
  analysis_id        uuid,
  document_id        uuid,
  document_code      text,
  document_title     text,
  document_version   text,
  name               text,
  synonyms           text[],
  codes              text[],
  accepted_tubes     text[],
  rejected_tubes     text[],
  volume             text,
  transport          text,
  storage            text,
  stability          text,
  turnaround_time    text,
  remarks            text,
  source_chunk_id    uuid,
  source_quote       text,
  source_page_number integer,
  field_sources      jsonb,
  score              real,
  matched_synonyms   text[]
)
language sql
stable
security invoker
set search_path = ''
set pg_trgm.word_similarity_threshold = '0.5'
as $$
  with p as (
    select pq.*,
           case
             when pq.fts_query is null then pq.synonym_query
             when pq.synonym_query is null then pq.fts_query
             else pq.fts_query || pq.synonym_query
           end as any_query,
           array(
             select distinct x from unnest(
               array[pq.normalized] || pq.tokens || pq.synonym_terms
             ) as x
             where length(x) >= 3
           ) as name_probes,
           string_to_array(pq.normalized, ' ') as words
    from public.prepare_search_query(q) pq
  ),
  cand as (
    select a.id
      from p, public.analyses a
      where p.any_query is not null and a.fts @@ p.any_query
    union
    select a.id
      from p
      cross join lateral unnest(p.name_probes) as t(probe)
      join public.analyses a on a.search_norm operator(extensions.%>) t.probe
  ),
  scored as (
    select
      a.*,
      d.code as d_code, d.title as d_title, d.version as d_version,
      c.page_number as src_page,
      coalesce(least(ts_rank_cd(a.fts, p.any_query, 32) * 4, 1), 0) as fts_s,
      coalesce((
        select max(extensions.word_similarity(probe, a.search_norm))
        from unnest(p.name_probes) as probe
      ), 0) as name_s,
      exists (
        select 1 from unnest(a.codes) as code
        where (length(public.lg_tokens(code)) >= 2 and public.lg_tokens(code) = any(p.words))
           or public.lg_tokens(code) = p.normalized
      ) as code_hit,
      p.synonym_groups
    from cand
    join public.analyses a on a.id = cand.id
    join public.documents d on d.id = a.document_id and d.status = 'active'
    join public.chunks c on c.id = a.source_chunk_id
    cross join p
  )
  select
    s.id, s.document_id, s.d_code, s.d_title, s.d_version,
    s.name, s.synonyms, s.codes, s.accepted_tubes, s.rejected_tubes,
    s.volume, s.transport, s.storage, s.stability, s.turnaround_time, s.remarks,
    s.source_chunk_id, s.source_quote, s.src_page,
    coalesce((
      select jsonb_object_agg(fs.field, jsonb_build_object('chunk_id', fs.chunk_id, 'quote', fs.quote))
      from public.analysis_field_sources fs where fs.analysis_id = s.id
    ), '{}'::jsonb),
    least(1, 0.55 * s.name_s + 0.25 * s.fts_s + case when s.code_hit then 0.20 else 0 end)::real,
    s.synonym_groups
  from scored s
  order by 21 desc, s.name, s.id
  limit least(greatest(coalesce(max_results, 5), 1), 25)
$$;

-- -----------------------------------------------------------------------------
-- read_document_page
-- -----------------------------------------------------------------------------
create or replace function public.read_document_page(
  p_document_id uuid,
  p_page integer,
  p_context integer default 0
)
returns table (
  document_id       uuid,
  document_code     text,
  document_title    text,
  document_version  text,
  page_count        integer,
  page_number       integer,
  label             text,
  content           text
)
language sql
stable
security invoker
set search_path = ''
as $$
  select d.id, d.code, d.title, d.version, d.page_count,
         pg.page_number, pg.label, pg.content
  from public.documents d
  join public.document_pages pg on pg.document_id = d.id
  where d.id = p_document_id
    and d.status = 'active'
    and pg.page_number between p_page - least(greatest(coalesce(p_context, 0), 0), 2)
                           and p_page + least(greatest(coalesce(p_context, 0), 0), 2)
  order by pg.page_number
$$;

revoke execute on function public.prepare_search_query(text) from public, anon;
revoke execute on function public.search_chunks(text, integer) from public, anon;
revoke execute on function public.search_analyses(text, integer) from public, anon;
revoke execute on function public.read_document_page(uuid, integer, integer) from public, anon;
grant execute on function public.prepare_search_query(text) to authenticated, service_role;
grant execute on function public.search_chunks(text, integer) to authenticated, service_role;
grant execute on function public.search_analyses(text, integer) to authenticated, service_role;
grant execute on function public.read_document_page(uuid, integer, integer) to authenticated, service_role;
