/**
 * Boucle agent : recherche outillée (≤ maxTurns tours), rédaction structurée
 * (FinalAnswer, appel sans outils), vérification des citations, une
 * réparation de JSON et une régénération ciblée au plus, puis repli
 * « information insuffisante ».
 *
 * Le texte du modèle n'est jamais renvoyé sans vérification : seule la
 * VerifiedAnswer sort d'ici. Les erreurs du fournisseur (après les nouvelles
 * tentatives de l'adaptateur) sont levées (LlmError) ; une annulation lève
 * AgentError('aborted').
 */
import {
  AGENT_MAX_TURNS,
  AGENT_TOOL_DEFINITIONS,
  CHAT_STEP_LABELS,
  FINAL_ANSWER_JSON_SCHEMA,
  finalAnswerSchema,
  insufficientAnswer,
  LlmError,
  toolArgsSchemas,
  toolNameSchema,
  type AgentToolExecutor,
  type AnswerRejectionReason,
  type ChatEventOf,
  type ChatStep,
  type FinalAnswer,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmMessage,
  type LlmProvider,
  type LlmProviderName,
  type LlmToolCall,
  type LlmUsage,
  type ToolArgs,
  type ToolName,
  type Verdict,
  type VerifiedAnswer,
} from '@/lib/contracts';
import { extractJsonText } from '@/lib/llm/json';

import { AgentError, isAbortError } from './errors';
import {
  DEFAULT_EVIDENCE_LIMITS,
  EvidenceLog,
  RetrievedChunks,
  serializePage,
  serializePassage,
  serializeSheet,
  toolResultContent,
  type EvidenceLimits,
  type RetrievedChunk,
} from './evidence';
import {
  AGENT_SYSTEM_PROMPT,
  citationFixPrompt,
  composePrompt,
  FINAL_ANSWER_FORMAT_NAME,
  repairPrompt,
} from './prompt';
import { inspectAnswer, type VerificationReport } from './verify';

export interface AgentHistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentLimits extends EvidenceLimits {
  /** Tours de recherche outillée (appels LLM avec outils). */
  maxTurns: number;
  /** Appels d'outils exécutés par tour (les suivants sont refusés). */
  maxToolCallsPerTurn: number;
  /** Messages d'historique conservés (les plus récents). */
  historyMessages: number;
  /** Taille max d'un message d'historique (caractères). */
  historyMessageChars: number;
  /** Taille max de la question (caractères). */
  questionChars: number;
  /** Plafond de sortie de l'appel de rédaction (undefined = défaut fournisseur). */
  composeMaxOutputTokens?: number;
}

export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  ...DEFAULT_EVIDENCE_LIMITS,
  maxTurns: AGENT_MAX_TURNS,
  maxToolCallsPerTurn: 6,
  historyMessages: 6,
  historyMessageChars: 1_500,
  questionChars: 2_000,
};

export type AgentStepEvent = ChatEventOf<'step'>;

export interface RunAgentParams {
  question: string;
  history?: readonly AgentHistoryMessage[];
  tools: AgentToolExecutor;
  provider: LlmProvider;
  onEvent?: (event: AgentStepEvent) => void;
  signal?: AbortSignal;
  /** Raccourci de limits.maxTurns. */
  maxTurns?: number;
  limits?: Partial<AgentLimits>;
  /** Mode strict de la vérification (défaut true, cf. verify.ts). */
  strictVerification?: boolean;
}

export interface AgentToolTrace {
  turn: number;
  name: string;
  arguments: unknown;
  ok: boolean;
  resultCount: number;
  error?: string;
}

export interface AgentResult {
  answer: VerifiedAnswer;
  status: 'complete' | 'insufficient';
  verdict: Verdict | null;
  /** Motif quand la réponse a été remplacée par « insuffisant » (journalisation). */
  rejection: { reason: AnswerRejectionReason; detail: string } | null;
  usage: LlmUsage;
  provider: LlmProviderName;
  model: string;
  /** Tours de recherche effectués. */
  turns: number;
  toolCalls: AgentToolTrace[];
  /** Chunks renvoyés par les outils pendant ce tour (extraits pour message_sources). */
  retrieved: RetrievedChunk[];
  latencyMs: number;
}

type ParseResult =
  | { ok: true; value: FinalAnswer }
  | { ok: false; reason: 'invalid_json' | 'schema_violation'; error: string };

