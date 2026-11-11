/**
 * Adaptateur Mistral (API « chat completions »).
 *
 * Particularités supposées (à valider au premier appel réel) :
 *  - Base par défaut https://api.mistral.ai/v1, endpoint /chat/completions.
 *  - `tool_choice` « obligatoire » = 'any' (et non 'required').
 *  - Les identifiants d'appels d'outils doivent faire 9 caractères
 *    alphanumériques : tout autre identifiant est réécrit de façon
 *    déterministe (même entrée -> même sortie, appel et résultat restent liés).
 *  - Message assistant avec tool_calls : `content: ""` plutôt que null.
 *  - `response_format: { type: 'json_schema', json_schema: { name, schema, strict } }`
 *    (repli automatique sur `json_object` si refusé).
 *  - finish_reason peut valoir 'model_length' (traité comme 'length').
 */
import type { LlmConfig, LlmProvider } from '@/lib/contracts/llm';

import { ChatCompletionsProvider, type ChatCompletionsDialect } from './chat-completions';
import type { LlmHttpOptions } from './http';

export const MISTRAL_DEFAULT_BASE_URL = 'https://api.mistral.ai/v1';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** Identifiant d'appel d'outil au format Mistral (^[a-zA-Z0-9]{9}$). */
export function toMistralToolCallId(id: string): string {
  if (/^[a-zA-Z0-9]{9}$/.test(id)) return id;
  // FNV-1a 64 bits (BigInt) -> 9 caractères base 62.
  let hash = 0xcbf29ce484222325n;
  for (const char of id) {
    hash ^= BigInt(char.codePointAt(0) ?? 0);
    hash = (hash * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  let out = '';
  for (let i = 0; i < 9; i += 1) {
    out += ALPHABET[Number(hash % 62n)];
    hash /= 62n;
    if (hash === 0n) hash = 0x9e3779b97f4a7c15n;
  }
  return out;
}

export const MISTRAL_DIALECT: ChatCompletionsDialect = {
  provider: 'mistral',
  defaultBaseUrl: MISTRAL_DEFAULT_BASE_URL,
  requiredToolChoice: 'any',
  emptyAssistantContent: '',
  normalizeToolCallId: toMistralToolCallId,
  toolMessageName: true,
};

export function createMistralProvider(config: LlmConfig, http: LlmHttpOptions = {}): LlmProvider {
  return new ChatCompletionsProvider(config, MISTRAL_DIALECT, http);
}
