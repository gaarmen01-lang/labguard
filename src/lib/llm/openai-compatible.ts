/**
 * Adaptateur générique « OpenAI-compatible » (LLM_BASE_URL obligatoire,
 * ex. https://api.exemple.com/v1 -> POST …/v1/chat/completions).
 *
 * Particularités supposées : `tool_choice: 'required'`, `content: null` sur
 * un message assistant ne portant que des appels d'outils, `name` omis dans
 * les messages `tool` (certains compatibles le refusent).
 */
import type { LlmConfig, LlmProvider } from '@/lib/contracts/llm';

import { ChatCompletionsProvider, type ChatCompletionsDialect } from './chat-completions';
import type { LlmHttpOptions } from './http';

export const OPENAI_COMPATIBLE_DIALECT: ChatCompletionsDialect = {
  provider: 'openai_compatible',
  requiredToolChoice: 'required',
  emptyAssistantContent: null,
  toolMessageName: false,
};

export function createOpenAiCompatibleProvider(config: LlmConfig, http: LlmHttpOptions = {}): LlmProvider {
  return new ChatCompletionsProvider(config, OPENAI_COMPATIBLE_DIALECT, http);
}
