/**
 * Types du domaine LabGuard (miroir des tables de supabase/migrations).
 *
 * Les schémas zod valident les données qui traversent une frontière
 * (RPC, API, LLM). Les types TypeScript en sont dérivés : une seule source.
 * Champs en snake_case = noms de colonnes SQL.
 */
import { z } from 'zod';

export const uuidSchema = z.uuid();
const timestamp = z.string().min(1);

// --- Utilisateurs ------------------------------------------------------------

export const userRoleSchema = z.enum(['admin', 'member']);
export type UserRole = z.infer<typeof userRoleSchema>;

export const profileSchema = z.object({
  id: uuidSchema,
  email: z.string(),
  display_name: z.string().nullable(),
  role: userRoleSchema,
  allowed: z.boolean(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type Profile = z.infer<typeof profileSchema>;

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254)
  .pipe(z.email({ error: 'Adresse email invalide.' }));

export const allowedEmailSchema = z.object({
  email: z.string(),
  role: userRoleSchema,
  note: z.string().nullable(),
  created_by: uuidSchema.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type AllowedEmail = z.infer<typeof allowedEmailSchema>;

// --- Documents ---------------------------------------------------------------

export const documentStatusSchema = z.enum(['draft', 'active', 'archived']);
export type DocumentStatus = z.infer<typeof documentStatusSchema>;

export const docTypeSchema = z.enum(['sampling_manual', 'test_catalog', 'procedure', 'other']);
export type DocType = z.infer<typeof docTypeSchema>;

export const DOC_TYPE_LABELS: Record<DocType, string> = {
  sampling_manual: 'Manuel de prélèvement',
  test_catalog: "Catalogue d'analyses",
  procedure: 'Procédure',
  other: 'Autre',
};

export const ingestionStatusSchema = z.enum(['pending', 'processing', 'ready', 'failed']);
export type IngestionStatus = z.infer<typeof ingestionStatusSchema>;

/** Types MIME acceptés à l'import (identiques au bucket Storage). */
export const SUPPORTED_MIME_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain',
  'text/csv',
] as const;
export const supportedMimeTypeSchema = z.enum(SUPPORTED_MIME_TYPES);
export type SupportedMimeType = z.infer<typeof supportedMimeTypeSchema>;
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;

/** Ligne de `documents`. Nommé LabDocument pour ne pas masquer le DOM `Document`. */
export const labDocumentSchema = z.object({
  id: uuidSchema,
  code: z.string(),
  title: z.string(),
  version: z.string(),
  doc_type: docTypeSchema,
  status: documentStatusSchema,
  effective_date: z.string().nullable(),
  storage_path: z.string().nullable(),
  original_filename: z.string().nullable(),
  mime_type: z.string().nullable(),
  file_size: z.number().int().nullable(),
  sha256: z.string().nullable(),
  page_count: z.number().int().nullable(),
  ingestion_status: ingestionStatusSchema,
  ingestion_error: z.string().nullable(),
  activated_at: timestamp.nullable(),
  archived_at: timestamp.nullable(),
  created_by: uuidSchema.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type LabDocument = z.infer<typeof labDocumentSchema>;

export const documentPageSchema = z.object({
  document_id: uuidSchema,
  page_number: z.number().int().min(1),
  content: z.string(),
  label: z.string().nullable(),
});
export type DocumentPage = z.infer<typeof documentPageSchema>;

export const chunkKindSchema = z.enum(['text', 'table_row', 'table']);
export type ChunkKind = z.infer<typeof chunkKindSchema>;

/** Ligne de `chunks` (sans les colonnes générées fts/search_norm). */
export const chunkSchema = z.object({
  id: uuidSchema,
  document_id: uuidSchema,
  page_number: z.number().int().min(1),
  chunk_index: z.number().int().min(0),
  kind: chunkKindSchema,
  heading: z.string().nullable(),
  content: z.string().min(1),
  char_start: z.number().int().nullable(),
  char_end: z.number().int().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  created_at: timestamp,
});
export type Chunk = z.infer<typeof chunkSchema>;

// --- Fiches d'analyses -------------------------------------------------------

export const ANALYSIS_FIELDS = [
  'name',
  'synonyms',
  'codes',
  'accepted_tubes',
  'rejected_tubes',
  'volume',
  'transport',
  'storage',
  'stability',
  'turnaround_time',
  'remarks',
] as const;
export const analysisFieldSchema = z.enum(ANALYSIS_FIELDS);
export type AnalysisField = z.infer<typeof analysisFieldSchema>;

export const ANALYSIS_FIELD_LABELS: Record<AnalysisField, string> = {
  name: 'Analyse',
  synonyms: 'Synonymes',
  codes: 'Codes',
  accepted_tubes: 'Tubes acceptés',
  rejected_tubes: 'Tubes refusés',
  volume: 'Volume',
  transport: 'Transport',
  storage: 'Conservation',
  stability: 'Stabilité',
  turnaround_time: 'Délai de rendu',
  remarks: 'Remarques',
};

/** Citation vérifiée rattachant un champ de fiche à un chunk. */
export const fieldSourceSchema = z.object({
  chunk_id: uuidSchema,
  quote: z.string().min(1),
});
export type FieldSource = z.infer<typeof fieldSourceSchema>;

/**
 * Fiche d'analyse (table `analyses` + `analysis_field_sources`).
 * Invariant : tout champ renseigné a une entrée dans `field_sources`.
 */
export const analysisSheetSchema = z.object({
  id: uuidSchema,
  document_id: uuidSchema,
  name: z.string().min(1),
  synonyms: z.array(z.string()),
  codes: z.array(z.string()),
  accepted_tubes: z.array(z.string()),
  rejected_tubes: z.array(z.string()),
  volume: z.string().nullable(),
  transport: z.string().nullable(),
  storage: z.string().nullable(),
  stability: z.string().nullable(),
  turnaround_time: z.string().nullable(),
  remarks: z.string().nullable(),
  source_chunk_id: uuidSchema,
  source_quote: z.string().min(1),
  field_sources: z.partialRecord(analysisFieldSchema, fieldSourceSchema),
});
export type AnalysisSheet = z.infer<typeof analysisSheetSchema>;

/**
 * Fiche telle que produite par l'extraction LLM (tâche 2), avant insertion :
 * pas encore d'id ; chaque champ renseigné porte sa citation.
 */
export const extractedAnalysisSchema = analysisSheetSchema.omit({
  id: true,
  document_id: true,
});
export type ExtractedAnalysis = z.infer<typeof extractedAnalysisSchema>;

// --- Glossaire ---------------------------------------------------------------

export const synonymSchema = z.object({
  id: z.number().int(),
  group_key: z.string().regex(/^[a-z0-9_]+$/),
  term: z.string().min(1),
  term_norm: z.string(),
  note: z.string().nullable(),
  created_at: timestamp,
});
export type Synonym = z.infer<typeof synonymSchema>;

// --- Ingestion ---------------------------------------------------------------

export const ingestionJobStatusSchema = z.enum([
  'queued',
  'running',
  'succeeded',
  'failed',
  'cancelled',
]);
export type IngestionJobStatus = z.infer<typeof ingestionJobStatusSchema>;

export const ingestionStageSchema = z.enum(['parse', 'chunk', 'extract_analyses', 'finalize']);
export type IngestionStage = z.infer<typeof ingestionStageSchema>;

export const ingestionJobSchema = z.object({
  id: uuidSchema,
  document_id: uuidSchema,
  status: ingestionJobStatusSchema,
  stage: ingestionStageSchema,
  cursor: z.record(z.string(), z.unknown()),
  progress: z.number().int(),
  total: z.number().int().nullable(),
  attempts: z.number().int(),
  last_error: z.string().nullable(),
  locked_at: timestamp.nullable(),
  locked_by: z.string().nullable(),
  created_by: uuidSchema.nullable(),
  created_at: timestamp,
  updated_at: timestamp,
  finished_at: timestamp.nullable(),
});
export type IngestionJob = z.infer<typeof ingestionJobSchema>;

// --- Conversations -----------------------------------------------------------

export const conversationSchema = z.object({
  id: uuidSchema,
  user_id: uuidSchema,
  title: z.string(),
  created_at: timestamp,
  updated_at: timestamp,
});
export type Conversation = z.infer<typeof conversationSchema>;

export const messageRoleSchema = z.enum(['user', 'assistant']);
export type MessageRole = z.infer<typeof messageRoleSchema>;

export const messageStatusSchema = z.enum(['complete', 'insufficient', 'error']);
export type MessageStatus = z.infer<typeof messageStatusSchema>;

export const verdictSchema = z.enum(['conforme', 'non_conforme', 'a_verifier']);
export type Verdict = z.infer<typeof verdictSchema>;

export const VERDICT_LABELS: Record<Verdict, string> = {
  conforme: 'Conforme',
  non_conforme: 'Non conforme',
  a_verifier: 'À vérifier',
};

export const llmUsageSchema = z.object({
  input_tokens: z.number().int().min(0),
  output_tokens: z.number().int().min(0),
  /** Nombre d'appels au fournisseur cumulés (boucle agent). */
  calls: z.number().int().min(0).optional(),
});
export type LlmUsage = z.infer<typeof llmUsageSchema>;

/** Ligne de `messages`. `answer` contient une VerifiedAnswer (cf. answer.ts). */
export const messageSchema = z.object({
  id: uuidSchema,
  conversation_id: uuidSchema,
  user_id: uuidSchema,
  role: messageRoleSchema,
  content: z.string(),
  answer: z.unknown().nullable(),
  status: messageStatusSchema,
  verdict: verdictSchema.nullable(),
  llm_provider: z.string().nullable(),
  llm_model: z.string().nullable(),
  usage: llmUsageSchema.nullable(),
  latency_ms: z.number().int().nullable(),
  created_at: timestamp,
});
export type Message = z.infer<typeof messageSchema>;

/**
 * Source citée (snapshot). Reste affichable si le document est archivé ou
 * supprimé (chunk_id / document_id deviennent alors null).
 */
export const sourceSchema = z.object({
  id: uuidSchema,
  message_id: uuidSchema,
  paragraph_index: z.number().int().min(0),
  citation_index: z.number().int().min(0),
  chunk_id: uuidSchema.nullable(),
  document_id: uuidSchema.nullable(),
  document_code: z.string(),
  document_title: z.string(),
  document_version: z.string(),
  page_number: z.number().int(),
  quote: z.string(),
  excerpt: z.string(),
  created_at: timestamp,
});
export type Source = z.infer<typeof sourceSchema>;

// --- Résultats des RPC de recherche (0003_search.sql) -------------------------

export const chunkSearchResultSchema = z.object({
  chunk_id: uuidSchema,
  document_id: uuidSchema,
  document_code: z.string(),
  document_title: z.string(),
  document_version: z.string(),
  doc_type: docTypeSchema,
  page_number: z.number().int(),
  chunk_index: z.number().int(),
  kind: chunkKindSchema,
  heading: z.string().nullable(),
  content: z.string(),
  score: z.number(),
  fts_score: z.number(),
  synonym_score: z.number(),
  trigram_score: z.number(),
  matched_synonyms: z.array(z.string()),
});
export type ChunkSearchResult = z.infer<typeof chunkSearchResultSchema>;

export const analysisSearchResultSchema = z.object({
  analysis_id: uuidSchema,
  document_id: uuidSchema,
  document_code: z.string(),
  document_title: z.string(),
  document_version: z.string(),
  name: z.string(),
  synonyms: z.array(z.string()),
  codes: z.array(z.string()),
  accepted_tubes: z.array(z.string()),
  rejected_tubes: z.array(z.string()),
  volume: z.string().nullable(),
  transport: z.string().nullable(),
  storage: z.string().nullable(),
  stability: z.string().nullable(),
  turnaround_time: z.string().nullable(),
  remarks: z.string().nullable(),
  source_chunk_id: uuidSchema,
  source_quote: z.string(),
  source_page_number: z.number().int(),
  field_sources: z.partialRecord(analysisFieldSchema, fieldSourceSchema),
  score: z.number(),
  matched_synonyms: z.array(z.string()),
});
export type AnalysisSearchResult = z.infer<typeof analysisSearchResultSchema>;

export const pageReadResultSchema = z.object({
  document_id: uuidSchema,
  document_code: z.string(),
  document_title: z.string(),
  document_version: z.string(),
  page_count: z.number().int().nullable(),
  page_number: z.number().int(),
  label: z.string().nullable(),
  content: z.string(),
});
export type PageReadResult = z.infer<typeof pageReadResultSchema>;