export function parseFinalAnswer(content: string | null): ParseResult {
  if (content === null || content.trim() === '') {
    return { ok: false, reason: 'invalid_json', error: 'réponse vide' };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(extractJsonText(content));
  } catch {
    return { ok: false, reason: 'invalid_json', error: "le texte n'est pas un JSON valide" };
  }
  // Une réponse déclarée insuffisante l'est, quel que soit le reste.
  if (raw && typeof raw === 'object' && (raw as { insufficient?: unknown }).insufficient === true) {
    return { ok: true, value: { insufficient: true, verdict: null, paragraphs: [] } };
  }
  const parsed = finalAnswerSchema.safeParse(raw);
  if (!parsed.success) {
    const error = parsed.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join('.') || '(racine)'} : ${issue.message}`)
      .join(' ; ');
    return { ok: false, reason: 'schema_violation', error };
  }
  return { ok: true, value: parsed.data };
}

function stepLabel(name: ToolName, args: unknown, registry: RetrievedChunks): string {
  const record = (args ?? {}) as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query.trim().slice(0, 80) : '';
  switch (name) {
    case 'search_analyses':
      return query ? `Recherche dans les fiches d'analyses : « ${query} »` : CHAT_STEP_LABELS.search_analyses;
    case 'search_documents':
      return query ? `Recherche dans les documents : « ${query} »` : CHAT_STEP_LABELS.search_documents;
    case 'read_page': {
      const page = typeof record.page === 'number' ? record.page : undefined;
      const doc = registry.values().find((chunk) => chunk.document_id === record.document_id);
      if (page === undefined) return CHAT_STEP_LABELS.read_page;
      return doc ? `Lecture de la page ${page} (${doc.document_code})` : `Lecture de la page ${page}`;
    }
  }
}

function normalizeArgs(name: ToolName, args: unknown): unknown {
  // Tolérance : numéro de page transmis en chaîne.
  if (name === 'read_page' && args && typeof args === 'object') {
    const record = args as Record<string, unknown>;
    if (typeof record.page === 'string' && /^\d+$/.test(record.page.trim())) {
      return { ...record, page: Number(record.page.trim()) };
    }
  }
  return args;
}

function prepareHistory(history: readonly AgentHistoryMessage[], limits: AgentLimits): LlmMessage[] {
  const recent = history
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content.trim().length > 0)
    .slice(-limits.historyMessages);
  while (recent[0]?.role === 'assistant') recent.shift();
  return recent.map((m) => ({
    role: m.role,
    content:
      m.content.length > limits.historyMessageChars
        ? `${m.content.slice(0, limits.historyMessageChars)} [… tronqué]`
        : m.content,
  }));
}

