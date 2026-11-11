/**
 * Vérification des citations d'une FinalAnswer.
 *
 * Règles :
 *  - chaque `chunk_id` doit avoir été renvoyé par un outil pendant CE tour ;
 *  - chaque `quote` doit figurer dans le texte du chunk (quoteAppearsIn :
 *    casse, accents, espaces, ponctuation, césures tolérés ; mots entiers),
 *    avec une longueur minimale (sauf si elle reprend l'extrait entier) ;
 *  - les métadonnées (titre, code, version, page) viennent du registre
 *    (résultats des RPC), jamais du modèle ;
 *  - un paragraphe dont une citation est invalide est retiré (mode strict,
 *    par défaut) — en mode non strict, seules les citations invalides sont
 *    retirées et le paragraphe reste s'il en garde au moins une ;
 *  - une citation qui ressemble à une consigne adressée à l'assistant
 *    (injection dans un document) n'étaye rien ;
 *  - plus aucun paragraphe, ou verdict dont le paragraphe porteur (le premier)
 *    a été retiré -> réponse « insuffisante ».
 */
import {
  insufficientAnswer,
  normalizeTokens,
  quoteAppearsIn,
  type AnswerRejectionReason,
  type FinalAnswer,
  type VerifiedAnswer,
  type VerifiedCitation,
} from '@/lib/contracts';

import { RetrievedChunks, type RetrievedChunk } from './evidence';

/** Nombre minimal de mots d'une citation (après normalisation). */
export const MIN_QUOTE_TOKENS = 3;
/** Longueur minimale d'une citation normalisée (caractères). */
export const MIN_QUOTE_CHARS = 12;

export type CitationIssueReason =
  | 'unknown_chunk'
  | 'quote_not_found'
  | 'quote_too_short'
  | 'unknown_page'
  | 'suspicious_quote';

/**
 * Formulations typiques d'une injection de consignes (sur texte normalisé).
 * Un passage qui s'adresse à l'assistant n'étaye jamais une réponse.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|ignorez|oublie|oubliez)( toutes?)? (tes|vos|les|ces)( \w+)? (instructions|consignes|regles)\b/,
  /\bignore (all |the )?(previous|prior|above) instructions\b/,
  /\b(reponds|repondez|repondre) (que|toujours|uniquement)\b/,
  /\b(tu es|vous etes) (desormais|maintenant)\b/,
  /\byou are now\b/,
  /\b(nouvelles? (instructions|consignes)|prompt systeme|system prompt|message systeme)\b/,
];

/** Vrai si le texte ressemble à une consigne adressée à l'assistant. */
export function looksLikeInjection(text: string): boolean {
  const normalized = normalizeTokens(text);
  return INJECTION_PATTERNS.some((pattern) => pattern.test(normalized));
}

export interface CitationIssue {
  paragraphIndex: number;
  citationIndex: number;
  chunk_id: string;
  quote: string;
  reason: CitationIssueReason;
}

export interface VerificationReport {
  answer: VerifiedAnswer;
  status: 'complete' | 'insufficient';
  issues: CitationIssue[];
  /** Index (dans la réponse du modèle) des paragraphes retirés. */
  droppedParagraphs: number[];
  /** Motif quand la réponse du modèle a été remplacée par « insuffisant ». */
  rejection: { reason: AnswerRejectionReason; detail: string } | null;
}

export interface VerifyOptions {
  /** Retire tout paragraphe portant une citation invalide (défaut true). */
  strict?: boolean;
}

type ChunkSource = RetrievedChunks | Iterable<RetrievedChunk>;

function lookup(source: ChunkSource): (id: string) => RetrievedChunk | undefined {
  if (source instanceof RetrievedChunks) return (id) => source.get(id);
  const map = new Map<string, RetrievedChunk>();
  for (const chunk of source) map.set(chunk.chunk_id, chunk);
  return (id) => map.get(id);
}

/** Vrai si la citation est assez longue pour être probante. */
export function quoteLongEnough(quote: string, wholeTexts: readonly string[] = []): boolean {
  const normalized = normalizeTokens(quote);
  const tokens = normalized.split(' ').filter(Boolean).length;
  if (tokens >= MIN_QUOTE_TOKENS && normalized.length >= MIN_QUOTE_CHARS) return true;
  // Une citation courte reste valable si elle reprend un extrait entier (ex. une cellule de fiche).
  return normalized.length > 0 && wholeTexts.some((text) => normalizeTokens(text) === normalized);
}

