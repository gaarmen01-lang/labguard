/**
 * Extraction LLM des fiches d'analyses (repli quand aucun tableau catalogue
 * n'a permis l'extraction déterministe).
 *
 * Le fournisseur est injecté (interface LlmProvider) : aucun adaptateur ici.
 * Sortie JSON stricte : pour chaque champ, la valeur ET la citation mot pour
 * mot. Côté serveur, toute citation absente du passage source, ou qui ne
 * porte pas la valeur, fait rejeter le champ (jamais inséré) ; sans nom
 * vérifié, la fiche entière est rejetée.
 */
import { z } from 'zod';

import { LlmError, type AnalysisField, type ExtractedAnalysis, type JsonSchema, type LlmProvider } from '@/lib/contracts';

import { buildAnalysis, type ExtractionChunk, type FieldCandidate, type FieldRejection } from './extraction';
import type { TubeMatcher } from './tubes';

const textField = {
  type: 'object',
  additionalProperties: false,
  required: ['value', 'quote'],
  properties: {
    value: { type: ['string', 'null'] },
    quote: { type: ['string', 'null'] },
  },
} as const;

const listField = {
  type: 'object',
  additionalProperties: false,
  required: ['values', 'quote'],
  properties: {
    values: { type: 'array', items: { type: 'string' } },
    quote: { type: ['string', 'null'] },
  },
} as const;

export const ANALYSIS_EXTRACTION_JSON_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['analyses'],
  properties: {
    analyses: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'passage', 'name', 'synonyms', 'codes', 'accepted_tubes', 'rejected_tubes', 'volume', 'transport',
          'storage', 'stability', 'turnaround_time', 'remarks',
        ],
        properties: {
          passage: { type: 'string', description: 'Identifiant du passage source (P1, P2…).' },
          name: textField,
          synonyms: listField,
          codes: listField,
          accepted_tubes: listField,
          rejected_tubes: listField,
          volume: textField,
          transport: textField,
          storage: textField,
          stability: textField,
          turnaround_time: textField,
          remarks: textField,
        },
      },
    },
  },
};

const textFieldSchema = z.object({ value: z.string().nullable(), quote: z.string().nullable() }).nullable().optional();
const listFieldSchema = z
  .object({ values: z.array(z.string()).default([]), quote: z.string().nullable() })
  .nullable()
  .optional();

const llmOutputSchema = z.object({
  analyses: z.array(
    z.object({
      passage: z.string(),
      name: textFieldSchema,
      synonyms: listFieldSchema,
      codes: listFieldSchema,
      accepted_tubes: listFieldSchema,
      rejected_tubes: listFieldSchema,
      volume: textFieldSchema,
      transport: textFieldSchema,
      storage: textFieldSchema,
      stability: textFieldSchema,
      turnaround_time: textFieldSchema,
      remarks: textFieldSchema,
    }),
  ),
});
type LlmOutput = z.infer<typeof llmOutputSchema>;

export const EXTRACTION_SYSTEM_PROMPT = `Tu extrais des fiches d'analyses de biologie médicale à partir de passages de documents d'un laboratoire.

Règles impératives :
- N'utilise QUE le texte des passages fournis. N'invente rien, ne complète rien avec des connaissances générales.
- Une fiche par analyse réellement décrite dans un passage (nom de l'analyse + au moins une information pré-analytique : tube, volume, conservation, transport, stabilité, délai ou remarque). Ignore les simples mentions.
- Pour chaque champ : "value" (ou "values" pour les listes) ET "quote", une citation copiée MOT POUR MOT du passage (même orthographe, mêmes mots, sans reformulation ni ellipse) qui contient la valeur.
- Information absente du passage : value null (ou values []) et quote null. Ne déduis jamais les tubes refusés à partir des tubes acceptés, ni l'inverse.
- accepted_tubes : tubes explicitement acceptés (libellés tels qu'écrits, avec leurs conditions éventuelles). rejected_tubes : tubes explicitement refusés ou non acceptés.
- "passage" : l'identifiant (P1, P2…) du passage d'où vient la fiche ; toutes les citations d'une fiche viennent de ce passage.
- Réponds uniquement avec le JSON demandé.`;

function buildUserPrompt(chunks: Array<{ ref: string; chunk: ExtractionChunk }>): string {
  return chunks
    .map(({ ref, chunk }) => {
      const heading = chunk.heading ? `Section : ${chunk.heading}\n` : '';
      return `### Passage ${ref} (page ${chunk.page_number})\n${heading}"""\n${chunk.content}\n"""`;
    })
    .join('\n\n');
}