export async function runAgent(params: RunAgentParams): Promise<AgentResult> {
  const started = Date.now();
  const { provider, tools, signal } = params;
  const limits: AgentLimits = {
    ...DEFAULT_AGENT_LIMITS,
    ...params.limits,
    ...(params.maxTurns !== undefined ? { maxTurns: params.maxTurns } : {}),
  };
  const maxTurns = Math.max(1, Math.floor(limits.maxTurns));
  const question = params.question.trim().slice(0, limits.questionChars);
  const history = prepareHistory(params.history ?? [], limits);

  const registry = new RetrievedChunks();
  const evidence = new EvidenceLog(limits);
  const traces: AgentToolTrace[] = [];
  const usage = { input_tokens: 0, output_tokens: 0, calls: 0 };
  let model = provider.model;
  let turns = 0;
  let toolFailures = 0;
  let searchesExhausted = false;

  const emit = (step: ChatStep, label: string, turn?: number) => {
    params.onEvent?.({ type: 'step', step, label, ...(turn !== undefined ? { turn } : {}) });
  };
  const ensureNotAborted = () => {
    if (signal?.aborted) throw new AgentError('aborted', { cause: signal.reason });
  };
  const call = async (request: Omit<LlmChatRequest, 'signal'>): Promise<LlmChatResponse> => {
    ensureNotAborted();
    try {
      const response = await provider.chat({
        ...request,
        messages: [...request.messages],
        ...(signal ? { signal } : {}),
      });
      usage.input_tokens += response.usage.inputTokens;
      usage.output_tokens += response.usage.outputTokens;
      usage.calls += 1;
      model = response.model || model;
      return response;
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new AgentError('aborted', { cause: error });
      throw error;
    }
  };
  const finish = (
    report: Pick<VerificationReport, 'answer' | 'status' | 'rejection'>,
  ): AgentResult => ({
    answer: report.answer,
    status: report.status,
    verdict: report.status === 'complete' ? report.answer.verdict : null,
    rejection: report.rejection,
    usage,
    provider: provider.name,
    model,
    turns,
    toolCalls: traces,
    retrieved: registry.values(),
    latencyMs: Date.now() - started,
  });
  const insufficient = (rejection: VerificationReport['rejection']) =>
    finish({ answer: insufficientAnswer(), status: 'insufficient', rejection });

  // --- 1. Recherche outillée ---------------------------------------------------
  const messages: LlmMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: question },
  ];

  const executeToolCall = async (toolCall: LlmToolCall, turn: number, index: number): Promise<LlmMessage> => {
    const reply = (content: string, isError = false): LlmMessage => ({
      role: 'tool',
      toolCallId: toolCall.id,
      name: toolCall.name,
      content,
      ...(isError ? { isError: true } : {}),
    });
    const fail = (error: string, args: unknown = toolCall.arguments): LlmMessage => {
      traces.push({ turn, name: toolCall.name, arguments: args, ok: false, resultCount: 0, error });
      return reply(JSON.stringify({ error }), true);
    };

    if (index >= limits.maxToolCallsPerTurn) {
      return fail(`Trop d'appels d'outils dans ce tour (maximum ${limits.maxToolCallsPerTurn}).`);
    }
    const nameResult = toolNameSchema.safeParse(toolCall.name);
    if (!nameResult.success) {
      return fail(`Outil inconnu « ${toolCall.name} ». Outils disponibles : search_analyses, search_documents, read_page.`);
    }
    const name = nameResult.data;
    if (toolCall.arguments === undefined) return fail('Arguments JSON invalides : renvoie un objet JSON valide.');
    const rawArgs = normalizeArgs(name, toolCall.arguments);
    const parsedArgs = toolArgsSchemas[name].safeParse(rawArgs);
    if (!parsedArgs.success) {
      const detail = parsedArgs.error.issues.map((i) => `${i.path.join('.') || 'arguments'} : ${i.message}`).join(' ; ');
      return fail(`Arguments invalides (${detail}).`, rawArgs);
    }

    emit(name, stepLabel(name, parsedArgs.data, registry), turn);
    try {
      let items: Record<string, unknown>[];
      let count: number;
      if (name === 'search_analyses') {
        const results = await tools.searchAnalyses(parsedArgs.data as ToolArgs['search_analyses']);
        registry.addAnalysisResults(results);
        evidence.addSheets(results);
        items = results.map(serializeSheet);
        count = results.length;
      } else if (name === 'search_documents') {
        const results = await tools.searchDocuments(parsedArgs.data as ToolArgs['search_documents']);
        registry.addChunkResults(results);
        evidence.addPassages(results);
        items = results.map((r) => serializePassage(r, limits));
        count = results.length;
      } else {
        const results = await tools.readPage(parsedArgs.data as ToolArgs['read_page']);
        evidence.addPages(results);
        items = results.map((r) => serializePage(r, limits));
        count = results.length;
      }
      traces.push({ turn, name, arguments: parsedArgs.data, ok: true, resultCount: count });
      return reply(toolResultContent(items, limits.toolResultChars));
    } catch (error) {
      if (signal?.aborted || isAbortError(error)) throw new AgentError('aborted', { cause: error });
      toolFailures += 1;
      return fail('La recherche a échoué (erreur technique). Réessaie une fois ou reformule.', parsedArgs.data);
    }
  };

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    const response = await call({
      messages,
      tools: [...AGENT_TOOL_DEFINITIONS],
      // Premier tour : une recherche est obligatoire avant toute réponse.
      toolChoice: turn === 1 ? 'required' : 'auto',
      temperature: 0,
    });
    const toolCalls = response.message.toolCalls;
    if (toolCalls.length === 0) break;
    turns = turn;
    messages.push({ role: 'assistant', content: response.message.content, toolCalls });
    const replies = await Promise.all(toolCalls.map((tc, index) => executeToolCall(tc, turn, index)));
    ensureNotAborted();
    messages.push(...replies);
    if (turn === maxTurns) searchesExhausted = true;
  }

  if (registry.size === 0) {
    if (toolFailures > 0 && !traces.some((t) => t.ok)) {
      throw new AgentError('tools_unavailable');
    }
    return insufficient(
      searchesExhausted
        ? { reason: 'max_turns_exceeded', detail: `aucun passage citable après ${turns} tours` }
        : null,
    );
  }

  // --- 2. Rédaction structurée (appel sans outils) -----------------------------
  emit('compose', CHAT_STEP_LABELS.compose);
  const composeMessages: LlmMessage[] = [
    { role: 'system', content: AGENT_SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: composePrompt(question, evidence.toJson(), searchesExhausted) },
  ];
  const composeRequest = (msgs: LlmMessage[]): Omit<LlmChatRequest, 'signal'> => ({
    messages: msgs,
    responseFormat: {
      type: 'json_schema',
      name: FINAL_ANSWER_FORMAT_NAME,
      schema: FINAL_ANSWER_JSON_SCHEMA,
      strict: true,
    },
    temperature: 0,
    ...(limits.composeMaxOutputTokens !== undefined ? { maxOutputTokens: limits.composeMaxOutputTokens } : {}),
  });

  let composed = await call(composeRequest(composeMessages));
  let parsed = parseFinalAnswer(composed.message.content);
  if (!parsed.ok) {
    // Une seule tentative de réparation.
    composeMessages.push(
      { role: 'assistant', content: composed.message.content ?? '' },
      { role: 'user', content: repairPrompt(parsed.error) },
    );
    composed = await call(composeRequest(composeMessages));
    const repaired = parseFinalAnswer(composed.message.content);
    if (!repaired.ok) {
      return insufficient({ reason: parsed.reason, detail: `${parsed.error} / après réparation : ${repaired.error}` });
    }
    parsed = repaired;
  }

  // --- 3. Vérification des citations -----------------------------------------
  emit('verify', CHAT_STEP_LABELS.verify);
  await enrichCitedChunks(parsed.value, registry, tools, signal);
  const strict = { strict: params.strictVerification ?? true };
  let report = inspectAnswer(parsed.value, registry, strict);

  if (!parsed.value.insufficient && report.issues.length > 0) {
    // Une régénération ciblée, en indiquant les citations invalides.
    composeMessages.push(
      { role: 'assistant', content: composed.message.content ?? '' },
      { role: 'user', content: citationFixPrompt(report.issues) },
    );
    try {
      const regenerated = await call(composeRequest(composeMessages));
      const reparsed = parseFinalAnswer(regenerated.message.content);
      if (reparsed.ok) {
        await enrichCitedChunks(reparsed.value, registry, tools, signal);
        const second = inspectAnswer(reparsed.value, registry, strict);
        if (second.status === 'complete' || report.status !== 'complete' || reparsed.value.insufficient) {
          report = second;
        }
      }
    } catch (error) {
      if (error instanceof AgentError) throw error;
      // Fournisseur indisponible pendant la régénération : on garde la version élaguée.
      if (!(error instanceof LlmError)) throw error;
    }
  }

  return finish(report);
}

/**
 * Relit (si l'exécuteur le permet) les chunks cités connus seulement par un
 * extrait de fiche, pour vérifier la citation sur le texte intégral et obtenir
 * la page exacte depuis la base. Seuls des chunks déjà renvoyés pendant ce tour
 * sont relus : un identifiant inconnu reste inconnu.
 */
async function enrichCitedChunks(
  answer: FinalAnswer,
  registry: RetrievedChunks,
  tools: AgentToolExecutor,
  signal: AbortSignal | undefined,
): Promise<void> {
  if (!tools.getChunks || answer.insufficient) return;
  const incomplete = new Set(registry.incomplete());
  const wanted = [
    ...new Set(answer.paragraphs.flatMap((p) => p.citations.map((c) => c.chunk_id)).filter((id) => incomplete.has(id))),
  ];
  if (wanted.length === 0) return;
  try {
    const records = await tools.getChunks(wanted);
    if (signal?.aborted) throw new AgentError('aborted', { cause: signal.reason });
    registry.addChunkRecords(records.filter((record) => registry.has(record.chunk_id)));
  } catch (error) {
    if (error instanceof AgentError) throw error;
    // Relecture impossible : la vérification se fait sur les extraits connus.
  }
}
