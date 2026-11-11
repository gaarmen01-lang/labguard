/**
 * Implémentations Supabase (client service_role) du dépôt et du stockage.
 * Serveur uniquement : n'utiliser qu'après requireAdmin().
 */
import 'server-only';

import { randomUUID } from 'node:crypto';

import type { PostgrestError } from '@supabase/supabase-js';

import { HttpError } from '@/lib/auth/errors';
import {
  ANALYSIS_FIELDS,
  type AnalysisField,
  type AnalysisSheet,
  type Chunk,
  type FieldSource,
  type IngestionJob,
  type Json,
  type LabDocument,
} from '@/lib/contracts';
import type { AdminSupabaseClient } from '@/lib/supabase/admin';

import { IngestionError } from './errors';
import type { IngestionRepository } from './repository';
import { DOCUMENTS_BUCKET, type DocumentStorage } from './storage';

const CHUNK_COLUMNS = 'id, document_id, page_number, chunk_index, kind, heading, content, char_start, char_end, metadata, created_at';
const ANALYSIS_COLUMNS =
  'id, document_id, name, synonyms, codes, accepted_tubes, rejected_tubes, volume, transport, storage, stability, turnaround_time, remarks, source_chunk_id, source_quote';
const INSERT_BATCH = 500;

function fail(error: PostgrestError, action: string): never {
  console.error(`[labguard] base de données (${action}) :`, error.message, error.code);
  throw new IngestionError('internal', `Erreur de base de données (${action}).`, { cause: error });
}

function batches<T>(items: T[], size = INSERT_BATCH): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const asDocument = (row: unknown) => row as LabDocument;
const asJob = (row: unknown) => row as IngestionJob;

