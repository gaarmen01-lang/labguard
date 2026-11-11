import { describe, expect, it } from 'vitest';

import { LlmError } from '@/lib/contracts';
import { createOpenAiCompatibleProvider } from '@/lib/llm/openai-compatible';

import { jsonReply, mockFetch } from './helpers';

const CONFIG = {
  provider: 'openai_compatible' as const,
  model: 'test-model',
  apiKey: 'sk-test',
  baseUrl: 'https://llm.exemple.test/v1',
};

function completion(message: Record<string, unknown>, finish = 'stop') {
  return {
    id: 'chatcmpl-1',
    object: 'chat.completion',
    model: 'test-model',
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  };
}

describe('OpenAI-compatible', () => {
  it('exige une base URL', () => {
    expect(() => createOpenAiCompatibleProvider({ ...CONFIG, baseUrl: undefined })).toThrow(LlmError);
  });

  it('requête : URL, tool_choice required / nommé, content null, tool sans name', async () => {
    const { http, requests } = mockFetch([jsonReply(completion({ content: 'ok' }))]);
    const provider = createOpenAiCompatibleProvider(CONFIG, http);
    await provider.chat({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call_X', name: 'search_documents', arguments: { query: 'a' } }] },
        { role: 'tool', toolCallId: 'call_X', name: 'search_documents', content: '[]' },
      ],
      tools: [{ name: 'search_documents', description: 'd', parameters: { type: 'object' } }],
      toolChoice: 'required',
      maxOutputTokens: 500,
    });
    const body = requests[0]!.body;
    expect(requests[0]?.url).toBe('https://llm.exemple.test/v1/chat/completions');
    expect(body.tool_choice).toBe('required');
    expect(body.max_tokens).toBe(500);
    const msgs = body.messages as Array<Record<string, unknown>>;
    expect(msgs[1]).toMatchObject({ role: 'assistant', content: null, tool_calls: [{ id: 'call_X' }] });
    expect(msgs[2]).toEqual({ role: 'tool', tool_call_id: 'call_X', content: '[]' });

    await provider.chat({
      messages: [{ role: 'user', content: 'q' }],
      tools: [{ name: 'search_documents', description: 'd', parameters: { type: 'object' } }],
      toolChoice: { name: 'search_documents' },
    });
    expect(requests[1]?.body.tool_choice).toEqual({ type: 'function', function: { name: 'search_documents' } });
  });

  it('paramètres refusés : réessaie sans temperature puis avec max_completion_tokens, et le retient', async () => {
    const { http, requests } = mockFetch([
      jsonReply(
        { error: { message: "Unsupported value: 'temperature' does not support 0", type: 'invalid_request_error', param: 'temperature' } },
        400,
      ),
      jsonReply(
        { error: { message: "Unsupported parameter: 'max_tokens'. Use 'max_completion_tokens' instead.", type: 'invalid_request_error' } },
        400,
      ),
      jsonReply(completion({ content: 'ok' })),
      jsonReply(completion({ content: 'ok2' })),
    ]);
    const provider = createOpenAiCompatibleProvider(CONFIG, http);
    const response = await provider.chat({ messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 100 });
    expect(response.message.content).toBe('ok');
    expect(requests).toHaveLength(3);
    expect(requests[1]?.body).not.toHaveProperty('temperature');
    expect(requests[2]?.body).toMatchObject({ max_completion_tokens: 100 });
    expect(requests[2]?.body).not.toHaveProperty('max_tokens');
    await provider.chat({ messages: [{ role: 'user', content: 'q' }], maxOutputTokens: 100 });
    expect(requests[3]?.body).not.toHaveProperty('temperature');
    expect(requests[3]?.body).toMatchObject({ max_completion_tokens: 100 });
  });

  it('format d’erreur OpenAI : 429 puis 200, 403 -> auth', async () => {
    const ok = mockFetch([
      jsonReply({ error: { message: 'Rate limit reached', type: 'rate_limit_exceeded' } }, 429),
      jsonReply(completion({ content: 'ok' })),
    ]);
    expect((await createOpenAiCompatibleProvider(CONFIG, ok.http).chat({ messages: [{ role: 'user', content: 'q' }] })).message.content).toBe('ok');

    const denied = mockFetch([jsonReply({ error: { message: 'forbidden' } }, 403)]);
    const error = (await createOpenAiCompatibleProvider(CONFIG, denied.http)
      .chat({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('auth');
  });

  it('timeout', async () => {
    const { http } = mockFetch([{ hang: true }]);
    const error = (await createOpenAiCompatibleProvider({ ...CONFIG, timeoutMs: 20 }, http)
      .chat({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('timeout');
  });
});
