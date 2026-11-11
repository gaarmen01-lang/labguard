# LabGuard — architecture

LabGuard est un assistant en français pour le personnel d'un laboratoire d'analyses médicales. Il répond **uniquement** à partir des documents du laboratoire (manuel de prélèvement, catalogue d'analyses, procédures PDF texte / DOCX / TXT / XLSX / CSV), avec des citations vérifiables (document, version, page, extrait). Si les documents ne permettent pas de répondre, il le dit : jamais de connaissance générale pour combler un trou.

> Exemple : « Pour l'analyse X je n'ai reçu qu'un tube mauve, puis-je faire l'analyse ? » → recherche dans les fiches d'analyses et les documents (tube mauve = EDTA via le glossaire) → réponse citée, ou « information insuffisante ».

## 1. Vue d'ensemble

```
Navigateur ──► proxy.ts (CSP nonce, refresh session, garde) ──► Next.js App Router (Vercel)
                                                                  │
          pages (app)/ ── requirePageUser/Admin                  │ routes api/ ── requireUser/Admin
                                                                  ▼
                                   Supabase : Auth (lien magique) · Postgres 17 (RLS) · Storage (bucket privé)
                                                                  ▲
                         boucle agent (≤ 4 tours) ── LlmProvider (Mistral | Anthropic | OpenAI-compatible | Fake)
```

| Brique | Choix |
| --- | --- |
| Framework | Next.js 16 (App Router), TypeScript strict, pnpm, Node 22 |
| Données | Supabase : Postgres + Auth + Storage, RLS sur toutes les tables |
| Recherche | **Pas de vecteurs en v1.** FTS Postgres `french` + `unaccent`, `pg_trgm` (fautes de frappe), `fuzzystrmatch` (Levenshtein sur le glossaire), glossaire `synonyms` |
| LLM | Interface `LlmProvider` agnostique ; sélection par `LLM_PROVIDER` / `LLM_MODEL` / `LLM_API_KEY` |
| Tests | Vitest ; base réelle en mémoire via PGlite (Postgres WASM) + shim Supabase |

## 2. Arborescence

```
supabase/migrations/          Schéma SQL (ordre lexical, rejouable)
  0001_init.sql               extensions, normalisation, tables, triggers, activate/archive_document
  0002_rls.sql                privilèges + politiques RLS
  0003_search.sql             prepare_search_query, search_chunks, search_analyses, read_document_page
  0004_storage.sql            bucket privé « documents » + politiques
  0005_seed_synonyms.sql      glossaire labo initial
src/
  proxy.ts                    CSP + session + redirection /login (ex-middleware)
  app/
    layout.tsx, globals.css   racine (lang=fr, rendu dynamique pour le nonce)
    login/                    page de connexion (lien magique)
    auth/confirm/route.ts     retour du lien (token_hash ou code PKCE) + contrôle liste blanche
    auth/signout/route.ts     déconnexion (POST)
    api/auth/magic-link/      demande de lien (réponse identique autorisé / non autorisé)
    (app)/                    zone protégée : page d'accueil (placeholder chat), admin/ (placeholder)
  components/                 composants UI (login-form)
  lib/
    contracts/                CONTRATS PARTAGÉS (types + zod, aucune logique métier)
    env.ts, env-public.ts     variables d'environnement validées paresseusement
    supabase/                 client navigateur, serveur (cookies), admin (service_role)
    auth/                     session (requireUser…), allowlist, erreurs HTTP, redirections sûres
    security/csp.ts           construction de la CSP
tests/
  helpers/db.ts               base PGlite + migrations + helpers asUser/asAnon/asServiceRole
  helpers/corpus.ts           mini corpus fictif réutilisable
  helpers/supabase-shim.sql   shim auth/storage/rôles pour PGlite
  db/                         tests SQL (recherche, RLS, parité de normalisation)
  unit/                       tests des contrats, env, sécurité
```

## 3. Modèle de données (résumé)

| Table | Rôle | Lecture | Écriture |
| --- | --- | --- | --- |
| `allowed_emails` | liste blanche (email, rôle) | admin | admin (+ service_role pour l'amorçage) |
| `profiles` | 1 ligne par `auth.users` ; `role`, `allowed` dérivés de `allowed_emails` par trigger | soi / admin | aucun client (triggers) |
| `documents` | métadonnées, `code` + `version`, `status` draft→active→archived, `ingestion_status`, `storage_path` | membres : actifs ; admin : tout | admin |
| `document_pages` | texte intégral par page (1-based) | idem document parent | admin / ingestion |
| `chunks` | passages (~800-1200 car.) ; `fts` (tsvector `french`+unaccent) et `search_norm` (trigrammes) générés | idem | admin / ingestion |
| `analyses` + `analysis_field_sources` | fiche par analyse ; chaque champ renseigné a sa citation (`chunk_id`, `quote`) | idem | admin / ingestion |
| `synonyms` | glossaire (`group_key`, `term`, `term_norm` généré) | membres autorisés | admin |
| `ingestion_jobs` | traitement par lots (`stage`, `cursor`, `progress`, verrou) | admin | admin / service_role |
| `conversations` | par utilisateur | propriétaire | propriétaire |
| `messages`, `message_sources` | réponses vérifiées + snapshot des sources | propriétaire | **service_role uniquement** |

Règles clés :
- **Une seule version active par `code`** (index unique partiel). `activate_document(id)` archive l'active du même code et active la nouvelle dans la même transaction ; refuse si `ingestion_status <> 'ready'`.
- Seuls les documents `active` sont interrogeables : les RPC filtrent explicitement **et** la RLS s'applique (fonctions `SECURITY INVOKER`, `search_path` vide).
- `unaccent` n'étant pas IMMUTABLE, le wrapper `immutable_unaccent()` (dictionnaire qualifié) sert aux colonnes générées. `lg_normalize` / `lg_tokens` sont les normalisations SQL ; `normalizeText` / `normalizeTokens` (`src/lib/contracts/text.ts`) en sont les miroirs TypeScript, testés en parité.
- `message_sources` garde titre, version, page, citation et extrait : une réponse reste consultable après archivage ou suppression du document (`chunk_id`/`document_id` passent à null).
- Bucket Storage privé `documents`, chemin `<document_id>/<fichier>` = `documents.storage_path`. Admin : tout ; membre : lecture des originaux de documents actifs.

### Recherche

`prepare_search_query(q)` produit le plan : normalisation → expressions du glossaire reconnues (groupes) puis retrait de leur vocabulaire du résidu → fautes de frappe sur les termes d'un mot (Levenshtein ≤ 1, ≤ 2 dès 8 lettres) → tokens significatifs (hors mots vides).

- `search_chunks(q, max_results=8)` : candidats = FTS (`OU` des tokens et des synonymes) ∪ trigrammes (`%>` par token ≥ 4 lettres). Score 0..1 = moyenne pondérée des signaux disponibles : part des tokens présents (0.45), part des groupes de synonymes présents (0.40), similarité trigramme (0.15), densité `ts_rank_cd` (0.10). Renvoie chunk, document (code, titre, version, type), page, scores détaillés, groupes reconnus.
- `search_analyses(q, max_results=5)` : fiches + `field_sources` (jsonb champ → `{chunk_id, quote}`) + page source ; score = nom (0.55) + FTS (0.25) + code exact (0.20).
- `read_document_page(document_id, page, context=0..2)` : texte intégral des pages d'un document actif.

## 4. Contrats (`src/lib/contracts/`)

| Fichier | Contenu |
| --- | --- |
| `domain.ts` | types du domaine (zod → TS) : `LabDocument`, `DocumentPage`, `Chunk`, `AnalysisSheet`, `ExtractedAnalysis`, `Synonym`, `IngestionJob`, `Profile`, `Conversation`, `Message`, `Source`, résultats RPC (`ChunkSearchResult`, `AnalysisSearchResult`, `PageReadResult`), libellés FR |
| `answer.ts` | `finalAnswerSchema` (sortie LLM : `{ insufficient, verdict, paragraphs[{ text, citations[{ chunk_id, quote }] }] }` + règles), `FINAL_ANSWER_JSON_SCHEMA` (mode strict fournisseurs), `VerifiedAnswer`, `AnswerVerificationResult`, `insufficientAnswer()` |
| `llm.ts` | `LlmProvider.chat(LlmChatRequest) → LlmChatResponse`, messages (system/user/assistant+toolCalls/tool), `LlmToolDefinition` (JSON Schema), `LlmResponseFormat` (json_schema), usage, `LlmConfig`, `LlmError` (codes stables) |
| `tools.ts` | outils agent `search_analyses`, `search_documents`, `read_page` : schémas d'arguments, définitions LLM, `AgentToolExecutor` (+ `getChunks?` optionnel, non exposé au LLM), `ChunkRecord`, `AGENT_MAX_TURNS = 4` |
| `chat-events.ts` | événements SSE de `/api/chat` : `conversation` → `step`* → `answer` → `done` (ou `error`) |
| `api.ts` | payloads des routes : auth, chat, conversations, admin documents (upload signé direct vers Storage, ingestion par pas), admin utilisateurs ; `ApiErrorBody` |
| `database.ts` | type `Database` pour supabase-js (écrit à la main, régénérable via `supabase gen types`) |
| `text.ts` | `normalizeText`, `normalizeTokens`, `joinHyphenation`, `quoteAppearsIn` (base de la vérification des citations) |

**Vérification des citations** (tâche 3, `src/lib/agent/verify.ts`) : la réponse LLM est validée par `finalAnswerSchema` (une réparation du JSON au plus), puis pour chaque citation : `chunk_id` doit faire partie des chunks renvoyés par les outils pendant ce tour (donc d'un document actif), `quoteAppearsIn(quote, texte du chunk)` doit être vrai (mots entiers après normalisation, césures tolérées), la citation doit faire au moins 3 mots / 12 caractères (sauf extrait de fiche entier), ne pas ressembler à une consigne adressée à l'assistant (injection), et la page doit être connue (relecture via `AgentToolExecutor.getChunks` optionnel pour un chunk connu seulement par une fiche). En cas de citation invalide : une régénération ciblée, puis tout paragraphe portant une citation invalide est retiré ; plus rien, ou verdict dont le premier paragraphe a été retiré → `insufficientAnswer()` (statut `insufficient`) et motif journalisé (`AnswerRejectionReason`). Métadonnées des sources toujours issues des RPC. Le texte n'est jamais diffusé avant vérification.

**Couche LLM** : la sortie structurée finale se fait dans un appel **sans outils** (`responseFormat: json_schema`), car tous les fournisseurs ne combinent pas outils et format imposé. Température 0 par défaut. Aucun SDK ne sort des adaptateurs. Aucun modèle par défaut n'est codé : `LLM_MODEL` est obligatoire.

## 5. Authentification et sécurité

- Lien magique Supabase. `POST /api/auth/magic-link` : l'email est cherché dans `allowed_emails` (client service_role) ; les emails de `LABGUARD_ADMIN_EMAILS` y sont (ré)inscrits comme admin (amorçage du premier admin). Le lien n'est envoyé que si l'email est autorisé, mais la réponse (statut, corps, durée minimale ~900 ms) est identique dans tous les cas.
- `GET /auth/confirm` accepte `token_hash`+`type` (à privilégier : **adapter le modèle d'email Supabase** « Magic Link » en `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=email` — `RedirectTo` vaut déjà `<APP_URL>/auth/confirm?next=…` ; fonctionne sur un autre appareil) ou `code` (PKCE, même navigateur). Puis revérifie `profiles.allowed` ; sinon déconnexion.
- Un compte Auth créé hors liste blanche (appel direct à l'API Auth) a `allowed = false` : la RLS ne lui montre rien et les pages le refusent.
- `src/proxy.ts` : CSP stricte par nonce (`script-src 'self' 'nonce-…' 'strict-dynamic'`, `frame-ancestors 'none'`, `connect-src` limité à l'app + Supabase), refresh de session, redirection vers `/login` (pages) ou 401 (API). `next.config.ts` : nosniff, Referrer-Policy, X-Frame-Options, HSTS, Permissions-Policy, COOP.
- **Conséquence CSP pour l'UI** : pas d'attribut `style="…"` rendu côté serveur ni de script inline sans nonce ; toutes les pages sont dynamiques.
- Les routes revérifient toujours l'utilisateur (`requireUser()` / `requireAdmin()` → `HttpError` → `errorResponse()`), les pages via `requirePageUser()` / `requirePageAdmin()`. La clé `service_role` n'est lue que dans `src/lib/env.ts` / `src/lib/supabase/admin.ts` (`server-only`).
- Les outils de recherche s'exécutent avec le client **de l'utilisateur** (RLS) ; le client admin sert à l'ingestion, à l'amorçage de la liste blanche et à l'écriture des messages vérifiés.

## 6. Variables d'environnement

Voir `.env.example`. Validation paresseuse (`getPublicEnv`, `getServerEnv`, `getLlmConfig`) : le build n'exige aucune variable ; une variable manquante lève `EnvError` listant les noms fautifs (réponse API 503 « Service non configuré »).

| Variable | Portée |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | navigateur + serveur |
| `NEXT_PUBLIC_APP_URL` | URL de retour des liens magiques (sinon origine de la requête) |
| `SUPABASE_SERVICE_ROLE_KEY` | serveur uniquement |
| `LABGUARD_ADMIN_EMAILS` | emails admin d'amorçage |
| `LLM_PROVIDER` (`mistral`\|`anthropic`\|`openai_compatible`\|`fake`), `LLM_MODEL`, `LLM_API_KEY`, `LLM_BASE_URL` (openai_compatible), `LLM_TIMEOUT_MS` | serveur |

## 7. Commandes

```sh
pnpm install
pnpm dev          # http://localhost:3000 (nécessite .env.local)
pnpm lint
pnpm typecheck
pnpm test         # Vitest : unitaires + SQL sur PGlite (aucun réseau, aucun Docker)
pnpm build
```

Appliquer le schéma sur Supabase : `supabase db push` (CLI liée au projet) ou exécuter les fichiers de `supabase/migrations/` dans l'ordre. Puis, dans Supabase Auth : URL du site et URL de redirection `<APP_URL>/auth/confirm`, modèle d'email (voir §5), et éventuellement désactiver les inscriptions publiques hors lien magique.

### Tests SQL (PGlite)

`tests/helpers/db.ts` charge le shim (`tests/helpers/supabase-shim.sql` : rôles `anon`/`authenticated`/`service_role`, `auth.users`, `auth.uid()`, schémas `extensions` et `storage`) puis toutes les migrations, une fois par processus (copie du répertoire de données ensuite). Helpers : `createUser(email, { role, allowed })`, `asUser(id, tx => …)` (rôle `authenticated` + claims JWT, RLS active), `asAnon`, `asServiceRole`, `insertDocument`, `insertAnalysis`, et `seedCorpus()` (corpus fictif). `query`/`exec` sont superutilisateur (sans RLS).

Limites : PGlite embarque Postgres 18 (Supabase : 17) ; `auth` et `storage` sont des shims (pas de GoTrue, pas d'API Storage, pas de PostgREST) ; les privilèges par défaut propres à Supabase ne sont pas reproduits (nos migrations posent les leurs explicitement).

## 8. Répartition des tâches

| Tâche | Périmètre | Emplacement |
| --- | --- | --- |
| T1 (fait) | socle : schéma, RLS, recherche SQL, contrats, auth, clients Supabase, tests PGlite | tout ce qui précède |
| T2 | ingestion : upload signé, parsing par page (PDF texte, DOCX, TXT, XLSX, CSV), chunks (~800-1200 car., par page/section, lignes de tableau avec en-têtes répétés), extraction LLM des fiches `analyses` avec citation vérifiée, jobs par lots (`ingestion_jobs`), activation/archivage | `src/lib/ingestion/`, `src/app/api/admin/documents/` |
| T3 | adaptateurs LLM (Mistral, Anthropic, OpenAI-compatible, Fake), boucle agent (≤ 4 tours), vérification des citations | `src/lib/llm/`, `src/lib/agent/` |
| T4 | API chat SSE + persistance (conversations, messages, sources), implémentation des outils sur les RPC | `src/lib/retrieval/`, `src/app/api/chat/`, `src/app/api/conversations/` |
| T5 | UI : chat, sources consultables, administration (bibliothèque, utilisateurs, glossaire) | `src/app/(app)/`, `src/components/` |
| T6 | évaluation (jeu de questions de référence) et tests e2e | `tests/eval/`, `tests/e2e/` |

Conventions : textes utilisateur en français, identifiants en anglais ; aucune donnée patient (corpus de test fictifs) ; toute migration met à jour `database.ts` et les contrats concernés ; durée longue côté Vercel via `export const maxDuration = …` dans la route concernée.
