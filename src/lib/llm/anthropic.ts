/**
 * Adaptateur Anthropic (Messages API).
 *
 * Hypothèses de format (à valider au premier appel réel) :
 *  - POST {base}/v1/messages, en-têtes `x-api-key` et `anthropic-version: 2023-06-01`.
 *  - `system` en chaîne à part ; `messages` alternant user/assistant (les
 *    messages consécutifs de même rôle sont fusionnés, le premier doit être user).
 *  - Appels d'outils : blocs `tool_use {id, name, input(objet)}` ; résultats :
 *    blocs `tool_result {tool_use_id, content, is_error}` dans un message user.
 *  - `tool_choice` : {type:'auto'|'any'|'none'} ou {type:'tool', name}.
 *  - `max_tokens` obligatoire (4096 si non précisé).
 *  - Sortie structurée : pas de response_format ; on force un outil dont
 *    `input_schema` est le schéma demandé, et son `input` devient le contenu
 *    JSON de la réponse.
 *  - Une requête contenant des blocs tool_use doit déclarer des outils : les
 *    outils de l'historique absents de la requête sont déclarés en « stubs ».
 *  - stop_reason : end_turn | stop_sequence | tool_use | max_tokens | refusal | pause_turn.
 *  - usage : input_tokens (+ cache_creation_input_tokens, cache_read_input_tokens), output_tokens.
 */
import type {
  LlmChatRequest,
  LlmChatResponse,
  LlmConfig,
  LlmFinishReason,
  LlmMessage,
  LlmProvider,
  LlmToolCall,
  LlmToolChoice,
} from '@/lib/contracts/llm';

import { trimTrailingSlash } from './chat-completions';
import { llmError } from './errors';
import { postJson, type LlmHttpOptions } from './http';
import { asRecord, toNonNegativeInt } from './json';

export const ANTHROPIC_DEFAULT_BASE_URL = 'https://api.anthropic.com';
export const ANTHROPIC_VERSION = '2023-06-01';
export const ANTHROPIC_DEFAULT_MAX_TOKENS = 4096;

type Block =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: Block[];
}

function sanitizeId(id: string): string {
  const cleaned = id.replace(/[^a-zA-Z0-9_-]/g, '_');
  return cleaned.length > 0 ? cleaned : 'toolu_0';
}

function toolInput(call: LlmToolCall): unknown {
  if (call.arguments !== undefined && call.arguments !== null && typeof call.arguments === 'object') {
    return call.arguments;
  }
  return {};
}

export function mapAnthropicMessages(messages: LlmMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system: string[] = [];
  const out: AnthropicMessage[] = [];
  const push = (role: AnthropicMessage['role'], blocks: Block[]) => {
    if (blocks.length === 0) return;
    const last = out.at(-1);
    if (last && last.role === role) {
      // Les tool_result doivent précéder le texte dans un message user.
      const merged = [...last.content, ...blocks];
      last.content =
        role === 'user'
          ? [...merged.filter((b) => b.type === 'tool_result'), ...merged.filter((b) => b.type !== 'tool_result')]
          : merged;
    } else {
      out.push({ role, content: blocks });
    }
  };

  for (const message of messages) {
    switch (message.role) {
      case 'system':
        if (message.content.trim()) system.push(message.content);
        break;
      case 'user':
        push('user', message.content.trim() ? [{ type: 'text', text: message.content }] : []);
        break;
      case 'assistant': {
        const blocks: Block[] = [];
        if (message.content && message.content.trim()) blocks.push({ type: 'text', text: message.content });
        for (const call of message.toolCalls ?? []) {
          blocks.push({ type: 'tool_use', id: sanitizeId(call.id), name: call.name, input: toolInput(call) });
        }
        push('assistant', blocks);
        break;
      }
      case 'tool':
        push('user', [
          {
            type: 'tool_result',
            tool_use_id: sanitizeId(message.toolCallId),
            content: message.content,
            ...(message.isError ? { is_error: true } : {}),
          },
        ]);
        break;
    }
  }
  if (out[0]?.role === 'assistant') {
    out.unshift({ role: 'user', content: [{ type: 'text', text: '(suite de la conversation)' }] });
  }
  return { system: system.join('\n\n'), messages: out };
}

function mapToolChoice(choice: LlmToolChoice): Record<string, unknown> {
  if (typeof choice === 'object') return { type: 'tool', name: choice.name };
  if (choice === 'required') return { type: 'any' };
  return { type: choice };
}

