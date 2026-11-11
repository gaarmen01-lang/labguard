/**
 * Couche LLM agnostique du fournisseur.
 *
 * Implémentations prévues (tâche 3, src/lib/llm/) : Mistral (défaut),
 * Anthropic, OpenAI-compatible, et FakeProvider déterministe pour les tests.
 * Sélection par LLM_PROVIDER / LLM_MODEL / LLM_API_KEY (cf. src/lib/env.ts).
 *
 * Règles pour les adaptateurs :
 *  - Aucun SDK ne doit fuiter hors de l'adaptateur : tout passe par ces types.
 *  - `arguments` d'un appel d'outil est le JSON déjà parsé ; si le fournisseur
 *    renvoie un JSON invalide, l'adaptateur le signale via `rawArguments` et
 *    `arguments: undefined` (la boucle agent décide quoi faire).
 *  - La sortie structurée finale se fait dans un appel SANS outils
 *    (certains fournisseurs ne combinent pas outils et response_format).
 *  - Les erreurs sont levées sous forme de LlmError (code stable).
 */
import { z } from 'zod';

export const LLM_PROVIDERS = ['mistral', 'anthropic', 'openai_compatible', 'fake'] as const;
export const llmProviderNameSchema = z.enum(LLM_PROVIDERS);
export type LlmProviderName = z.infer<typeof llmProviderNameSchema>;

/** Sous-ensemble de JSON Schema (draft 2020-12) accepté par les fournisseurs. */
export type JsonSchema = { readonly [key: string]: unknown };

export interface LlmToolDefinition {
  /** ^[a-zA-Z0-9_-]{1,64}$ (contrainte commune aux fournisseurs). */
  name: string;
  description: string;
  /** JSON Schema d'un objet (`type: 'object'`). */
  parameters: JsonSchema;
}

export interface LlmToolCall {
  /** Identifiant fourni par le fournisseur (ou généré par l'adaptateur). */
  id: string;
  name: string;
  /** Arguments parsés ; undefined si le JSON du fournisseur était invalide. */
  arguments: unknown;
  /** Texte brut des arguments tel que reçu. */
  rawArguments?: string;
}

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; toolCalls?: LlmToolCall[] }
  | {
      role: 'tool';
      toolCallId: string;
      name: string;
      /** Résultat sérialisé (JSON compact de préférence). */
      content: string;
      isError?: boolean;
    };

export type LlmToolChoice = 'auto' | 'none' | 'required' | { name: string };

export type LlmResponseFormat =
  | { type: 'text' }
  | {
      type: 'json_schema';
      /** ^[a-zA-Z0-9_-]{1,64}$ */
      name: string;
      schema: JsonSchema;
      /** Demande le mode strict si le fournisseur le propose. */
      strict?: boolean;
    };

export interface LlmChatRequest {
  messages: LlmMessage[];
  tools?: LlmToolDefinition[];
  toolChoice?: LlmToolChoice;
  responseFormat?: LlmResponseFormat;
  /** 0 par défaut côté adaptateurs (réponses reproductibles). */
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type LlmFinishReason = 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'other';

export interface LlmTokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmChatResponse {
  message: { role: 'assistant'; content: string | null; toolCalls: LlmToolCall[] };
  finishReason: LlmFinishReason;
  usage: LlmTokenUsage;
  provider: LlmProviderName;
  /** Modèle effectivement utilisé tel que rapporté par le fournisseur. */
  model: string;
}

export interface LlmProvider {
  readonly name: LlmProviderName;
  readonly model: string;
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
}

export interface LlmConfig {
  provider: LlmProviderName;
  model: string;
  /** Vide pour le fournisseur `fake`. */
  apiKey: string;
  /** Requis pour `openai_compatible`, optionnel ailleurs (proxy, région). */
  baseUrl?: string;
  /** Délai max d'un appel (ms). */
  timeoutMs?: number;
}

export type LlmProviderFactory = (config: LlmConfig) => LlmProvider;

export const LLM_ERROR_CODES = [
  'auth',
  'rate_limit',
  'timeout',
  'bad_request',
  'unavailable',
  'invalid_response',
  'aborted',
  'unknown',
] as const;
export type LlmErrorCode = (typeof LLM_ERROR_CODES)[number];

export class LlmError extends Error {
  readonly code: LlmErrorCode;
  readonly provider: LlmProviderName;
  readonly retryable: boolean;
  readonly status?: number;

  constructor(
    message: string,
    options: {
      code: LlmErrorCode;
      provider: LlmProviderName;
      retryable?: boolean;
      status?: number;
      cause?: unknown;
    },
  ) {
    super(message, { cause: options.cause });
    this.name = 'LlmError';
    this.code = options.code;
    this.provider = options.provider;
    this.retryable = options.retryable ?? (options.code === 'rate_limit' || options.code === 'unavailable');
    if (options.status !== undefined) this.status = options.status;
  }
}
