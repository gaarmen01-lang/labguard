/**
 * Réponse finale du chatbot.
 *
 * 1. Le LLM produit une `FinalAnswer` (JSON structuré, cf. FINAL_ANSWER_JSON_SCHEMA).
 * 2. Le serveur la valide (zod) puis vérifie CHAQUE citation : le chunk existe,
 *    appartient à un document actif, et `quote` y figure textuellement après
 *    normalisation (quoteAppearsIn, text.ts).
 * 3. Succès -> `VerifiedAnswer` (citations enrichies : document, version, page).
 *    Échec -> réponse « information insuffisante » (insufficientAnswer()).
 */
import { z } from 'zod';

import { verdictSchema } from './domain';

export const MAX_PARAGRAPHS = 8;
export const MAX_CITATIONS_PER_PARAGRAPH = 6;
export const MAX_QUOTE_LENGTH = 600;

export const INSUFFICIENT_ANSWER_TEXT =
  "Information insuffisante : les documents du laboratoire ne permettent pas de répondre avec certitude. Vérifiez auprès d'un biologiste ou dans la procédure concernée.";

// --- Sortie brute du LLM ------------------------------------------------------

export const answerCitationSchema = z.object({
  /** Identifiant d'un chunk renvoyé par un outil de recherche pendant ce tour. */
  chunk_id: z.string().min(1),
  /** Extrait copié mot pour mot du chunk (pas de reformulation). */
  quote: z.string().trim().min(1).max(MAX_QUOTE_LENGTH),
});
export type AnswerCitation = z.infer<typeof answerCitationSchema>;

export const answerParagraphSchema = z.object({
  text: z.string().trim().min(1).max(4000),
  citations: z.array(answerCitationSchema).max(MAX_CITATIONS_PER_PARAGRAPH),
});
export type AnswerParagraph = z.infer<typeof answerParagraphSchema>;

export const finalAnswerSchema = z
  .object({
    insufficient: z.boolean(),
    /** Absent ou null quand la question n'appelle pas de verdict de conformité. */
    verdict: verdictSchema.nullish().transform((value) => value ?? null),
    paragraphs: z.array(answerParagraphSchema).max(MAX_PARAGRAPHS),
  })
  .superRefine((answer, ctx) => {
    if (answer.insufficient) {
      if (answer.verdict !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['verdict'],
          message: 'Pas de verdict quand la réponse est insuffisante.',
        });
      }
      return;
    }
    if (answer.paragraphs.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['paragraphs'],
        message: 'Une réponse suffisante contient au moins un paragraphe.',
      });
    }
    answer.paragraphs.forEach((paragraph, index) => {
      if (paragraph.citations.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['paragraphs', index, 'citations'],
          message: 'Chaque paragraphe doit citer au moins une source.',
        });
      }
    });
  });
export type FinalAnswer = z.output<typeof finalAnswerSchema>;

/**
 * JSON Schema transmis au fournisseur LLM pour la sortie structurée.
 * Écrit à la main pour rester compatible avec les modes « strict » des
 * fournisseurs (tous les champs requis, verdict nullable, pas de champs
 * supplémentaires). Les règles métier sont revérifiées par finalAnswerSchema.
 */
export const FINAL_ANSWER_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['insufficient', 'verdict', 'paragraphs'],
  properties: {
    insufficient: {
      type: 'boolean',
      description:
        'true si les extraits trouvés ne permettent pas de répondre avec certitude.',
    },
    verdict: {
      type: ['string', 'null'],
      enum: ['conforme', 'non_conforme', 'a_verifier', null],
      description:
        "Conformité de l'échantillon/de la situation décrite, ou null si sans objet ou insuffisant.",
    },
    paragraphs: {
      type: 'array',
      maxItems: MAX_PARAGRAPHS,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'citations'],
        properties: {
          text: { type: 'string', description: 'Paragraphe de réponse en français.' },
          citations: {
            type: 'array',
            maxItems: MAX_CITATIONS_PER_PARAGRAPH,
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['chunk_id', 'quote'],
              properties: {
                chunk_id: { type: 'string', description: 'chunk_id exact renvoyé par un outil.' },
                quote: {
                  type: 'string',
                  description: 'Extrait copié mot pour mot du chunk, sans reformulation.',
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

// --- Réponse vérifiée (stockée dans messages.answer, envoyée au client) -------

export const verifiedCitationSchema = z.object({
  chunk_id: z.uuid(),
  quote: z.string(),
  document_id: z.uuid(),
  document_code: z.string(),
  document_title: z.string(),
  document_version: z.string(),
  page_number: z.number().int(),
});
export type VerifiedCitation = z.infer<typeof verifiedCitationSchema>;

export const verifiedAnswerSchema = z.object({
  insufficient: z.boolean(),
  verdict: verdictSchema.nullable(),
  paragraphs: z.array(
    z.object({
      text: z.string(),
      citations: z.array(verifiedCitationSchema),
    }),
  ),
});
export type VerifiedAnswer = z.infer<typeof verifiedAnswerSchema>;

/** Pourquoi une FinalAnswer a été rejetée (journalisé, jamais montré tel quel). */
export const answerRejectionReasonSchema = z.enum([
  'invalid_json',
  'schema_violation',
  'unknown_chunk',
  'inactive_document',
  'quote_not_found',
  'missing_citation',
  'max_turns_exceeded',
  'provider_error',
]);
export type AnswerRejectionReason = z.infer<typeof answerRejectionReasonSchema>;

export type AnswerVerificationResult =
  | { ok: true; answer: VerifiedAnswer }
  | { ok: false; reason: AnswerRejectionReason; detail: string };

/** Réponse de repli affichée quand rien n'est vérifiable. */
export function insufficientAnswer(): VerifiedAnswer {
  return {
    insufficient: true,
    verdict: null,
    paragraphs: [{ text: INSUFFICIENT_ANSWER_TEXT, citations: [] }],
  };
}

