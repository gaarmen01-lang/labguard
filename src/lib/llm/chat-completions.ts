/**
 * Adaptateur « chat completions » commun à Mistral et aux API compatibles
 * OpenAI. Les différences de format sont isolées dans un `dialect`.
 *
 * Hypothèses de format (non vérifiables hors ligne, à valider au premier
 * appel réel) — voir aussi mistral.ts / openai-compatible.ts :
 *  - POST {base}/chat/completions, `Authorization: Bearer <clé>`.
 *  - Requête : messages {role, content, tool_calls[{id, type:'function',
 *    function{name, arguments(chaîne JSON)}}]}, messages `tool` avec
 *    `tool_call_id` (+ `name`), `tools[{type:'function', function{name,
 *    description, parameters}}]`, `tool_choice`, `response_format
 *    {type:'json_schema', json_schema{name, schema, strict}}`.
 *  - Réponse : choices[0].message{content, tool_calls}, choices[0].finish_reason,
 *    usage{prompt_tokens, completion_tokens}, model.
 *  - `arguments` peut arriver en chaîne JSON ou en objet : les deux sont acceptés.
 *  - Si le fournisseur refuse (400) `temperature`, `max_tokens` ou
 *    `response_format: json_schema`, l'adaptateur réessaie une fois sans le
 *    paramètre fautif (resp. `max_completion_tokens`, `json_object` + schéma
 *    dans le prompt) et retient ce choix pour les appels suivants.
 */
import {
  LlmError,
  type JsonSchema,
  type LlmChatRequest,
  type LlmChatResponse,
  type LlmConfig,
  type LlmFinishReason,
  type LlmMessage,
  type LlmProvider,
  type LlmResponseFormat,
  type LlmToolCall,
  type LlmToolChoice,
} from '@/lib/contracts/llm';

import { llmError, type ProviderErrorDetail } from './errors';
import { postJson, type LlmHttpOptions } from './http';
import { asRecord, contentToText, parseToolArguments, toNonNegativeInt } from './json';

export interface ChatCompletionsDialect {
  provider: 'mistral' | 'openai_compatible';
  defaultBaseUrl?: string;
  /** Valeur envoyée pour `toolChoice: 'required'` (OpenAI : 'required', Mistral : 'any'). */
  requiredToolChoice: string;
  /** Contenu d'un message assistant ne portant que des appels d'outils. */
  emptyAssistantContent: string | null;
  /** Réécrit un identifiant d'appel d'outil au format accepté par le fournisseur. */
  normalizeToolCallId?: (id: string) => string;
  /** Envoie `name` dans les messages `tool`. */
  toolMessageName: boolean;
}

interface AdaptiveState {
  dropTemperature: boolean;
  tokenParam: 'max_tokens' | 'max_completion_tokens';
  jsonObjectFallback: boolean;
}

export function trimTrailingSlash(url: string): string {
  return url.replace(/\/+$/, '');
}

function mapToolChoice(choice: LlmToolChoice, dialect: ChatCompletionsDialect): unknown {
  if (typeof choice === 'object') return { type: 'function', function: { name: choice.name } };
  if (choice === 'required') return dialect.requiredToolChoice;
  return choice;
}

function schemaInstruction(format: Extract<LlmResponseFormat, { type: 'json_schema' }>): string {
  return `Réponds uniquement par un objet JSON valide (sans texte autour) conforme à ce JSON Schema :\n${JSON.stringify(format.schema)}`;
}

function mapMessages(messages: LlmMessage[], dialect: ChatCompletionsDialect): unknown[] {
  const mapId = dialect.normalizeToolCallId ?? ((id: string) => id);
  return messages.map((message) => {
    switch (message.role) {
      case 'system':
      case 'user':
        return { role: message.role, content: message.content };
      case 'assistant': {
        const toolCalls = message.toolCalls ?? [];
        if (toolCalls.length === 0) return { role: 'assistant', content: message.content ?? '' };
        return {
          role: 'assistant',
          content: message.content ?? dialect.emptyAssistantContent,
          tool_calls: toolCalls.map((call) => ({
            id: mapId(call.id),
            type: 'function',
            function: {
              name: call.name,
              arguments: call.rawArguments ?? JSON.stringify(call.arguments ?? {}),
            },
          })),
        };
      }
      case 'tool':
        return {
          role: 'tool',
          tool_call_id: mapId(message.toolCallId),
          ...(dialect.toolMessageName ? { name: message.name } : {}),
          content: message.content,
        };
    }
  });
}

export function buildChatCompletionsBody(
  model: string,
  request: LlmChatRequest,
  dialect: ChatCompletionsDialect,
  state: AdaptiveState = { dropTemperature: false, tokenParam: 'max_tokens', jsonObjectFallback: false },
): Record<string, unknown> {
  let messages = request.messages;
  const format = request.responseFormat;
  if (format?.type === 'json_schema' && state.jsonObjectFallback) {
    messages = [...messages, { role: 'system', content: schemaInstruction(format) }];
  }
  const body: Record<string, unknown> = { model, messages: mapMessages(messages, dialect) };
  if (!state.dropTemperature) body.temperature = request.temperature ?? 0;
  if (request.maxOutputTokens !== undefined) body[state.tokenParam] = request.maxOutputTokens;
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters },
    }));
    body.tool_choice = mapToolChoice(request.toolChoice ?? 'auto', dialect);
  }
  if (format?.type === 'json_schema') {
    body.response_format = state.jsonObjectFallback
      ? { type: 'json_object' }
      : {
          type: 'json_schema',
          json_schema: { name: format.name, schema: format.schema as JsonSchema, strict: format.strict ?? true },
        };
  }
  return body;
}