export function createSupabaseRepository(client: AdminSupabaseClient): IngestionRepository {
  return {
    async getDocument(id) {
      const { data, error } = await client.from('documents').select('*').eq('id', id).maybeSingle();
      if (error) fail(error, 'lecture du document');
      return data ? asDocument(data) : null;
    },

    async listDocuments(status) {
      let query = client.from('documents').select('*').order('code').order('created_at', { ascending: false });
      if (status !== 'all') query = query.eq('status', status);
      const { data, error } = await query;
      if (error) fail(error, 'liste des documents');
      return (data ?? []).map(asDocument);
    },

    async findDocumentByCodeVersion(code, version) {
      const { data, error } = await client.from('documents').select('*').eq('code', code).eq('version', version).maybeSingle();
      if (error) fail(error, 'recherche par code et version');
      return data ? asDocument(data) : null;
    },

    async findDocumentsBySha256(sha256) {
      const { data, error } = await client.from('documents').select('*').eq('sha256', sha256);
      if (error) fail(error, 'recherche par empreinte');
      return (data ?? []).map(asDocument);
    },

    async insertDocument(document) {
      const { data, error } = await client
        .from('documents')
        .insert({ ...document, status: 'draft', ingestion_status: 'pending' })
        .select('*')
        .single();
      if (error) {
        if (error.code === '23505') throw new HttpError('conflict', 'Un document avec ce code et cette version existe déjà.');
        fail(error, 'création du document');
      }
      return asDocument(data);
    },

    async updateDocument(id, patch) {
      const { data, error } = await client.from('documents').update(patch).eq('id', id).select('*').single();
      if (error) {
        if (error.code === '23505') throw new HttpError('conflict', 'Un document avec ce code et cette version existe déjà.');
        fail(error, 'mise à jour du document');
      }
      return asDocument(data);
    },

    async deleteDocument(id) {
      const { error } = await client.from('documents').delete().eq('id', id);
      if (error) fail(error, 'suppression du document');
    },

    async activateDocument(id) {
      const target = await this.getDocument(id);
      if (!target) throw new HttpError('not_found', 'Document introuvable.');
      const { data: active, error: activeError } = await client
        .from('documents')
        .select('id')
        .eq('code', target.code)
        .eq('status', 'active')
        .neq('id', id);
      if (activeError) fail(activeError, 'versions actives');
      const { data, error } = await client.rpc('activate_document', { p_document_id: id });
      if (error) {
        if (error.code === '22023') {
          throw new HttpError('conflict', "Le document n'est pas prêt : terminez l'ingestion avant de l'activer.");
        }
        if (error.code === 'P0002') throw new HttpError('not_found', 'Document introuvable.');
        fail(error, 'activation');
      }
      return { document: asDocument(data), archivedIds: (active ?? []).map((row) => row.id) };
    },

    async archiveDocument(id) {
      const { data, error } = await client.rpc('archive_document', { p_document_id: id });
      if (error) {
        if (error.code === 'P0002') throw new HttpError('not_found', 'Document introuvable.');
        fail(error, 'archivage');
      }
      return asDocument(data);
    },

    async getLatestJob(documentId) {
      const { data, error } = await client
        .from('ingestion_jobs')
        .select('*')
        .eq('document_id', documentId)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail(error, 'lecture du job');
      return data ? asJob(data) : null;
    },

    async insertJob(job) {
      const { data, error } = await client
        .from('ingestion_jobs')
        .insert({ document_id: job.document_id, created_by: job.created_by, cursor: job.cursor as Json })
        .select('*')
        .single();
      if (error) fail(error, 'création du job');
      return asJob(data);
    },

    async updateJob(id, patch) {
      const { cursor, ...rest } = patch;
      const { data, error } = await client
        .from('ingestion_jobs')
        .update({ ...rest, ...(cursor ? { cursor: cursor as Json } : {}) })
        .eq('id', id)
        .select('*')
        .single();
      if (error) fail(error, 'mise à jour du job');
      return asJob(data);
    },

    async tryLockJob(id, owner, now, staleBefore) {
      const { data, error } = await client
        .from('ingestion_jobs')
        .update({ locked_at: now.toISOString(), locked_by: owner, status: 'running' })
        .eq('id', id)
        .in('status', ['queued', 'running'])
        .or(`locked_at.is.null,locked_at.lt."${staleBefore.toISOString()}"`)
        .select('*')
        .maybeSingle();
      if (error) fail(error, 'verrouillage du job');
      return data ? asJob(data) : null;
    },

    async unlockJob(id, owner, patch) {
      const { cursor, ...rest } = patch;
      const { data, error } = await client
        .from('ingestion_jobs')
        .update({ ...rest, ...(cursor ? { cursor: cursor as Json } : {}), locked_at: null, locked_by: null })
        .eq('id', id)
        .eq('locked_by', owner)
        .select('*')
        .maybeSingle();
      if (error) fail(error, 'déverrouillage du job');
      return data ? asJob(data) : null;
    },

    async replacePages(documentId, pages) {
      const { error } = await client.from('document_pages').delete().eq('document_id', documentId);
      if (error) fail(error, 'suppression des pages');
      for (const batch of batches(pages, 100)) {
        const { error: insertError } = await client
          .from('document_pages')
          .insert(batch.map((page) => ({ ...page, document_id: documentId })));
        if (insertError) fail(insertError, 'enregistrement des pages');
      }
    },

    async listPages(documentId) {
      const { data, error } = await client
        .from('document_pages')
        .select('document_id, page_number, content, label')
        .eq('document_id', documentId)
        .order('page_number');
      if (error) fail(error, 'lecture des pages');
      return data ?? [];
    },

    async countPages(documentId) {
      const { count, error } = await client
        .from('document_pages')
        .select('page_number', { count: 'exact', head: true })
        .eq('document_id', documentId);
      if (error) fail(error, 'comptage des pages');
      return count ?? 0;
    },

    async replaceChunks(documentId, chunks) {
      const { error } = await client.from('chunks').delete().eq('document_id', documentId);
      if (error) fail(error, 'suppression des chunks');
      for (const batch of batches(chunks)) {
        const { error: insertError } = await client
          .from('chunks')
          .insert(batch.map((chunk) => ({ ...chunk, document_id: documentId, metadata: chunk.metadata as Json })));
        if (insertError) fail(insertError, 'enregistrement des chunks');
      }
    },

    async listChunks(documentId, options = {}) {
      const offset = options.offset ?? 0;
      const limit = options.limit ?? 1000;
      let query = client.from('chunks').select(CHUNK_COLUMNS).eq('document_id', documentId);
      if (options.page !== undefined) query = query.eq('page_number', options.page);
      const { data, error } = await query.order('chunk_index').range(offset, offset + limit - 1);
      if (error) fail(error, 'lecture des chunks');
      return (data ?? []) as unknown as Chunk[];
    },

    async countChunks(documentId, options = {}) {
      let query = client.from('chunks').select('id', { count: 'exact', head: true }).eq('document_id', documentId);
      if (options.page !== undefined) query = query.eq('page_number', options.page);
      const { count, error } = await query;
      if (error) fail(error, 'comptage des chunks');
      return count ?? 0;
    },

    async replaceAnalyses(documentId, chunkIds, analyses) {
      let remove = client.from('analyses').delete().eq('document_id', documentId);
      if (chunkIds !== 'all') {
        if (chunkIds.length === 0 && analyses.length === 0) return 0;
        remove = remove.in('source_chunk_id', chunkIds);
      }
      const { error } = await remove;
      if (error) fail(error, 'suppression des fiches');
      const rows = analyses.map((analysis) => ({ id: randomUUID(), analysis }));
      for (const batch of batches(rows)) {
        const { error: insertError } = await client.from('analyses').insert(
          batch.map(({ id, analysis }) => ({
            id,
            document_id: documentId,
            name: analysis.name,
            synonyms: analysis.synonyms,
            codes: analysis.codes,
            accepted_tubes: analysis.accepted_tubes,
            rejected_tubes: analysis.rejected_tubes,
            volume: analysis.volume,
            transport: analysis.transport,
            storage: analysis.storage,
            stability: analysis.stability,
            turnaround_time: analysis.turnaround_time,
            remarks: analysis.remarks,
            source_chunk_id: analysis.source_chunk_id,
            source_quote: analysis.source_quote,
          })),
        );
        if (insertError) fail(insertError, 'enregistrement des fiches');
        const sources = batch.flatMap(({ id, analysis }) =>
          (Object.entries(analysis.field_sources) as Array<[AnalysisField, FieldSource]>).map(([field, source]) => ({
            analysis_id: id,
            field,
            chunk_id: source.chunk_id,
            quote: source.quote,
          })),
        );
        for (const sourceBatch of batches(sources)) {
          const { error: sourceError } = await client.from('analysis_field_sources').insert(sourceBatch);
          if (sourceError) fail(sourceError, 'enregistrement des citations');
        }
      }
      return analyses.length;
    },

    async listAnalyses(documentId) {
      const { data, error } = await client
        .from('analyses')
        .select(ANALYSIS_COLUMNS)
        .eq('document_id', documentId)
        .order('created_at')
        .order('name');
      if (error) fail(error, 'lecture des fiches');
      const analyses = (data ?? []) as unknown as Array<Omit<AnalysisSheet, 'field_sources'>>;
      const sourcesById = new Map<string, Partial<Record<AnalysisField, FieldSource>>>();
      for (const ids of batches(analyses.map((analysis) => analysis.id), 200)) {
        const { data: sources, error: sourcesError } = await client
          .from('analysis_field_sources')
          .select('analysis_id, field, chunk_id, quote')
          .in('analysis_id', ids);
        if (sourcesError) fail(sourcesError, 'lecture des citations');
        for (const source of sources ?? []) {
          if (!(ANALYSIS_FIELDS as readonly string[]).includes(source.field)) continue;
          const entry = sourcesById.get(source.analysis_id) ?? {};
          entry[source.field as AnalysisField] = { chunk_id: source.chunk_id, quote: source.quote };
          sourcesById.set(source.analysis_id, entry);
        }
      }
      return analyses.map((analysis) => ({ ...analysis, field_sources: sourcesById.get(analysis.id) ?? {} }));
    },

    async loadGlossary() {
      const { data, error } = await client.from('synonyms').select('group_key, term').order('id');
      if (error) fail(error, 'lecture du glossaire');
      return data ?? [];
    },
  };
}

