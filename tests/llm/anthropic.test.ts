import { describe, expect, it } from 'vitest';

import { FINAL_ANSWER_JSON_SCHEMA, type LlmError } from '@/lib/contracts';
import { ANTHROPIC_VERSION, createAnthropicProvider } from '@/lib/llm/anthropic';

import { jsonReply, mockFetch } from './helpers';

const CONFIG = { provider: 'anthropic' as const, model: 'test-model', apiKey: 'sk-ant-test' };

function message(content: unknown[], stopReason = 'end_turn') {
  return {
    id: 'msg_1',
    type: 'message',
    role: 'assistant',
    model: 'test-model-20250101',
    content,
    stop_reason: stopReason,
    stop_sequence: null,
    usage: { input_tokens: 200, output_tokens: 40, cache_read_input_tokens: 10 },
  };
}

const TOOL = { name: 'search_documents', description: 'd', parameters: { type: 'object', properties: { query: { type: 'string' } } } };

describe('Anthropic : requête émise', () => {
  it('URL, en-têtes, system séparé, tool_use / tool_result, fusion des rôles', async () => {
    const { http, requests } = mockFetch([jsonReply(message([{ type: 'text', text: 'PRÊT' }]))]);
    await createAnthropicProvider(CONFIG, http).chat({
      messages: [
        { role: 'system', content: 'règles' },
        { role: 'user', content: 'question' },
        {
          role: 'assistant',
          content: null,
          toolCalls: [
            { id: 'toolu_1', name: 'search_documents', arguments: { query: 'a' } },
            { id: 'toolu_2', name: 'search_documents', arguments: { query: 'b' } },
          ],
        },
        { role: 'tool', toolCallId: 'toolu_1', name: 'search_documents', content: '{"results":[]}' },
        { role: 'tool', toolCallId: 'toolu_2', name: 'search_documents', content: 'échec', isError: true },
      ],
      tools: [TOOL],
      toolChoice: 'required',
    });
    const request = requests[0]!;
    expect(request.url).toBe('https://api.anthropic.com/v1/messages');
    expect(request.headers['x-api-key']).toBe('sk-ant-test');
    expect(request.headers['anthropic-version']).toBe(ANTHROPIC_VERSION);
    expect(request.headers.authorization).toBeUndefined();
    const body = request.body;
    expect(body.system).toBe('règles');
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0);
    expect(body.tool_choice).toEqual({ type: 'any' });
    expect(body.tools).toEqual([{ name: 'search_documents', description: 'd', input_schema: TOOL.parameters }]);
    expect(body.messages).toEqual([
      { role: 'user', content: [{ type: 'text', text: 'question' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'toolu_1', name: 'search_documents', input: { query: 'a' } },
          { type: 'tool_use', id: 'toolu_2', name: 'search_documents', input: { query: 'b' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'toolu_1', content: '{"results":[]}' },
          { type: 'tool_result', tool_use_id: 'toolu_2', content: 'échec', is_error: true },
        ],
      },
    ]);
  });

  it('sortie structurée par outil forcé ; outils de l’historique déclarés en stubs', async () => {
    const answer = { insufficient: true, verdict: null, paragraphs: [] };
    const { http, requests } = mockFetch([
      jsonReply(message([{ type: 'tool_use', id: 'toolu_9', name: 'final_answer', input: answer }], 'tool_use')),
    ]);
    const response = await createAnthropicProvider({ ...CONFIG, baseUrl: 'https://gw.exemple.test/v1' }, http).chat({
      messages: [
        { role: 'assistant', content: 'bonjour' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'call.1', name: 'search_documents', arguments: {} }] },
        { role: 'tool', toolCallId: 'call.1', name: 'search_documents', content: '[]' },
      ],
      responseFormat: { type: 'json_schema', name: 'final_answer', schema: FINAL_ANSWER_JSON_SCHEMA },
    });
    const body = requests[0]!.body;
    expect(requests[0]?.url).toBe('https://gw.exemple.test/v1/messages');
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'final_answer' });
    const tools = body.tools as Array<{ name: string; input_schema: unknown }>;
    expect(tools.map((t) => t.name)).toEqual(['final_answer', 'search_documents']);
    expect(tools[0]?.input_schema).toEqual(FINAL_ANSWER_JSON_SCHEMA);
    const msgs = body.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // Le premier message doit être user ; ids assainis.
    expect(msgs[0]?.role).toBe('user');
    expect(msgs[3]?.content[0]).toMatchObject({ type: 'tool_use', id: 'call_1' });
    expect(msgs[4]?.content[0]).toMatchObject({ type: 'tool_result', tool_use_id: 'call_1' });

    expect(JSON.parse(response.message.content!)).toEqual(answer);
    expect(response.message.toolCalls).toEqual([]);
    expect(response.finishReason).toBe('stop');
    expect(response.usage).toEqual({ inputTokens: 210, outputTokens: 40 });
    expect(response.model).toBe('test-model-20250101');
  });
});