export function checkCitation(
  citation: { chunk_id: string; quote: string },
  chunk: RetrievedChunk | undefined,
): CitationIssueReason | null {
  if (!chunk) return 'unknown_chunk';
  const texts = chunk.content !== null ? [chunk.content, ...chunk.excerpts] : chunk.excerpts;
  if (!quoteLongEnough(citation.quote, chunk.excerpts)) return 'quote_too_short';
  if (!texts.some((text) => quoteAppearsIn(citation.quote, text))) return 'quote_not_found';
  if (looksLikeInjection(citation.quote)) return 'suspicious_quote';
  if (chunk.page_number === null) return 'unknown_page';
  return null;
}

function rejectionFor(issues: CitationIssue[], fallback: string): { reason: AnswerRejectionReason; detail: string } {
  const first = issues[0];
  if (!first) return { reason: 'missing_citation', detail: fallback };
  const reason: AnswerRejectionReason =
    first.reason === 'unknown_chunk' || first.reason === 'unknown_page' ? 'unknown_chunk' : 'quote_not_found';
  const detail = issues
    .slice(0, 5)
    .map((issue) => `§${issue.paragraphIndex + 1} ${issue.reason} ${issue.chunk_id}`)
    .join('; ');
  return { reason, detail: `${fallback} (${detail})` };
}

/** Vérification détaillée (motifs, paragraphes retirés). */
export function inspectAnswer(final: FinalAnswer, retrieved: ChunkSource, options: VerifyOptions = {}): VerificationReport {
  const strict = options.strict ?? true;
  if (final.insufficient) {
    return { answer: insufficientAnswer(), status: 'insufficient', issues: [], droppedParagraphs: [], rejection: null };
  }

  const get = lookup(retrieved);
  const issues: CitationIssue[] = [];
  const droppedParagraphs: number[] = [];
  const paragraphs: VerifiedAnswer['paragraphs'] = [];

  final.paragraphs.forEach((paragraph, paragraphIndex) => {
    const citations: VerifiedCitation[] = [];
    let invalid = 0;
    paragraph.citations.forEach((citation, citationIndex) => {
      const chunk = get(citation.chunk_id);
      const reason = checkCitation(citation, chunk);
      if (reason !== null || !chunk || chunk.page_number === null) {
        invalid += 1;
        issues.push({
          paragraphIndex,
          citationIndex,
          chunk_id: citation.chunk_id,
          quote: citation.quote,
          reason: reason ?? 'unknown_chunk',
        });
        return;
      }
      const quote = citation.quote.trim();
      if (citations.some((c) => c.chunk_id === chunk.chunk_id && c.quote === quote)) return;
      citations.push({
        chunk_id: chunk.chunk_id,
        quote,
        document_id: chunk.document_id,
        document_code: chunk.document_code,
        document_title: chunk.document_title,
        document_version: chunk.document_version,
        page_number: chunk.page_number,
      });
    });
    const keep = citations.length > 0 && (!strict || invalid === 0);
    if (keep) paragraphs.push({ text: paragraph.text.trim(), citations });
    else droppedParagraphs.push(paragraphIndex);
  });

  if (paragraphs.length === 0) {
    return {
      answer: insufficientAnswer(),
      status: 'insufficient',
      issues,
      droppedParagraphs,
      rejection: rejectionFor(issues, 'aucun paragraphe étayé'),
    };
  }
  if (final.verdict !== null && droppedParagraphs.includes(0)) {
    return {
      answer: insufficientAnswer(),
      status: 'insufficient',
      issues,
      droppedParagraphs,
      rejection: rejectionFor(issues, 'verdict non étayé'),
    };
  }
  return {
    answer: { insufficient: false, verdict: final.verdict, paragraphs },
    status: 'complete',
    issues,
    droppedParagraphs,
    rejection: null,
  };
}

/** Réponse vérifiée (ou « information insuffisante »). */
export function verifyAnswer(final: FinalAnswer, retrieved: ChunkSource, options: VerifyOptions = {}): VerifiedAnswer {
  return inspectAnswer(final, retrieved, options).answer;
}
