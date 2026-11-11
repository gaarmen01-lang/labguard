/**
 * FakeProvider : fournisseur déterministe, sans réseau.
 *
 * Deux modes :
 *  - « script » : chaque appel consomme l'entrée suivante du script (réponse
 *    fixe, fonction de la requête, ou erreur). Les requêtes reçues sont
 *    conservées dans `requests` pour les assertions.
 *  - « heuristique » (sans script, utilisé quand LLM_PROVIDER=fake) : au premier
 *    tour avec outils, appelle search_analyses + search_documents avec la
 *    question ; ensuite répond « PRÊT » ; pour la sortie structurée, cite mot
 *    pour mot la phrase la plus proche de la question parmi les résultats
 *    d'outils (ou répond `insufficient` si rien n'est trouvé). Permet de faire
 *    tourner l'application de bout en bout sans clé.
 */
import {
  LlmError,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmFinishReason,
  type LlmMessage,
  type LlmProvider,
  type LlmTokenUsage,
  type LlmToolCall,
} from '@/lib/contracts/llm';
import { normalizeTokens } from '@/lib/contracts/text';

import { llmError } from './errors';
import { abortableSleep } from './http';

export interface FakeToolCallSpec {
  id?: string;
  name: string;
  arguments?: unknown;
  /** Arguments bruts (permet de simuler un JSON invalide : arguments undefined). */
  rawArguments?: string;
}

export type FakeStep =
  | {
      content?: string | null;
      toolCalls?: FakeToolCallSpec[];
      finishReason?: LlmFinishReason;
      usage?: Partial<LlmTokenUsage>;
    }
  | { error: Error };

export type FakeScriptEntry = FakeStep | ((request: LlmChatRequest, callIndex: number) => FakeStep | Promise<FakeStep>);

export interface FakeProviderOptions {
  /** Absent -> mode heuristique. */
  script?: FakeScriptEntry[];
  model?: string;
  /** Latence simulée (ms), annulable. */
  delayMs?: number;
}

/** Réponse texte du mode heuristique quand il a fini de chercher. */
export const FAKE_READY_TEXT = 'PRÊT';

const STOPWORDS = new Set([
  'les', 'des', 'une', 'pour', 'est', 'que', 'qui', 'dans', 'sur', 'avec', 'par', 'pas', 'puis', 'faire',
  'peut', 'peux', 'mon', 'mes', 'son', 'ses', 'leur', 'aux', 'ces', 'cette', 'faut', 'quel', 'quelle',
  'analyse', 'resultat', 'risque', 'recu', 'seulement', 'reponds', 'question', 'faux', 'est', 'ont', 'sont',
]);

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function keywords(text: string): Set<string> {
  return new Set(
    normalizeTokens(text)
      .split(' ')
      .filter((token) => token.length >= 3 && !STOPWORDS.has(token)),
  );
}

interface Evidence {
  chunkId: string;
  text: string;
}

function collectEvidence(value: unknown, out: Evidence[]): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEvidence(item, out);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const record = value as Record<string, unknown>;
  if (typeof record.chunk_id === 'string' && typeof record.content === 'string') {
    out.push({ chunkId: record.chunk_id, text: record.content });
  }
  if (typeof record.chunk_id === 'string' && typeof record.quote === 'string') {
    out.push({ chunkId: record.chunk_id, text: record.quote });
  }
  if (typeof record.source_chunk_id === 'string' && typeof record.source_quote === 'string') {
    out.push({ chunkId: record.source_chunk_id, text: record.source_quote });
  }
  for (const nested of Object.values(record)) {
    if (nested && typeof nested === 'object') collectEvidence(nested, out);
  }
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function evidenceFrom(messages: LlmMessage[]): Evidence[] {
  const out: Evidence[] = [];
  for (const message of messages) {
    if (message.role === 'tool') {
      collectEvidence(tryParse(message.content), out);
    } else if (message.role === 'user') {
      for (const match of message.content.matchAll(/```json\s*\n([\s\S]*?)\n```/g)) {
        if (match[1]) collectEvidence(tryParse(match[1]), out);
      }
    }
  }
  return out;
}

function lastUserText(messages: LlmMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (message?.role === 'user') return message.content;
  }
  return '';
}

/** Question extraite d'un message (ligne « Question : … » si présente). */
function questionOf(text: string): string {
  const match = /^Question\s*:\s*(.+)$/im.exec(text);
  return (match?.[1] ?? text).trim();
}

function bestQuote(evidence: Evidence[], question: string): Evidence | undefined {
  const wanted = keywords(question);
  let best: { item: Evidence; score: number } | undefined;
  for (const item of evidence) {
    const sentences = item.text.split(/(?<=[.;!?\n])\s+/).filter((s) => s.trim().length > 0);
    for (const sentence of sentences) {
      const words = sentence.trim().split(/\s+/);
      if (normalizeTokens(sentence).split(' ').filter(Boolean).length < 3) continue;
      const tokens = keywords(sentence);
      let score = 0;
      for (const token of tokens) if (wanted.has(token)) score += 1;
      if (score > 0 && (!best || score > best.score)) {
        best = { item: { chunkId: item.chunkId, text: words.slice(0, 30).join(' ') }, score };
      }
    }
  }
  return best?.item;
}

