/**
 * Événements SSE de POST /api/chat.
 *
 * Format sur le fil (text/event-stream) : un événement par bloc
 *
 *   event: <type>\n
 *   data: <JSON de l'événement, type inclus>\n\n
 *
 * Séquence nominale :
 *   conversation -> step* -> answer -> done
 * En cas d'échec : conversation? -> step* -> error -> done
 * Le serveur n'envoie JAMAIS de texte de réponse non vérifié : la réponse
 * n'arrive qu'en un bloc, dans `answer`, après vérification des citations.
 */
import { z } from 'zod';

import { verifiedAnswerSchema } from './answer';
import { messageStatusSchema } from './domain';

export const chatStepSchema = z.enum([
  'search_analyses',
  'search_documents',
  'read_page',
  'compose',
  'verify',
]);
export type ChatStep = z.infer<typeof chatStepSchema>;

/** Libellés français par défaut des étapes (le serveur peut les préciser). */
export const CHAT_STEP_LABELS: Record<ChatStep, string> = {
  search_analyses: "Recherche dans les fiches d'analyses…",
  search_documents: 'Recherche dans les documents…',
  read_page: 'Lecture de la page…',
  compose: 'Rédaction de la réponse…',
  verify: 'Vérification des citations…',
};

export const chatErrorCodeSchema = z.enum([
  'unauthenticated',
  'forbidden',
  'bad_request',
  'rate_limited',
  'llm_unavailable',
  'internal',
]);
export type ChatErrorCode = z.infer<typeof chatErrorCodeSchema>;

export const chatEventSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('conversation'),
    conversation_id: z.uuid(),
    user_message_id: z.uuid(),
  }),
  z.object({
    type: z.literal('step'),
    step: chatStepSchema,
    /** Texte affichable en français (ex. « Recherche : tube mauve »). */
    label: z.string(),
    /** Numéro du tour de la boucle agent (1..AGENT_MAX_TURNS). */
    turn: z.number().int().min(1).optional(),
  }),
  z.object({
    type: z.literal('answer'),
    message_id: z.uuid(),
    status: messageStatusSchema,
    answer: verifiedAnswerSchema,
  }),
  z.object({
    type: z.literal('error'),
    code: chatErrorCodeSchema,
    /** Message en français, sans détail technique. */
    message: z.string(),
  }),
  z.object({ type: z.literal('done') }),
]);
export type ChatEvent = z.infer<typeof chatEventSchema>;
export type ChatEventType = ChatEvent['type'];
export type ChatEventOf<T extends ChatEventType> = Extract<ChatEvent, { type: T }>;