export function buildAnthropicBody(model: string, request: LlmChatRequest): Record<string, unknown> {
  const { system, messages } = mapAnthropicMessages(request.messages);
  const body: Record<string, unknown> = {
    model,
    max_tokens: request.maxOutputTokens ?? ANTHROPIC_DEFAULT_MAX_TOKENS,
    temperature: request.temperature ?? 0,
    messages,
  };
  if (system) body.system = system;

  const tools: Array<{ name: string; description: string; input_schema: unknown }> = (request.tools ?? []).map(
    (tool) => ({ name: tool.name, description: tool.description, input_schema: tool.parameters }),
  );
  let toolChoice: Record<string, unknown> | undefined =
    tools.length > 0 ? mapToolChoice(request.toolChoice ?? 'auto') : undefined;

  const format = request.responseFormat;
  if (format?.type === 'json_schema') {
    tools.push({
      name: format.name,
      description: 'Renvoie la réponse finale structurée (unique sortie attendue).',
      input_schema: format.schema,
    });
    toolChoice = { type: 'tool', name: format.name };
  }

  // Outils présents dans l'historique mais non déclarés : stubs inoffensifs.
  const declared = new Set(tools.map((tool) => tool.name));
  for (const message of request.messages) {
    if (message.role !== 'assistant') continue;
    for (const call of message.toolCalls ?? []) {
      if (declared.has(call.name)) continue;
      declared.add(call.name);
      tools.push({
        name: call.name,
        description: 'Outil utilisé plus tôt dans la conversation (non disponible maintenant).',
        input_schema: { type: 'object' },
      });
      toolChoice ??= { type: 'none' };
    }
  }

  if (tools.length > 0) {
    body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
  }
  return body;
}

function mapStopReason(reason: unknown): LlmFinishReason {
  switch (reason) {
    case 'end_turn':
    case 'stop_sequence':
      return 'stop';
    case 'tool_use':
      return 'tool_calls';
    case 'max_tokens':
    case 'model_context_window_exceeded':
      return 'length';
    case 'refusal':
      return 'content_filter';
    default:
      return 'other';
  }
}

export function parseAnthropicResponse(json: unknown, request: LlmChatRequest, fallbackModel: string): LlmChatResponse {
  const root = asRecord(json);
  if (!root || !Array.isArray(root.content)) {
    throw llmError('invalid_response', 'anthropic', { cause: { providerMessage: 'content absent' } });
  }
  const format = request.responseFormat?.type === 'json_schema' ? request.responseFormat : undefined;
  const texts: string[] = [];
  const toolCalls: LlmToolCall[] = [];
  let structured: string | undefined;

  root.content.forEach((raw, index) => {
    const block = asRecord(raw);
    if (!block) return;
    if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text);
    if (block.type === 'tool_use') {
      const name = typeof block.name === 'string' ? block.name : undefined;
      if (!name) {
        throw llmError('invalid_response', 'anthropic', { cause: { providerMessage: 'tool_use sans nom' } });
      }
      const input = block.input ?? {};
      if (format && name === format.name) {
        structured = JSON.stringify(input);
        return;
      }
      const id = typeof block.id === 'string' && block.id ? block.id : `toolu_${index}`;
      const inputIsObject = typeof input === 'object' && input !== null;
      toolCalls.push({
        id,
        name,
        arguments: inputIsObject ? input : undefined,
        rawArguments: JSON.stringify(input),
      });
    }
  });

  let finishReason = mapStopReason(root.stop_reason);
  let content: string | null = texts.length > 0 ? texts.join('') : null;
  if (structured !== undefined) {
    content = structured;
    if (finishReason === 'tool_calls') finishReason = 'stop';
  }
  if (toolCalls.length > 0) finishReason = 'tool_calls';

  const usage = asRecord(root.usage);
  return {
    message: { role: 'assistant', content, toolCalls },
    finishReason,
    usage: {
      inputTokens:
        toNonNegativeInt(usage?.input_tokens) +
        toNonNegativeInt(usage?.cache_creation_input_tokens) +
        toNonNegativeInt(usage?.cache_read_input_tokens),
      outputTokens: toNonNegativeInt(usage?.output_tokens),
    },
    provider: 'anthropic',
    model: typeof root.model === 'string' && root.model ? root.model : fallbackModel,
  };
}

export class AnthropicProvider implements LlmProvider {
  readonly name = 'anthropic' as const;
  readonly model: string;
  private readonly url: string;

  constructor(
    private readonly config: LlmConfig,
    private readonly http: LlmHttpOptions = {},
  ) {
    this.model = config.model;
    const base = trimTrailingSlash(config.baseUrl ?? ANTHROPIC_DEFAULT_BASE_URL);
    this.url = base.endsWith('/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const json = await postJson({
      provider: 'anthropic',
      url: this.url,
      headers: { 'x-api-key': this.config.apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      body: buildAnthropicBody(this.config.model, request),
      ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
      ...(request.signal ? { signal: request.signal } : {}),
      http: this.http,
    });
    return parseAnthropicResponse(json, request, this.config.model);
  }
}

export function createAnthropicProvider(config: LlmConfig, http: LlmHttpOptions = {}): LlmProvider {
  return new AnthropicProvider(config, http);
}