/** Extrait le JSON d'une réponse (tolère des balises de code ou du texte autour). */
export function parseJsonContent(content: string | null): unknown {
  if (!content) throw new SyntaxError('réponse vide');
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
  const body = fenced ? fenced[1]! : trimmed;
  try {
    return JSON.parse(body);
  } catch (error) {
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start >= 0 && end > start) return JSON.parse(body.slice(start, end + 1));
    throw error;
  }
}

export interface LlmBatchResult {
  analyses: ExtractedAnalysis[];
  rejections: FieldRejection[];
  rejectedAnalyses: number;
  /** Réponse inutilisable (JSON invalide ou hors schéma) après la relance. */
  invalidResponse: boolean;
  usage: { inputTokens: number; outputTokens: number; calls: number };
}

function toCandidates(item: LlmOutput['analyses'][number]): Partial<Record<AnalysisField, FieldCandidate>> {
  const candidates: Partial<Record<AnalysisField, FieldCandidate>> = {};
  const text = ['name', 'volume', 'transport', 'storage', 'stability', 'turnaround_time', 'remarks'] as const;
  const lists = ['synonyms', 'codes', 'accepted_tubes', 'rejected_tubes'] as const;
  for (const field of text) {
    const entry = item[field];
    if (entry && entry.value !== null) candidates[field] = { value: entry.value, quote: entry.quote };
  }
  for (const field of lists) {
    const entry = item[field];
    if (entry && entry.values.length > 0) candidates[field] = { value: entry.values, quote: entry.quote };
  }
  return candidates;
}

/**
 * Un appel LLM pour un lot de chunks. Une réponse invalide est relancée une
 * fois ; les erreurs du fournisseur (LlmError) sont propagées.
 */
export async function extractWithLlm(
  provider: LlmProvider,
  chunks: ExtractionChunk[],
  tubes: TubeMatcher,
  options: { signal?: AbortSignal; maxOutputTokens?: number } = {},
): Promise<LlmBatchResult> {
  const refs = chunks.map((chunk, index) => ({ ref: `P${index + 1}`, chunk }));
  const messages: Parameters<LlmProvider['chat']>[0]['messages'] = [
    { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
    { role: 'user', content: buildUserPrompt(refs) },
  ];
  const usage = { inputTokens: 0, outputTokens: 0, calls: 0 };
  let output: LlmOutput | null = null;
  for (let attempt = 0; attempt < 2 && output === null; attempt += 1) {
    const response = await provider.chat({
      messages,
      responseFormat: { type: 'json_schema', name: 'analysis_sheets', schema: ANALYSIS_EXTRACTION_JSON_SCHEMA, strict: true },
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens ?? 4000,
      ...(options.signal ? { signal: options.signal } : {}),
    });
    usage.calls += 1;
    usage.inputTokens += response.usage.inputTokens;
    usage.outputTokens += response.usage.outputTokens;
    try {
      output = llmOutputSchema.parse(parseJsonContent(response.message.content));
    } catch {
      messages.push(
        { role: 'assistant', content: response.message.content },
        { role: 'user', content: 'Réponse invalide : renvoie uniquement un objet JSON conforme au schéma demandé.' },
      );
    }
  }
  if (output === null) {
    return { analyses: [], rejections: [], rejectedAnalyses: 0, invalidResponse: true, usage };
  }

  const byRef = new Map(refs.map(({ ref, chunk }) => [ref.toLowerCase(), chunk]));
  const analyses: ExtractedAnalysis[] = [];
  const rejections: FieldRejection[] = [];
  let rejectedAnalyses = 0;
  const seen = new Set<string>();
  for (const item of output.analyses) {
    const chunk = byRef.get(item.passage.trim().replace(/^passage\s+/i, '').toLowerCase());
    if (!chunk) {
      rejectedAnalyses += 1;
      continue;
    }
    const result = buildAnalysis(chunk, toCandidates(item), tubes);
    rejections.push(...result.rejections);
    if (!result.analysis) {
      rejectedAnalyses += 1;
      continue;
    }
    const key = `${chunk.id}:${result.analysis.name.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    analyses.push(result.analysis);
  }
  return { analyses, rejections, rejectedAnalyses, invalidResponse: false, usage };
}

/** Le passage parle-t-il de prélèvement (candidat à l'extraction LLM) ? */
export function looksLikeAnalysisContent(chunk: ExtractionChunk, tubeTerms: string[]): boolean {
  const text = ` ${chunk.content} `.toLowerCase();
  if (/\btubes?\b|\bflacons?\b|\bpr[ée]lev|\bseringue/.test(text)) return true;
  const normalized = ` ${text.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^a-z0-9]+/g, ' ')} `;
  return tubeTerms.some((term) => normalized.includes(` ${term} `));
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}
