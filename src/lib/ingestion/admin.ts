/**
 * Opérations d'administration des documents (appelées par les routes
 * /api/admin/documents/** APRÈS requireAdmin()). Indépendantes de Next.js et
 * de Supabase (dépôt et stockage injectés) : testables avec PGlite.
 */
import { randomUUID } from 'node:crypto';

import { HttpError } from '@/lib/auth/errors';
import type {
  CreateDocumentRequest,
  CreateDocumentResponse,
  DocumentChunksQuery,
  DocumentChunksResponse,
  DocumentDetailResponse,
  DocumentFileUrlResponse,
  DocumentListQuery,
  DocumentListResponse,
  DocumentStatusResponse,
  UpdateDocumentRequest,
} from '@/lib/contracts';

import { kindFromFilename, kindFromMime } from './detect';
import type { IngestionRepository } from './repository';
import { DOCUMENTS_BUCKET, storagePathFor, type DocumentStorage } from './storage';

export interface AdminDeps {
  repo: IngestionRepository;
  storage: DocumentStorage;
}

/** Durée de validité des liens vers l'original (secondes). */
export const FILE_URL_TTL_SECONDS = 120;

async function requireDocument(deps: AdminDeps, id: string) {
  const document = await deps.repo.getDocument(id);
  if (!document) throw new HttpError('not_found', 'Document introuvable.');
  return document;
}

export async function createDocument(
  deps: AdminDeps,
  input: CreateDocumentRequest,
  userId: string,
): Promise<CreateDocumentResponse> {
  const fromName = kindFromFilename(input.filename);
  const fromMime = kindFromMime(input.mime_type);
  if (!fromName) {
    throw new HttpError('bad_request', 'Extension de fichier non prise en charge (PDF, DOCX, XLSX, CSV, TXT, MD).');
  }
  if (fromName !== fromMime) {
    throw new HttpError('bad_request', "Le type de fichier déclaré ne correspond pas à l'extension du fichier.");
  }
  if (await deps.repo.findDocumentByCodeVersion(input.code, input.version)) {
    throw new HttpError('conflict', `La version « ${input.version} » du document « ${input.code} » existe déjà.`);
  }
  if (input.sha256) {
    const duplicates = await deps.repo.findDocumentsBySha256(input.sha256);
    const duplicate = duplicates[0];
    if (duplicate) {
      throw new HttpError(
        'conflict',
        `Ce fichier a déjà été importé (document « ${duplicate.code} », version « ${duplicate.version} »).`,
      );
    }
  }
  const id = randomUUID();
  const path = storagePathFor(id, input.filename);
  const document = await deps.repo.insertDocument({
    id,
    code: input.code,
    title: input.title,
    version: input.version,
    doc_type: input.doc_type,
    effective_date: input.effective_date ?? null,
    storage_path: path,
    original_filename: input.filename,
    mime_type: input.mime_type,
    file_size: input.file_size,
    sha256: input.sha256 ?? null,
    created_by: userId,
  });
  try {
    const upload = await deps.storage.createSignedUploadUrl(path);
    return { document, upload: { bucket: DOCUMENTS_BUCKET, path: upload.path, signed_url: upload.signedUrl, token: upload.token } };
  } catch (error) {
    // Pas de document orphelin sans possibilité d'envoi.
    await deps.repo.deleteDocument(id).catch(() => undefined);
    throw error;
  }
}

export async function listDocuments(deps: AdminDeps, query: DocumentListQuery): Promise<DocumentListResponse> {
  return { documents: await deps.repo.listDocuments(query.status) };
}

export async function getDocumentDetail(deps: AdminDeps, id: string): Promise<DocumentDetailResponse> {
  const document = await requireDocument(deps, id);
  const [latestJob, analyses, pageCount, chunkCount] = await Promise.all([
    deps.repo.getLatestJob(id),
    deps.repo.listAnalyses(id),
    deps.repo.countPages(id),
    deps.repo.countChunks(id),
  ]);
  return { document, latest_job: latestJob, analyses, page_count: pageCount, chunk_count: chunkCount };
}

export async function listDocumentChunks(deps: AdminDeps, id: string, query: DocumentChunksQuery): Promise<DocumentChunksResponse> {
  await requireDocument(deps, id);
  const filter = query.page !== undefined ? { page: query.page } : {};
  const [chunks, total] = await Promise.all([
    deps.repo.listChunks(id, { ...filter, offset: query.offset, limit: query.limit }),
    deps.repo.countChunks(id, filter),
  ]);
  return { chunks, total };
}

export async function updateDocument(deps: AdminDeps, id: string, patch: UpdateDocumentRequest): Promise<DocumentStatusResponse> {
  const document = await requireDocument(deps, id);
  if (document.status !== 'draft') {
    throw new HttpError('conflict', "Seules les métadonnées d'un brouillon sont modifiables.");
  }
  const code = patch.code ?? document.code;
  const version = patch.version ?? document.version;
  if (code !== document.code || version !== document.version) {
    const existing = await deps.repo.findDocumentByCodeVersion(code, version);
    if (existing && existing.id !== id) {
      throw new HttpError('conflict', `La version « ${version} » du document « ${code} » existe déjà.`);
    }
  }
  const updated = await deps.repo.updateDocument(id, {
    ...(patch.code !== undefined ? { code: patch.code } : {}),
    ...(patch.title !== undefined ? { title: patch.title } : {}),
    ...(patch.version !== undefined ? { version: patch.version } : {}),
    ...(patch.doc_type !== undefined ? { doc_type: patch.doc_type } : {}),
    ...(patch.effective_date !== undefined ? { effective_date: patch.effective_date } : {}),
  });
  return { document: updated, archived_ids: [] };
}

export async function activateDocument(deps: AdminDeps, id: string): Promise<DocumentStatusResponse> {
  const document = await requireDocument(deps, id);
  if (document.ingestion_status !== 'ready') {
    throw new HttpError('conflict', "Le document n'est pas prêt : terminez l'ingestion avant de l'activer.");
  }
  if (document.status === 'archived') {
    throw new HttpError('conflict', 'Un document archivé ne peut pas être réactivé : importez-le comme nouvelle version.');
  }
  const { document: activated, archivedIds } = await deps.repo.activateDocument(id);
  return { document: activated, archived_ids: archivedIds };
}

export async function archiveDocument(deps: AdminDeps, id: string): Promise<DocumentStatusResponse> {
  const document = await requireDocument(deps, id);
  if (document.status === 'archived') return { document, archived_ids: [] };
  return { document: await deps.repo.archiveDocument(id), archived_ids: [] };
}

export async function deleteDocument(deps: AdminDeps, id: string): Promise<DocumentStatusResponse> {
  const document = await requireDocument(deps, id);
  if (document.status === 'active') {
    throw new HttpError('conflict', 'Archivez le document avant de le supprimer : il est actuellement interrogeable.');
  }
  if (document.storage_path) await deps.storage.remove([document.storage_path]);
  await deps.repo.deleteDocument(id);
  return { document, archived_ids: [] };
}

export async function getDocumentFileUrl(deps: AdminDeps, id: string): Promise<DocumentFileUrlResponse> {
  const document = await requireDocument(deps, id);
  if (!document.storage_path) throw new HttpError('not_found', "Aucun fichier n'est associé à ce document.");
  const url = await deps.storage.createSignedUrl(document.storage_path, FILE_URL_TTL_SECONDS, document.original_filename);
  return { url, expires_in: FILE_URL_TTL_SECONDS, filename: document.original_filename };
}
