/**
 * Payloads des routes API (App Router, src/app/api/**).
 *
 * Conventions :
 *  - JSON en entrée et en sortie (sauf /api/chat : réponse SSE).
 *  - Erreur : statut HTTP 4xx/5xx + corps ApiErrorBody.
 *  - Toute route revérifie l'utilisateur côté serveur (requireUser /
 *    requireAdmin, src/lib/auth.ts) ; rien n'est déduit du client.
 *
 * Répartition : /api/auth/* (tâche 1), /api/chat + /api/conversations
 * (tâche 4), /api/admin/documents/* (tâche 2), /api/admin/users (tâche 1 pour
 * le contrat, implémentation tâche 5 si besoin).
 */
import { z } from 'zod';

import {
  allowedEmailSchema,
  analysisSheetSchema,
  conversationSchema,
  docTypeSchema,
  emailSchema,
  ingestionJobSchema,
  labDocumentSchema,
  MAX_UPLOAD_BYTES,
  messageSchema,
  profileSchema,
  sourceSchema,
  supportedMimeTypeSchema,
  userRoleSchema,
} from './domain';

// --- Erreurs -----------------------------------------------------------------

export const apiErrorCodeSchema = z.enum([
  'bad_request',
  'unauthenticated',
  'forbidden',
  'not_found',
  'conflict',
  'rate_limited',
  'payload_too_large',
  'unavailable',
  'internal',
]);
export type ApiErrorCode = z.infer<typeof apiErrorCodeSchema>;

export const apiErrorBodySchema = z.object({
  error: z.object({
    code: apiErrorCodeSchema,
    /** Message en français, affichable. */
    message: z.string(),
    /** Détails de validation éventuels (chemins zod). */
    issues: z.array(z.object({ path: z.string(), message: z.string() })).optional(),
  }),
});
export type ApiErrorBody = z.infer<typeof apiErrorBodySchema>;

// --- Auth (tâche 1) ----------------------------------------------------------

/** POST /api/auth/magic-link */
export const magicLinkRequestSchema = z.object({
  email: emailSchema,
  /** Chemin relatif où revenir après connexion (« /admin »). */
  next: z.string().startsWith('/').max(200).optional(),
});
export type MagicLinkRequest = z.infer<typeof magicLinkRequestSchema>;

/** Réponse IDENTIQUE que l'email soit autorisé ou non. */
export const magicLinkResponseSchema = z.object({
  ok: z.literal(true),
  message: z.string(),
});
export type MagicLinkResponse = z.infer<typeof magicLinkResponseSchema>;

// --- Chat (tâche 4) ----------------------------------------------------------

export const CHAT_MESSAGE_MAX_LENGTH = 2000;

/** POST /api/chat -> text/event-stream de ChatEvent (chat-events.ts). */
export const chatRequestSchema = z.object({
  /** Absent : nouvelle conversation créée par le serveur. */
  conversation_id: z.uuid().optional(),
  message: z.string().trim().min(1).max(CHAT_MESSAGE_MAX_LENGTH),
});
export type ChatRequest = z.infer<typeof chatRequestSchema>;

/** GET /api/conversations */
export const conversationListResponseSchema = z.object({
  conversations: z.array(conversationSchema),
});
export type ConversationListResponse = z.infer<typeof conversationListResponseSchema>;

/** GET /api/conversations/[id] */
export const conversationDetailResponseSchema = z.object({
  conversation: conversationSchema,
  messages: z.array(messageSchema.extend({ sources: z.array(sourceSchema) })),
});
export type ConversationDetailResponse = z.infer<typeof conversationDetailResponseSchema>;

/** PATCH /api/conversations/[id] */
export const conversationUpdateRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
});
export type ConversationUpdateRequest = z.infer<typeof conversationUpdateRequestSchema>;

// --- Admin : documents (tâche 2) -----------------------------------------------

/**
 * POST /api/admin/documents
 * Crée un document `draft` et renvoie une URL d'upload signée : le navigateur
 * envoie le fichier DIRECTEMENT à Supabase Storage (les fonctions Vercel
 * limitent la taille du corps de requête).
 */