function mapFinishReason(reason: unknown, hasToolCalls: boolean): LlmFinishReason {
  if (hasToolCalls) return 'tool_calls';
  switch (reason) {
    case 'stop':
    case 'end_turn':
      return 'stop';
    case 'tool_calls':
    case 'function_call':
      // Annoncé mais aucun appel exploitable : traité comme une fin normale.
      return 'stop';
    case 'length':
    case 'model_length':
    case 'max_tokens':
      return 'length';
    case 'content_filter':
      return 'content_filter';
    default:
      return 'other';
  }
}

export function parseChatCompletionsResponse(
  json: unknown,
  provider: ChatCompletionsDialect['provider'],
  fallbackModel: string,
): LlmChatResponse {
  const root = asRecord(json);
  const choices = root?.choices;
  const choice = Array.isArray(choices) ? asRecord(choices[0]) : undefined;
  const message = asRecord(choice?.message);
  if (!root || !choice || !message) {
    throw llmError('invalid_response', provider, { cause: { providerMessage: 'choices[0].message absent' } });
  }

  const rawCalls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  const toolCalls: LlmToolCall[] = rawCalls.map((raw, index) => {
    const call = asRecord(raw);
    const fn = asRecord(call?.function);
    const name = typeof fn?.name === 'string' ? fn.name : undefined;
    if (!name) {
      throw llmError('invalid_response', provider, { cause: { providerMessage: 'tool_call sans nom de fonction' } });
    }
    const id = typeof call?.id === 'string' && call.id.length > 0 ? call.id : `call_${index}`;
    return { id, name, ...parseToolArguments(fn?.arguments) };
  });

  const usage = asRecord(root.usage);
  return {
    message: { role: 'assistant', content: contentToText(message.content), toolCalls },
    finishReason: mapFinishReason(choice.finish_reason, toolCalls.length > 0),
    usage: {
      inputTokens: toNonNegativeInt(usage?.prompt_tokens ?? usage?.input_tokens),
      outputTokens: toNonNegativeInt(usage?.completion_tokens ?? usage?.output_tokens),
    },
    provider,
    model: typeof root.model === 'string' && root.model.length > 0 ? root.model : fallbackModel,
  };
}

/** Paramètre refusé par le fournisseur d'après le message d'une erreur 400. */
function rejectedParameter(error: LlmError): 'temperature' | 'max_tokens' | 'response_format' | undefined {
  if (error.code !== 'bad_request') return undefined;
  const detail = error.cause as ProviderErrorDetail | undefined;
  const text = (detail?.providerMessage ?? '').toLowerCase();
  if (!text) return undefined;
  if (text.includes('temperature')) return 'temperature';
  if (text.includes('max_tokens')) return 'max_tokens';
  if (text.includes('response_format') || text.includes('json_schema')) return 'response_format';
  return undefined;
}

export class ChatCompletionsProvider implements LlmProvider {
  readonly name: ChatCompletionsDialect['provider'];
  readonly model: string;
  private readonly url: string;
  private readonly state: AdaptiveState = {
    dropTemperature: false,
    tokenParam: 'max_tokens',
    jsonObjectFallback: false,
  };

  constructor(
    private readonly config: LlmConfig,
    private readonly dialect: ChatCompletionsDialect,
    private readonly http: LlmHttpOptions = {},
  ) {
    this.name = dialect.provider;
    this.model = config.model;
    const base = config.baseUrl ?? dialect.defaultBaseUrl;
    if (!base) {
      throw new LlmError("Adresse du service d'IA non configurée (LLM_BASE_URL).", {
        code: 'bad_request',
        provider: dialect.provider,
      });
    }
    const trimmed = trimTrailingSlash(base);
    this.url = trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`;
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    for (let adaptation = 0; ; adaptation += 1) {
      const body = buildChatCompletionsBody(this.config.model, request, this.dialect, this.state);
      try {
        const json = await postJson({
          provider: this.name,
          url: this.url,
          headers: { authorization: `Bearer ${this.config.apiKey}` },
          body,
          ...(this.config.timeoutMs !== undefined ? { timeoutMs: this.config.timeoutMs } : {}),
          ...(request.signal ? { signal: request.signal } : {}),
          http: this.http,
        });
        return parseChatCompletionsResponse(json, this.name, this.config.model);
      } catch (error) {
        if (!(error instanceof LlmError) || adaptation >= 3) throw error;
        const param = rejectedParameter(error);
        if (param === 'temperature' && !this.state.dropTemperature && 'temperature' in body) {
          this.state.dropTemperature = true;
        } else if (param === 'max_tokens' && this.state.tokenParam === 'max_tokens' && 'max_tokens' in body) {
          this.state.tokenParam = 'max_completion_tokens';
        } else if (
          param === 'response_format' &&
          !this.state.jsonObjectFallback &&
          request.responseFormat?.type === 'json_schema'
        ) {
          this.state.jsonObjectFallback = true;
        } else {
          throw error;
        }
      }
    }
  }
}