export function createSupabaseStorage(client: AdminSupabaseClient): DocumentStorage {
  const bucket = () => client.storage.from(DOCUMENTS_BUCKET);
  return {
    async createSignedUploadUrl(path) {
      const { data, error } = await bucket().createSignedUploadUrl(path);
      if (error || !data) {
        throw new IngestionError('storage_unavailable', "Impossible de préparer l'envoi du fichier. Réessayez.", { cause: error });
      }
      return { path: data.path, signedUrl: data.signedUrl, token: data.token };
    },
    async download(path) {
      const { data, error } = await bucket().download(path);
      if (error || !data) {
        const status = (error as { status?: number; statusCode?: string } | null)?.statusCode;
        if (status === '404' || /not.?found|does not exist/i.test(error?.message ?? '')) {
          throw new IngestionError(
            'file_missing',
            "Le fichier est introuvable dans le stockage : l'envoi n'a peut-être pas abouti. Réimportez le document.",
            { retryable: false, cause: error },
          );
        }
        throw new IngestionError('storage_unavailable', 'Le stockage des fichiers est momentanément indisponible. Relancez le traitement.', {
          cause: error,
        });
      }
      return new Uint8Array(await data.arrayBuffer());
    },
    async createSignedUrl(path, expiresInSeconds, downloadName) {
      const { data, error } = await bucket().createSignedUrl(path, expiresInSeconds, downloadName ? { download: downloadName } : undefined);
      if (error || !data) {
        throw new IngestionError('storage_unavailable', "Impossible de générer le lien vers l'original. Réessayez.", { cause: error });
      }
      return data.signedUrl;
    },
    async remove(paths) {
      if (paths.length === 0) return;
      const { error } = await bucket().remove(paths);
      if (error) {
        throw new IngestionError('storage_unavailable', 'Impossible de supprimer le fichier original. Réessayez.', { cause: error });
      }
    },
  };
}