export const createDocumentRequestSchema = z.object({
  code: z.string().trim().min(1).max(100),
  title: z.string().trim().min(1).max(300),
  version: z.string().trim().min(1).max(50),
  doc_type: docTypeSchema,
  effective_date: z.iso.date().optional(),
  filename: z.string().trim().min(1).max(255),
  mime_type: supportedMimeTypeSchema,
  file_size: z.number().int().min(1).max(MAX_UPLOAD_BYTES),
  /** SHA-256 hexadécimal calculé côté navigateur (détection de doublons). */
  sha256: z.string().regex(/^[0-9a-f]{64}$/).optional(),
});
export type CreateDocumentRequest = z.infer<typeof createDocumentRequestSchema>;

export const createDocumentResponseSchema = z.object({
  document: labDocumentSchema,
  upload: z.object({
    bucket: z.literal('documents'),
    path: z.string(),
    signed_url: z.url(),
    token: z.string(),
  }),
});
export type CreateDocumentResponse = z.infer<typeof createDocumentResponseSchema>;

/** GET /api/admin/documents?status=… */
export const documentListQuerySchema = z.object({
  status: z.enum(['draft', 'active', 'archived', 'all']).default('all'),
});
export type DocumentListQuery = z.infer<typeof documentListQuerySchema>;

export const documentListResponseSchema = z.object({
  documents: z.array(labDocumentSchema),
});
export type DocumentListResponse = z.infer<typeof documentListResponseSchema>;

/** GET /api/admin/documents/[id] */
export const documentDetailResponseSchema = z.object({
  document: labDocumentSchema,
  latest_job: ingestionJobSchema.nullable(),
  analyses: z.array(analysisSheetSchema),
  page_count: z.number().int(),
  chunk_count: z.number().int(),
});
export type DocumentDetailResponse = z.infer<typeof documentDetailResponseSchema>;

/** PATCH /api/admin/documents/[id] (métadonnées d'un draft uniquement) */
export const updateDocumentRequestSchema = createDocumentRequestSchema
  .pick({ code: true, title: true, version: true, doc_type: true, effective_date: true })
  .partial();
export type UpdateDocumentRequest = z.infer<typeof updateDocumentRequestSchema>;

/**
 * POST /api/admin/documents/[id]/ingest : crée (ou relance) un job.
 * POST /api/admin/documents/[id]/ingest/step : avance d'un lot borné dans le
 * temps ; le client rappelle tant que `done` est faux.
 */
export const ingestResponseSchema = z.object({
  job: ingestionJobSchema,
  document: labDocumentSchema,
  done: z.boolean(),
});
export type IngestResponse = z.infer<typeof ingestResponseSchema>;

/** POST /api/admin/documents/[id]/activate | /archive ; DELETE /api/admin/documents/[id] */
export const documentStatusResponseSchema = z.object({
  document: labDocumentSchema,
  /** Versions archivées automatiquement par l'activation. */
  archived_ids: z.array(z.uuid()).default([]),
});
export type DocumentStatusResponse = z.infer<typeof documentStatusResponseSchema>;

// --- Admin : utilisateurs ------------------------------------------------------

/** GET /api/admin/users */
export const userListResponseSchema = z.object({
  allowed_emails: z.array(allowedEmailSchema),
  profiles: z.array(profileSchema),
});
export type UserListResponse = z.infer<typeof userListResponseSchema>;

/** POST /api/admin/users (ajout ou mise à jour d'une adresse autorisée) */
export const upsertAllowedEmailRequestSchema = z.object({
  email: emailSchema,
  role: userRoleSchema.default('member'),
  note: z.string().trim().max(200).optional(),
});
export type UpsertAllowedEmailRequest = z.infer<typeof upsertAllowedEmailRequestSchema>;

export const upsertAllowedEmailResponseSchema = z.object({
  allowed_email: allowedEmailSchema,
});
export type UpsertAllowedEmailResponse = z.infer<typeof upsertAllowedEmailResponseSchema>;

/** DELETE /api/admin/users?email=… (révocation ; un admin ne peut pas se retirer lui-même) */
export const deleteAllowedEmailQuerySchema = z.object({ email: emailSchema });
export type DeleteAllowedEmailQuery = z.infer<typeof deleteAllowedEmailQuerySchema>;
