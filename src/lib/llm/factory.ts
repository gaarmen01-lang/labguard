/** Fabrique de LlmProvider à partir d'une LlmConfig (sans lecture d'env). */
import type { LlmConfig, LlmProvider } from '@/lib/contracts/llm';

import { createAnthropicProvider } from './anthropic';
import { FakeProvider } from './fake';
import type { LlmHttpOptions } from './http';
import { createMistralProvider } from './mistral';
import { createOpenAiCompatibleProvider } from './openai-compatible';

export function createLlmProvider(config: LlmConfig, http: LlmHttpOptions = {}): LlmProvider {
  switch (config.provider) {
    case 'mistral':
      return createMistralProvider(config, http);
    case 'anthropic':
      return createAnthropicProvider(config, http);
    case 'openai_compatible':
      return createOpenAiCompatibleProvider(config, http);
    case 'fake':
      return new FakeProvider({ model: config.model });
  }
}