describe('Anthropic : réponse', () => {
  it('parse texte + tool_use', async () => {
    const { http } = mockFetch([
      jsonReply(
        message(
          [
            { type: 'text', text: 'Je cherche.' },
            { type: 'tool_use', id: 'toolu_A', name: 'search_documents', input: { query: 'tube mauve' } },
          ],
          'tool_use',
        ),
      ),
    ]);
    const response = await createAnthropicProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'q' }], tools: [TOOL] });
    expect(response.finishReason).toBe('tool_calls');
    expect(response.message.content).toBe('Je cherche.');
    expect(response.message.toolCalls).toEqual([
      { id: 'toolu_A', name: 'search_documents', arguments: { query: 'tube mauve' }, rawArguments: '{"query":"tube mauve"}' },
    ]);
  });

  it('stop_reason max_tokens -> length, refusal -> content_filter', async () => {
    const { http } = mockFetch([
      jsonReply(message([{ type: 'text', text: 'tronq' }], 'max_tokens')),
      jsonReply(message([], 'refusal')),
    ]);
    const provider = createAnthropicProvider(CONFIG, http);
    expect((await provider.chat({ messages: [{ role: 'user', content: 'q' }] })).finishReason).toBe('length');
    const refused = await provider.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(refused.finishReason).toBe('content_filter');
    expect(refused.message.content).toBeNull();
  });
});

describe('Anthropic : erreurs', () => {
  it('529 overloaded puis succès', async () => {
    const { http, requests } = mockFetch([
      jsonReply({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, 529),
      jsonReply(message([{ type: 'text', text: 'ok' }])),
    ]);
    const response = await createAnthropicProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(response.message.content).toBe('ok');
    expect(requests).toHaveLength(2);
  });

  it('429 puis succès', async () => {
    const { http, requests } = mockFetch([
      jsonReply({ type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, 429, { 'retry-after': '1' }),
      jsonReply(message([{ type: 'text', text: 'ok' }])),
    ]);
    await createAnthropicProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(requests).toHaveLength(2);
  });

  it('401 -> auth (message français, détail fournisseur en cause)', async () => {
    const { http } = mockFetch([
      jsonReply({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }, 401),
    ]);
    const error = (await createAnthropicProvider(CONFIG, http)
      .chat({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('auth');
    expect(error.message).toMatch(/clé API/);
    expect(error.cause).toMatchObject({ status: 401, providerMessage: 'invalid x-api-key', providerType: 'authentication_error' });
  });

  it('timeout et réponse malformée', async () => {
    const hang = mockFetch([{ hang: true }]);
    const timeout = (await createAnthropicProvider({ ...CONFIG, timeoutMs: 20 }, hang.http)
      .chat({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(timeout.code).toBe('timeout');

    const bad = mockFetch([jsonReply({ type: 'message', content: 'pas un tableau' })]);
    const invalid = (await createAnthropicProvider(CONFIG, bad.http)
      .chat({ messages: [{ role: 'user', content: 'q' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(invalid.code).toBe('invalid_response');
  });
});
