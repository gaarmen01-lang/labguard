/**
 * Accès aux données de l'ingestion et de l'administration des documents.
 *
 * Interface étroite implémentée par :
 *  - `createSupabaseRepository` (supabase-js, client service_role, production) ;
 *  - un adaptateur PGlite dans les tests (même SQL, même schéma).
 * Toutes les écritures d'étape sont des REMPLACEMENTS (supprimer puis
 * réinsérer pour un périmètre donné) : rejouer une étape ne crée pas de doublon.
 */
import type {
  AnalysisSheet,
  Chunk,
  ChunkKind,
  DocType,
  DocumentStatus,
  ExtractedAnalysis,
  IngestionJob,
  IngestionStage,
  IngestionJobStatus,
  IngestionStatus,
  LabDocument,
} from '@/lib/contracts';

import type { GlossaryEntry } from './tubes';

export interface NewDocument {
  id: string;
  code: string;
  title: string;
  version: string;
  doc_type: DocType;
  effective_date: string | null;
  storage_path: string;
  original_filename: string;
  mime_type: string;
  file_size: number;
  sha256: string | null;
  created_by: string | null;
}

export interface DocumentPatch {
  code?: string;
  title?: string;
  version?: string;
  doc_type?: DocType;
  effective_date?: string | null;
  page_count?: number | null;
  ingestion_status?: IngestionStatus;
  ingestion_error?: string | null;
  sha256?: string | null;
}

export interface JobPatch {
  status?: IngestionJobStatus;
  stage?: IngestionStage;
  cursor?: Record<string, unknown>;
  progress?: number;
  total?: number | null;
  attempts?: number;
  last_error?: string | null;
  locked_at?: string | null;
  locked_by?: string | null;
  finished_at?: string | null;
}

export interface PageInsert {
  page_number: number;
  content: string;
  label: string | null;
}

export interface ChunkInsert {
  page_number: number;
  chunk_index: number;
  kind: ChunkKind;
  heading: string | null;
  content: string;
  char_start: number | null;
  char_end: number | null;
  metadata: Record<string, unknown>;
}

export interface IngestionRepository {
  // Documents
  getDocument(id: string): Promise<LabDocument | null>;
  listDocuments(status: DocumentStatus | 'all'): Promise<LabDocument[]>;
  findDocumentByCodeVersion(code: string, version: string): Promise<LabDocument | null>;
  findDocumentsBySha256(sha256: string): Promise<LabDocument[]>;
  insertDocument(document: NewDocument): Promise<LabDocument>;
  updateDocument(id: string, patch: DocumentPatch): Promise<LabDocument>;
  deleteDocument(id: string): Promise<void>;
  /** RPC activate_document ; renvoie le document et les versions archivées. */
  activateDocument(id: string): Promise<{ document: LabDocument; archivedIds: string[] }>;
  archiveDocument(id: string): Promise<LabDocument>;

  // Jobs
  getLatestJob(documentId: string): Promise<IngestionJob | null>;
  insertJob(job: { document_id: string; created_by: string | null; cursor: Record<string, unknown> }): Promise<IngestionJob>;
  updateJob(id: string, patch: JobPatch): Promise<IngestionJob>;
  /**
   * Prend le verrou du job s'il est libre ou périmé (locked_at < staleBefore)
   * et si le job n'est pas terminé. Renvoie le job verrouillé, ou null.
   */
  tryLockJob(id: string, owner: string, now: Date, staleBefore: Date): Promise<IngestionJob | null>;
  /** Libère le verrou seulement s'il appartient toujours à `owner`. */
  unlockJob(id: string, owner: string, patch: JobPatch): Promise<IngestionJob | null>;

  // Contenu
  replacePages(documentId: string, pages: PageInsert[]): Promise<void>;
  listPages(documentId: string): Promise<Array<PageInsert & { document_id: string }>>;
  countPages(documentId: string): Promise<number>;
  replaceChunks(documentId: string, chunks: ChunkInsert[]): Promise<void>;
  listChunks(documentId: string, options?: { page?: number; offset?: number; limit?: number }): Promise<Chunk[]>;
  countChunks(documentId: string, options?: { page?: number }): Promise<number>;
  /**
   * Remplace les fiches dont le chunk source est dans `chunkIds` (ou toutes
   * celles du document si `chunkIds` vaut 'all') par `analyses`.
   */
  replaceAnalyses(documentId: string, chunkIds: string[] | 'all', analyses: ExtractedAnalysis[]): Promise<number>;
  listAnalyses(documentId: string): Promise<AnalysisSheet[]>;
  loadGlossary(): Promise<GlossaryEntry[]>;
}
