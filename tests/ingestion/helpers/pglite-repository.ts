/**
 * Implémentation PGlite de IngestionRepository (tests) : même schéma et mêmes
 * RPC que Supabase, requêtes exécutées avec le rôle service_role (comme le
 * client admin de production). Réutilisable par l'évaluation (tâche 6).
 */
import { randomUUID } from 'node:crypto';

import type { Transaction } from '@electric-sql/pglite';

import { HttpError } from '@/lib/auth/errors';
import type {
  AnalysisField,
  AnalysisSheet,
  Chunk,
  FieldSource,
  IngestionJob,
  LabDocument,
} from '@/lib/contracts';
import type { IngestionRepository } from '@/lib/ingestion/repository';
import { IngestionError, type DocumentStorage } from '@/lib/ingestion';

import type { TestDb } from '../../helpers/db';

const CHUNK_COLUMNS =
  'id, document_id, page_number, chunk_index, kind, heading, content, char_start, char_end, metadata, created_at::text as created_at';

const DOCUMENT_COLUMNS = `id, code, title, version, doc_type, status::text as status, effective_date::text as effective_date,
  storage_path, original_filename, mime_type, file_size::int as file_size, sha256, page_count, ingestion_status,
  ingestion_error, activated_at::text as activated_at, archived_at::text as archived_at, created_by,
  created_at::text as created_at, updated_at::text as updated_at`;

const JOB_COLUMNS = `id, document_id, status, stage, cursor, progress, total, attempts, last_error,
  locked_at::text as locked_at, locked_by, created_by, created_at::text as created_at,
  updated_at::text as updated_at, finished_at::text as finished_at`;

export interface PgliteRepositoryOptions {
  /** Appels comptés par méthode (pour les tests d'idempotence). */
  calls?: Map<string, number>;
  /** Fonction appelée avant chaque méthode : permet d'injecter une panne. */
  beforeCall?: (method: keyof IngestionRepository) => void | Promise<void>;
}