function heuristicStep(request: LlmChatRequest): FakeStep {
  const messages = request.messages;
  if (request.responseFormat?.type === 'json_schema') {
    const question = questionOf(lastUserText(messages));
    const quote = bestQuote(evidenceFrom(messages), question);
    const answer = quote
      ? {
          insufficient: false,
          verdict: null,
          paragraphs: [
            {
              text: `D'après les documents du laboratoire : « ${quote.text} »`,
              citations: [{ chunk_id: quote.chunkId, quote: quote.text }],
            },
          ],
        }
      : { insufficient: true, verdict: null, paragraphs: [] };
    return { content: JSON.stringify(answer) };
  }

  const lastUserIndex = messages.map((m) => m.role).lastIndexOf('user');
  const searchedSinceQuestion = messages.slice(lastUserIndex + 1).some((m) => m.role === 'tool');
  const toolNames = new Set((request.tools ?? []).map((tool) => tool.name));
  if (!searchedSinceQuestion && toolNames.size > 0 && request.toolChoice !== 'none') {
    const query = questionOf(lastUserText(messages)).slice(0, 300) || 'document';
    const calls: FakeToolCallSpec[] = [];
    if (toolNames.has('search_analyses')) calls.push({ name: 'search_analyses', arguments: { query } });
    if (toolNames.has('search_documents')) calls.push({ name: 'search_documents', arguments: { query } });
    if (calls.length > 0) return { toolCalls: calls };
  }
  return { content: FAKE_READY_TEXT };
}

export class FakeProvider implements LlmProvider {
  readonly name = 'fake' as const;
  readonly model: string;
  readonly requests: LlmChatRequest[] = [];
  private readonly script: FakeScriptEntry[] | undefined;
  private readonly delayMs: number;
  private cursor = 0;

  constructor(options: FakeProviderOptions = {}) {
    this.model = options.model ?? 'fake';
    this.script = options.script ? [...options.script] : undefined;
    this.delayMs = options.delayMs ?? 0;
  }

  get mode(): 'script' | 'heuristic' {
    return this.script ? 'script' : 'heuristic';
  }

  /** Nombre d'entrées de script non consommées. */
  get remaining(): number {
    return this.script ? Math.max(0, this.script.length - this.cursor) : Infinity;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const callIndex = this.requests.length;
    this.requests.push({ ...request, messages: [...request.messages] });
    if (request.signal?.aborted) throw llmError('aborted', 'fake', { cause: request.signal.reason });
    if (this.delayMs > 0) {
      try {
        await abortableSleep(this.delayMs, request.signal);
      } catch (cause) {
        throw llmError('aborted', 'fake', { cause });
      }
    }

    let step: FakeStep;
    if (this.script) {
      const entry = this.script[this.cursor];
      this.cursor += 1;
      if (entry === undefined) {
        throw new LlmError('Script du FakeProvider épuisé.', { code: 'invalid_response', provider: 'fake' });
      }
      step = typeof entry === 'function' ? await entry(request, callIndex) : entry;
    } else {
      step = heuristicStep(request);
    }
    if ('error' in step) throw step.error;

    const toolCalls: LlmToolCall[] = (step.toolCalls ?? []).map((spec, index) => {
      if (spec.rawArguments !== undefined && spec.arguments === undefined) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(spec.rawArguments);
        } catch {
          parsed = undefined;
        }
        return { id: spec.id ?? `fake_${callIndex}_${index}`, name: spec.name, arguments: parsed, rawArguments: spec.rawArguments };
      }
      const args = spec.arguments ?? {};
      return {
        id: spec.id ?? `fake_${callIndex}_${index}`,
        name: spec.name,
        arguments: args,
        rawArguments: spec.rawArguments ?? JSON.stringify(args),
      };
    });
    const content = step.content === undefined ? (toolCalls.length > 0 ? null : '') : step.content;
    const inputText = request.messages.map((m) => ('content' in m && m.content ? m.content : '')).join('\n');
    return {
      message: { role: 'assistant', content, toolCalls },
      finishReason: step.finishReason ?? (toolCalls.length > 0 ? 'tool_calls' : 'stop'),
      usage: {
        inputTokens: step.usage?.inputTokens ?? estimateTokens(inputText),
        outputTokens:
          step.usage?.outputTokens ?? estimateTokens((content ?? '') + toolCalls.map((c) => c.rawArguments ?? '').join('')),
      },
      provider: 'fake',
      model: this.model,
    };
  }
}

/** Raccourci : réponse JSON finale scriptée. */
export function fakeJsonStep(value: unknown): FakeStep {
  return { content: typeof value === 'string' ? value : JSON.stringify(value) };
}
