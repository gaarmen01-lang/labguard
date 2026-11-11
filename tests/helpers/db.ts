/**
 * Base Postgres de test en mémoire (PGlite) avec les migrations Supabase.
 *
 * Usage typique :
 *
 *   const t = await createTestDb();          // shim + toutes les migrations
 *   const admin = await t.createUser('admin@lab.test', { role: 'admin' });
 *   const doc = await t.insertDocument({ code: 'MP-1', status: 'active', pages: [...] });
 *   const rows = await t.asUser(admin.id, (tx) => tx.query('select * from search_chunks($1)', ['edta']));
 *   await t.close();
 *
 * - `query`/`exec` tournent en superutilisateur (RLS ignorée) : réservé à la
 *   mise en place des données.
 * - `asUser`, `asAnon`, `asServiceRole` exécutent dans une transaction avec
 *   `SET LOCAL ROLE` et les claims JWT, comme PostgREST : la RLS s'applique.
 *   Toute erreur annule la transaction et est propagée.
 *
 * Limites : PGlite est un Postgres réel (WASM) mais le schéma `auth` et
 * `storage` est un shim (tests/helpers/supabase-shim.sql), pas l'implémentation
 * Supabase. PGlite embarque une version majeure de Postgres qui peut différer
 * de celle du projet Supabase.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { PGlite, type Transaction } from '@electric-sql/pglite';
import { fuzzystrmatch } from '@electric-sql/pglite/contrib/fuzzystrmatch';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';

const ROOT = resolve(import.meta.dirname, '..', '..');
export const MIGRATIONS_DIR = join(ROOT, 'supabase', 'migrations');
const SHIM_PATH = join(import.meta.dirname, 'supabase-shim.sql');

export type Queryable = Pick<Transaction, 'query' | 'exec'>;

export interface TestUser {
  id: string;
  email: string;
}

export interface PageFixture {
  pageNumber: number;
  /** Texte intégral de la page. Par défaut : concaténation des chunks. */
  content?: string;
  label?: string;
  chunks?: Array<
    | string
    | { content: string; heading?: string; kind?: 'text' | 'table_row' | 'table' }
  >;
}

export interface DocumentFixture {
  code: string;
  title?: string;
  version?: string;
  status?: 'draft' | 'active' | 'archived';
  docType?: 'sampling_manual' | 'test_catalog' | 'procedure' | 'other';
  ingestionStatus?: 'pending' | 'processing' | 'ready' | 'failed';
  pages: PageFixture[];
}

export interface InsertedDocument {
  documentId: string;
  /** Identifiants des chunks dans l'ordre de déclaration. */
  chunkIds: string[];
}

export interface AnalysisFixture {
  documentId: string;
  sourceChunkId: string;
  sourceQuote: string;
  name: string;
  synonyms?: string[];
  codes?: string[];
  acceptedTubes?: string[];
  rejectedTubes?: string[];
  volume?: string;
  transport?: string;
  storage?: string;
  stability?: string;
  turnaroundTime?: string;
  remarks?: string;
  fieldSources?: Record<string, { chunkId: string; quote: string }>;
}

export interface TestDb {
  pg: PGlite;
  /** Requête superutilisateur (sans RLS). */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  exec(sql: string): Promise<void>;
  /**
   * Crée un utilisateur Auth (le trigger crée son profil). Par défaut l'email
   * est d'abord ajouté à allowed_emails avec le rôle demandé ; `allowed: false`
   * simule un compte Auth hors liste blanche.
   */
  createUser(
    email: string,
    options?: { role?: 'admin' | 'member'; allowed?: boolean },
  ): Promise<TestUser>;
  asUser<T>(userId: string, fn: (tx: Transaction) => Promise<T>): Promise<T>;
  asAnon<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  asServiceRole<T>(fn: (tx: Transaction) => Promise<T>): Promise<T>;
  insertDocument(fixture: DocumentFixture): Promise<InsertedDocument>;
  insertAnalysis(fixture: AnalysisFixture): Promise<string>;
  close(): Promise<void>;
}

export function listMigrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => join(MIGRATIONS_DIR, file));
}

const extensions = { pg_trgm, unaccent, fuzzystrmatch };

let templatePromise: Promise<Blob | File> | null = null;

