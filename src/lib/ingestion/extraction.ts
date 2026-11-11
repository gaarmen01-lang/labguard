/**
 * Construction et contrôle des fiches d'analyses extraites (communs à
 * l'extraction déterministe et à l'extraction LLM).
 */
import {
  extractedAnalysisSchema,
  type AnalysisField,
  type Chunk,
  type ExtractedAnalysis,
  type FieldSource,
} from '@/lib/contracts';

import { isSupportedBy, isVerbatimQuote } from './verify';
import { splitTubeList, type TubeMatcher } from './tubes';

export type ExtractionChunk = Pick<Chunk, 'id' | 'chunk_index' | 'page_number' | 'kind' | 'heading' | 'content' | 'metadata'>;

export const TEXT_FIELDS = ['volume', 'transport', 'storage', 'stability', 'turnaround_time', 'remarks'] as const;
export const LIST_FIELDS = ['synonyms', 'codes', 'accepted_tubes', 'rejected_tubes'] as const;
export type TextField = (typeof TEXT_FIELDS)[number];
export type ListField = (typeof LIST_FIELDS)[number];

/** Champ proposé (par une colonne ou par le LLM) : valeur(s) + citation. */
export interface FieldCandidate {
  value: string | string[] | null;
  quote: string | null;
  /** Mots que la valeur peut ajouter à la citation (unité d'une colonne « Volume (mL) »). */
  allowedExtra?: string;
}

export interface FieldRejection {
  field: AnalysisField;
  reason: 'quote_not_found' | 'value_not_in_quote' | 'missing_quote';
}

export interface BuildResult {
  analysis: ExtractedAnalysis | null;
  rejections: FieldRejection[];
}

const MAX_TEXT = 500;

function clean(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT);
}

/**
 * Assemble une fiche à partir de champs candidats, en vérifiant chaque
 * citation contre le chunk source. Un champ non vérifié est rejeté (jamais
 * inséré) ; sans nom vérifié, toute la fiche est rejetée.
 */
export function buildAnalysis(
  chunk: ExtractionChunk,
  candidates: Partial<Record<AnalysisField, FieldCandidate>>,
  tubes: TubeMatcher,
): BuildResult {
  const rejections: FieldRejection[] = [];
  const verified: Partial<Record<AnalysisField, { values: string[]; quote: string }>> = {};

  for (const [field, candidate] of Object.entries(candidates) as Array<[AnalysisField, FieldCandidate | undefined]>) {
    if (!candidate) continue;
    const rawValues = (Array.isArray(candidate.value) ? candidate.value : candidate.value === null ? [] : [candidate.value])
      .map((value) => (typeof value === 'string' ? clean(value) : ''))
      .filter((value) => value.length > 0);
    if (rawValues.length === 0) continue;
    if (candidate.quote === null || candidate.quote.trim() === '') {
      rejections.push({ field, reason: 'missing_quote' });
      continue;
    }
    if (!isVerbatimQuote(candidate.quote, chunk.content)) {
      rejections.push({ field, reason: 'quote_not_found' });
      continue;
    }
    const quote = clean(candidate.quote);
    const support = candidate.allowedExtra ? `${quote} ${candidate.allowedExtra}` : quote;
    const values = rawValues.filter((value) => isSupportedBy(value, support));
    if (values.length === 0) {
      rejections.push({ field, reason: 'value_not_in_quote' });
      continue;
    }
    if (values.length < rawValues.length) rejections.push({ field, reason: 'value_not_in_quote' });
    verified[field] = { values, quote };
  }

  const name = verified.name;
  if (!name) return { analysis: null, rejections };

  const fieldSources: Partial<Record<AnalysisField, FieldSource>> = {};
  for (const [field, entry] of Object.entries(verified) as Array<[AnalysisField, { quote: string }]>) {
    fieldSources[field] = { chunk_id: chunk.id, quote: entry.quote };
  }
  const list = (field: ListField, transform?: (value: string) => string) => {
    const values = verified[field]?.values ?? [];
    const out = values.flatMap((value) => (field === 'accepted_tubes' || field === 'rejected_tubes' ? splitTubeList(value) : [value]));
    return [...new Set(out.map((value) => (transform ? transform(value) : value)))];
  };
  const text = (field: TextField) => verified[field]?.values.join(' ; ') ?? null;

  const analysis: ExtractedAnalysis = {
    name: name.values[0]!,
    synonyms: list('synonyms'),
    codes: list('codes'),
    accepted_tubes: list('accepted_tubes', (value) => tubes.format(value)),
    rejected_tubes: list('rejected_tubes', (value) => tubes.format(value)),
    volume: text('volume'),
    transport: text('transport'),
    storage: text('storage'),
    stability: text('stability'),
    turnaround_time: text('turnaround_time'),
    remarks: text('remarks'),
    source_chunk_id: chunk.id,
    source_quote: name.quote,
    field_sources: fieldSources,
  };
  // Les listes vides n'ont pas de citation à garder.
  for (const field of LIST_FIELDS) {
    if (analysis[field].length === 0) delete analysis.field_sources[field];
  }
  const parsed = extractedAnalysisSchema.safeParse(analysis);
  if (!parsed.success) return { analysis: null, rejections };
  return { analysis: parsed.data, rejections };
}

/** Clé de déduplication d'une fiche au sein d'un même chunk. */
export function analysisKey(analysis: ExtractedAnalysis): string {
  return `${analysis.source_chunk_id}:${analysis.name.toLowerCase()}`;
}