export function createPgliteRepository(db: TestDb, options: PgliteRepositoryOptions = {}): IngestionRepository {
  const run = <T>(fn: (tx: Transaction) => Promise<T>) => db.asServiceRole(fn);
  const rows = async <T>(tx: Transaction, sql: string, params: unknown[] = []) => (await tx.query<T>(sql, params)).rows;

  const repo: IngestionRepository = {
    getDocument: (id) =>
      run(async (tx) => (await rows<LabDocument>(tx, `select ${DOCUMENT_COLUMNS} from public.documents where id = $1`, [id]))[0] ?? null),

    listDocuments: (status) =>
      run((tx) =>
        rows<LabDocument>(
          tx,
          `select ${DOCUMENT_COLUMNS} from public.documents
           where $1 = 'all' or status::text = $1 order by code, created_at desc`,
          [status],
        ),
      ),

    findDocumentByCodeVersion: (code, version) =>
      run(async (tx) =>
        (await rows<LabDocument>(tx, `select ${DOCUMENT_COLUMNS} from public.documents where code = $1 and version = $2`, [code, version]))[0] ??
        null,
      ),

    findDocumentsBySha256: (sha256) =>
      run((tx) => rows<LabDocument>(tx, `select ${DOCUMENT_COLUMNS} from public.documents where sha256 = $1`, [sha256])),

    insertDocument: (document) =>
      run(async (tx) => {
        const [row] = await rows<LabDocument>(
          tx,
          `insert into public.documents (id, code, title, version, doc_type, effective_date, storage_path,
             original_filename, mime_type, file_size, sha256, created_by)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) returning ${DOCUMENT_COLUMNS}`,
          [
            document.id, document.code, document.title, document.version, document.doc_type, document.effective_date,
            document.storage_path, document.original_filename, document.mime_type, document.file_size,
            document.sha256, document.created_by,
          ],
        );
        return row!;
      }),

    updateDocument: (id, patch) =>
      run(async (tx) => {
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
        const sets = entries.map(([key], i) => `${key} = $${i + 2}`).join(', ');
        const [row] = await rows<LabDocument>(
          tx,
          `update public.documents set ${sets || 'id = id'} where id = $1 returning ${DOCUMENT_COLUMNS}`,
          [id, ...entries.map(([, value]) => value)],
        );
        if (!row) throw new HttpError('not_found', 'Document introuvable.');
        return row;
      }),

    deleteDocument: (id) =>
      run(async (tx) => {
        await tx.query('delete from public.documents where id = $1', [id]);
      }),

    activateDocument: (id) =>
      run(async (tx) => {
        const archived = await rows<{ id: string }>(
          tx,
          `select d.id from public.documents d join public.documents t on t.id = $1
           where d.code = t.code and d.status = 'active' and d.id <> $1`,
          [id],
        );
        try {
          await tx.query('select public.activate_document($1)', [id]);
        } catch (error) {
          if ((error as { code?: string }).code === '22023') {
            throw new HttpError('conflict', "Le document n'est pas prêt : terminez l'ingestion avant de l'activer.");
          }
          throw error;
        }
        const [document] = await rows<LabDocument>(tx, `select ${DOCUMENT_COLUMNS} from public.documents where id = $1`, [id]);
        return { document: document!, archivedIds: archived.map((row) => row.id) };
      }),

    archiveDocument: (id) =>
      run(async (tx) => {
        await tx.query('select public.archive_document($1)', [id]);
        const [document] = await rows<LabDocument>(tx, `select ${DOCUMENT_COLUMNS} from public.documents where id = $1`, [id]);
        return document!;
      }),

    getLatestJob: (documentId) =>
      run(async (tx) =>
        (await rows<IngestionJob>(
          tx,
          `select ${JOB_COLUMNS} from public.ingestion_jobs where document_id = $1 order by created_at desc, id limit 1`,
          [documentId],
        ))[0] ?? null,
      ),

    insertJob: (job) =>
      run(async (tx) => {
        const [row] = await rows<IngestionJob>(
          tx,
          `insert into public.ingestion_jobs (document_id, created_by, cursor, created_at)
           values ($1, $2, $3, clock_timestamp()) returning ${JOB_COLUMNS}`,
          [job.document_id, job.created_by, JSON.stringify(job.cursor)],
        );
        return row!;
      }),

    updateJob: (id, patch) =>
      run(async (tx) => {
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
        const sets = entries
          .map(([key], i) => `${key} = $${i + 2}${key === 'cursor' ? '::jsonb' : ''}`)
          .join(', ');
        const [row] = await rows<IngestionJob>(
          tx,
          `update public.ingestion_jobs set ${sets || 'id = id'} where id = $1 returning ${JOB_COLUMNS}`,
          [id, ...entries.map(([key, value]) => (key === 'cursor' ? JSON.stringify(value) : value))],
        );
        return row!;
      }),

    tryLockJob: (id, owner, now, staleBefore) =>
      run(async (tx) =>
        (await rows<IngestionJob>(
          tx,
          `update public.ingestion_jobs set locked_at = $3, locked_by = $2, status = 'running'
           where id = $1 and status in ('queued', 'running') and (locked_at is null or locked_at < $4)
           returning ${JOB_COLUMNS}`,
          [id, owner, now.toISOString(), staleBefore.toISOString()],
        ))[0] ?? null,
      ),

    unlockJob: (id, owner, patch) =>
      run(async (tx) => {
        const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
        const sets = entries.map(([key], i) => `${key} = $${i + 3}${key === 'cursor' ? '::jsonb' : ''}`);
        const [row] = await rows<IngestionJob>(
          tx,
          `update public.ingestion_jobs set ${[...sets, 'locked_at = null', 'locked_by = null'].join(', ')}
           where id = $1 and locked_by = $2 returning ${JOB_COLUMNS}`,
          [id, owner, ...entries.map(([key, value]) => (key === 'cursor' ? JSON.stringify(value) : value))],
        );
        return row ?? null;
      }),

    replacePages: (documentId, pages) =>
      run(async (tx) => {
        await tx.query('delete from public.document_pages where document_id = $1', [documentId]);
        for (const page of pages) {
          await tx.query(
            'insert into public.document_pages (document_id, page_number, content, label) values ($1, $2, $3, $4)',
            [documentId, page.page_number, page.content, page.label],
          );
        }
      }),

    listPages: (documentId) =>
      run((tx) =>
        rows<{ document_id: string; page_number: number; content: string; label: string | null }>(
          tx,
          'select document_id, page_number, content, label from public.document_pages where document_id = $1 order by page_number',
          [documentId],
        ),
      ),

    countPages: (documentId) =>
      run(async (tx) => (await rows<{ n: number }>(tx, 'select count(*)::int as n from public.document_pages where document_id = $1', [documentId]))[0]!.n),

    replaceChunks: (documentId, chunks) =>
      run(async (tx) => {
        await tx.query('delete from public.chunks where document_id = $1', [documentId]);
        for (const chunk of chunks) {
          await tx.query(
            `insert into public.chunks (document_id, page_number, chunk_index, kind, heading, content, char_start, char_end, metadata)
             values ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
            [
              documentId, chunk.page_number, chunk.chunk_index, chunk.kind, chunk.heading, chunk.content,
              chunk.char_start, chunk.char_end, JSON.stringify(chunk.metadata),
            ],
          );
        }
      }),

    listChunks: (documentId, opts = {}) =>
      run((tx) =>
        rows<Chunk>(
          tx,
          `select ${CHUNK_COLUMNS} from public.chunks where document_id = $1 and ($2::int is null or page_number = $2)
           order by chunk_index offset $3 limit $4`,
          [documentId, opts.page ?? null, opts.offset ?? 0, opts.limit ?? 1000],
        ),
      ),

    countChunks: (documentId, opts = {}) =>
      run(async (tx) =>
        (await rows<{ n: number }>(
          tx,
          'select count(*)::int as n from public.chunks where document_id = $1 and ($2::int is null or page_number = $2)',
          [documentId, opts.page ?? null],
        ))[0]!.n,
      ),

    replaceAnalyses: (documentId, chunkIds, analyses) =>
      run(async (tx) => {
        if (chunkIds === 'all') {
          await tx.query('delete from public.analyses where document_id = $1', [documentId]);
        } else if (chunkIds.length > 0) {
          await tx.query('delete from public.analyses where document_id = $1 and source_chunk_id = any($2::uuid[])', [
            documentId,
            chunkIds,
          ]);
        }
        for (const analysis of analyses) {
          const id = randomUUID();
          await tx.query(
            `insert into public.analyses (id, document_id, name, synonyms, codes, accepted_tubes, rejected_tubes, volume,
               transport, storage, stability, turnaround_time, remarks, source_chunk_id, source_quote)
             values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
            [
              id, documentId, analysis.name, analysis.synonyms, analysis.codes, analysis.accepted_tubes,
              analysis.rejected_tubes, analysis.volume, analysis.transport, analysis.storage, analysis.stability,
              analysis.turnaround_time, analysis.remarks, analysis.source_chunk_id, analysis.source_quote,
            ],
          );
          for (const [field, source] of Object.entries(analysis.field_sources) as Array<[AnalysisField, FieldSource]>) {
            await tx.query(
              'insert into public.analysis_field_sources (analysis_id, field, chunk_id, quote) values ($1, $2, $3, $4)',
              [id, field, source.chunk_id, source.quote],
            );
          }
        }
        return analyses.length;
      }),

    listAnalyses: (documentId) =>
      run((tx) =>
        rows<AnalysisSheet>(
          tx,
          `select a.id, a.document_id, a.name, a.synonyms, a.codes, a.accepted_tubes, a.rejected_tubes, a.volume,
                  a.transport, a.storage, a.stability, a.turnaround_time, a.remarks, a.source_chunk_id, a.source_quote,
                  coalesce((select jsonb_object_agg(fs.field, jsonb_build_object('chunk_id', fs.chunk_id, 'quote', fs.quote))
                            from public.analysis_field_sources fs where fs.analysis_id = a.id), '{}'::jsonb) as field_sources
           from public.analyses a join public.chunks c on c.id = a.source_chunk_id
           where a.document_id = $1 order by c.chunk_index, a.name`,
          [documentId],
        ),
      ),

    loadGlossary: () =>
      run((tx) => rows<{ group_key: string; term: string }>(tx, 'select group_key, term from public.synonyms order by id')),
  };

  if (!options.calls && !options.beforeCall) return repo;
  const wrapped = {} as Record<string, unknown>;
  for (const [name, fn] of Object.entries(repo) as Array<[keyof IngestionRepository, (...args: unknown[]) => Promise<unknown>]>) {
    wrapped[name] = async (...args: unknown[]) => {
      options.calls?.set(name, (options.calls.get(name) ?? 0) + 1);
      await options.beforeCall?.(name);
      return fn.apply(wrapped, args);
    };
  }
  return wrapped as unknown as IngestionRepository;
}

/** Stockage en mémoire (Supabase Storage simulé). */
export class MemoryStorage implements DocumentStorage {
  readonly files = new Map<string, Uint8Array>();
  readonly removed: string[] = [];

  put(path: string, bytes: Uint8Array): void {
    this.files.set(path, bytes);
  }

  async createSignedUploadUrl(path: string) {
    return { path, signedUrl: `https://storage.test/upload/${encodeURIComponent(path)}?token=t`, token: 'upload-token' };
  }

  async download(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new IngestionError('file_missing', 'Le fichier est introuvable dans le stockage.', { retryable: false });
    return bytes;
  }

  async createSignedUrl(path: string, expiresInSeconds: number) {
    if (!this.files.has(path)) throw new IngestionError('file_missing', 'Le fichier est introuvable dans le stockage.');
    return `https://storage.test/signed/${encodeURIComponent(path)}?expires=${expiresInSeconds}`;
  }

  async remove(paths: string[]): Promise<void> {
    for (const path of paths) {
      this.files.delete(path);
      this.removed.push(path);
    }
  }
}