/** Applique toutes les migrations, dans l'ordre, sur une base PGlite. */
export async function applyMigrations(pg: PGlite): Promise<void> {
  for (const file of listMigrationFiles()) {
    try {
      await pg.exec(readFileSync(file, 'utf8'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Échec de la migration ${file} : ${message}`, { cause: error });
    }
  }
}

/** Base PGlite vierge avec le shim Supabase, SANS les migrations. */
export async function createBareDb(): Promise<PGlite> {
  const pg = await PGlite.create({ extensions });
  await pg.exec(readFileSync(SHIM_PATH, 'utf8'));
  return pg;
}

async function buildTemplate(): Promise<Blob | File> {
  const pg = await createBareDb();
  try {
    await applyMigrations(pg);
    return await pg.dumpDataDir('none');
  } finally {
    await pg.close();
  }
}

/**
 * Crée une base neuve. Le shim et les migrations ne sont appliqués qu'une fois
 * par processus : les appels suivants repartent d'une copie du répertoire de
 * données (rapide et isolé).
 */
export async function createTestDb(): Promise<TestDb> {
  templatePromise ??= buildTemplate();
  const template = await templatePromise;
  const pg = await PGlite.create({ extensions, loadDataDir: template });
  return wrap(pg);
}

function claimsFor(role: string, sub?: string, email?: string): string {
  return JSON.stringify({ role, ...(sub ? { sub } : {}), ...(email ? { email } : {}) });
}

async function withRole<T>(
  pg: PGlite,
  role: 'anon' | 'authenticated' | 'service_role',
  claims: string,
  sub: string | null,
  fn: (tx: Transaction) => Promise<T>,
): Promise<T> {
  return pg.transaction(async (tx) => {
    await tx.query(`select set_config('request.jwt.claims', $1, true)`, [claims]);
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [sub ?? '']);
    await tx.query(`select set_config('request.jwt.claim.role', $1, true)`, [role]);
    await tx.exec(`set local role ${role}`);
    return fn(tx);
  });
}

function wrap(pg: PGlite): TestDb {
  const query = async <T>(sql: string, params: unknown[] = []): Promise<T[]> =>
    (await pg.query<T>(sql, params)).rows;

  const db: TestDb = {
    pg,
    query,
    async exec(sql) {
      await pg.exec(sql);
    },

    async createUser(email, options = {}) {
      const normalized = email.trim().toLowerCase();
      if (options.allowed !== false) {
        await query(
          `insert into public.allowed_emails (email, role) values ($1, $2)
           on conflict (email) do update set role = excluded.role`,
          [normalized, options.role ?? 'member'],
        );
      }
      const [row] = await query<{ id: string }>(
        `insert into auth.users (email, email_confirmed_at) values ($1, now()) returning id`,
        [normalized],
      );
      if (!row) throw new Error('insertion auth.users impossible');
      return { id: row.id, email: normalized };
    },

    asUser(userId, fn) {
      return withRole(pg, 'authenticated', claimsFor('authenticated', userId), userId, fn);
    },
    asAnon(fn) {
      return withRole(pg, 'anon', claimsFor('anon'), null, fn);
    },
    asServiceRole(fn) {
      return withRole(pg, 'service_role', claimsFor('service_role'), null, fn);
    },

    async insertDocument(fixture) {
      const status = fixture.status ?? 'active';
      const [doc] = await query<{ id: string }>(
        `insert into public.documents
           (code, title, version, doc_type, status, ingestion_status, page_count, activated_at)
         values ($1, $2, $3, $4, $5::text::public.document_status, $6, $7,
                 case when $5::text = 'active' then now() end)
         returning id`,
        [
          fixture.code,
          fixture.title ?? `Document ${fixture.code}`,
          fixture.version ?? '1',
          fixture.docType ?? 'procedure',
          status,
          fixture.ingestionStatus ?? 'ready',
          fixture.pages.length,
        ],
      );
      if (!doc) throw new Error('insertion document impossible');

      const chunkIds: string[] = [];
      let chunkIndex = 0;
      for (const page of fixture.pages) {
        const chunks = (page.chunks ?? []).map((chunk) =>
          typeof chunk === 'string' ? { content: chunk } : chunk,
        );
        const content = page.content ?? chunks.map((chunk) => chunk.content).join('\n\n');
        await query(
          `insert into public.document_pages (document_id, page_number, content, label)
           values ($1, $2, $3, $4)`,
          [doc.id, page.pageNumber, content, page.label ?? null],
        );
        for (const chunk of chunks) {
          const [row] = await query<{ id: string }>(
            `insert into public.chunks (document_id, page_number, chunk_index, kind, heading, content)
             values ($1, $2, $3, $4, $5, $6) returning id`,
            [doc.id, page.pageNumber, chunkIndex++, chunk.kind ?? 'text', chunk.heading ?? null, chunk.content],
          );
          if (!row) throw new Error('insertion chunk impossible');
          chunkIds.push(row.id);
        }
      }
      return { documentId: doc.id, chunkIds };
    },

    async insertAnalysis(fixture) {
      const [row] = await query<{ id: string }>(
        `insert into public.analyses
           (document_id, name, synonyms, codes, accepted_tubes, rejected_tubes, volume,
            transport, storage, stability, turnaround_time, remarks, source_chunk_id, source_quote)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         returning id`,
        [
          fixture.documentId,
          fixture.name,
          fixture.synonyms ?? [],
          fixture.codes ?? [],
          fixture.acceptedTubes ?? [],
          fixture.rejectedTubes ?? [],
          fixture.volume ?? null,
          fixture.transport ?? null,
          fixture.storage ?? null,
          fixture.stability ?? null,
          fixture.turnaroundTime ?? null,
          fixture.remarks ?? null,
          fixture.sourceChunkId,
          fixture.sourceQuote,
        ],
      );
      if (!row) throw new Error('insertion analyse impossible');
      for (const [field, source] of Object.entries(fixture.fieldSources ?? {})) {
        await query(
          `insert into public.analysis_field_sources (analysis_id, field, chunk_id, quote)
           values ($1, $2, $3, $4)`,
          [row.id, field, source.chunkId, source.quote],
        );
      }
      return row.id;
    },

    async close() {
      await pg.close();
    },
  };
  return db;
}
