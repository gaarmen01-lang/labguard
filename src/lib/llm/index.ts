/**
 * Couche LLM (serveur uniquement). Importer depuis '@/lib/llm'.
 *
 * `getLlmProvider()` lit LLM_PROVIDER / LLM_MODEL / LLM_API_KEY / LLM_BASE_URL /
 * LLM_TIMEOUT_MS (src/lib/env.ts) ; aucun modèle par défaut n'est inventé.
 * Les tests et outils qui n'ont pas d'env utilisent `createLlmProvider(config)`
 * ou directement `FakeProvider` (aussi exporté par '@/lib/llm/fake').
 */
import 'server-only';

import type { LlmProvider } from '@/lib/contracts/llm';
import { getLlmConfig } from '@/lib/env';

import { createLlmProvider } from './factory';
import type { LlmHttpOptions } from './http';

export { createLlmProvider } from './factory';
export { createMistralProvider, MISTRAL_DEFAULT_BASE_URL, toMistralToolCallId } from './mistral';
export { createOpenAiCompatibleProvider } from './openai-compatible';
export { createAnthropicProvider, ANTHROPIC_DEFAULT_BASE_URL, ANTHROPIC_VERSION } from './anthropic';
export { FakeProvider, FAKE_READY_TEXT, fakeJsonStep } from './fake';
export type { FakeProviderOptions, FakeScriptEntry, FakeStep, FakeToolCallSpec } from './fake';
export { LLM_ERROR_MESSAGES, isLlmError } from './errors';
export type { LlmHttpOptions, FetchLike } from './http';
export { extractJsonText } from './json';

/** Fournisseur configuré par l'environnement (lève EnvError si incomplet). */
export function getLlmProvider(http: LlmHttpOptions = {}): LlmProvider {
  return createLlmProvider(getLlmConfig(), http);
}
