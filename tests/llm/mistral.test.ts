import { describe, expect, it } from 'vitest';

import { FINAL_ANSWER_JSON_SCHEMA, LlmError, type LlmMessage } from '@/lib/contracts';
import { createMistralProvider, toMistralToolCallId } from '@/lib/llm/mistral';

import { jsonReply, mockFetch } from './helpers';

const CONFIG = { provider: 'mistral' as const, model: 'test-model', apiKey: 'sk-test-secret' };

const TOOLS = [
  {
    name: 'search_analyses',
    description: 'Cherche une fiche.',
    parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
];

function completion(message: Record<string, unknown>, finish = 'stop', usage = { prompt_tokens: 120, completion_tokens: 30 }) {
  return {
    id: 'cmpl-1',
    object: 'chat.completion',
    model: 'test-model-2401',
    created: 1,
    choices: [{ index: 0, message: { role: 'assistant', ...message }, finish_reason: finish }],
    usage: { ...usage, total_tokens: usage.prompt_tokens + usage.completion_tokens },
  };
}

describe('Mistral : requête émise', () => {
  it('URL, en-têtes, outils, tool_choice « any », ids d’appels réécrits', async () => {
    const { http, requests } = mockFetch([jsonReply(completion({ content: 'PRÊT' }))]);
    const provider = createMistralProvider(CONFIG, http);
    const messages: LlmMessage[] = [
      { role: 'system', content: 'règles' },
      { role: 'user', content: 'HbA1c tube mauve ?' },
      {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'fake_0_0', name: 'search_analyses', arguments: { query: 'HbA1c' } }],
      },
      { role: 'tool', toolCallId: 'fake_0_0', name: 'search_analyses', content: '{"results":[]}' },
    ];
    await provider.chat({ messages, tools: TOOLS, toolChoice: 'required' });

    const [request] = requests;
    expect(request?.url).toBe('https://api.mistral.ai/v1/chat/completions');
    expect(request?.headers.authorization).toBe('Bearer sk-test-secret');
    expect(request?.headers['content-type']).toBe('application/json');
    const body = request!.body;
    expect(body.model).toBe('test-model');
    expect(body.temperature).toBe(0);
    expect(body.tool_choice).toBe('any');
    expect(body.tools).toEqual([{ type: 'function', function: TOOLS[0] }]);
    const sent = body.messages as Array<Record<string, unknown>>;
    const mappedId = toMistralToolCallId('fake_0_0');
    expect(mappedId).toMatch(/^[a-zA-Z0-9]{9}$/);
    expect(sent[2]).toEqual({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: mappedId, type: 'function', function: { name: 'search_analyses', arguments: '{"query":"HbA1c"}' } }],
    });
    expect(sent[3]).toEqual({ role: 'tool', tool_call_id: mappedId, name: 'search_analyses', content: '{"results":[]}' });
    expect(body.response_format).toBeUndefined();
  });

  it('garde un id déjà au format Mistral et utilise LLM_BASE_URL si fourni', async () => {
    expect(toMistralToolCallId('D681PevKs')).toBe('D681PevKs');
    expect(toMistralToolCallId('call_abc')).toBe(toMistralToolCallId('call_abc'));
    const { http, requests } = mockFetch([jsonReply(completion({ content: 'ok' }))]);
    await createMistralProvider({ ...CONFIG, baseUrl: 'https://proxy.exemple.test/v1/' }, http).chat({
      messages: [{ role: 'user', content: 'x' }],
    });
    expect(requests[0]?.url).toBe('https://proxy.exemple.test/v1/chat/completions');
  });

  it('sortie JSON : response_format json_schema strict', async () => {
    const answer = { insufficient: true, verdict: null, paragraphs: [] };
    const { http, requests } = mockFetch([jsonReply(completion({ content: JSON.stringify(answer) }))]);
    const response = await createMistralProvider(CONFIG, http).chat({
      messages: [{ role: 'user', content: 'x' }],
      responseFormat: { type: 'json_schema', name: 'final_answer', schema: FINAL_ANSWER_JSON_SCHEMA, strict: true },
    });
    expect(requests[0]?.body.response_format).toEqual({
      type: 'json_schema',
      json_schema: { name: 'final_answer', schema: FINAL_ANSWER_JSON_SCHEMA, strict: true },
    });
    expect(JSON.parse(response.message.content!)).toEqual(answer);
    expect(response.finishReason).toBe('stop');
  });

  it('repli json_object si json_schema est refusé (400), mémorisé', async () => {
    const { http, requests } = mockFetch([
      jsonReply({ object: 'error', message: 'Invalid response_format: json_schema not supported', type: 'invalid_request_error' }, 400),
      jsonReply(completion({ content: '{"insufficient":true,"verdict":null,"paragraphs":[]}' })),
      jsonReply(completion({ content: '{}' })),
    ]);
    const provider = createMistralProvider(CONFIG, http);
    const request = {
      messages: [{ role: 'user' as const, content: 'x' }],
      responseFormat: { type: 'json_schema' as const, name: 'final_answer', schema: { type: 'object' } },
    };
    await provider.chat(request);
    expect(requests[1]?.body.response_format).toEqual({ type: 'json_object' });
    const msgs = requests[1]?.body.messages as Array<{ role: string; content: string }>;
    expect(msgs.at(-1)?.content).toContain('JSON Schema');
    await provider.chat(request);
    expect(requests[2]?.body.response_format).toEqual({ type: 'json_object' });
  });
});

describe('Mistral : réponse', () => {
  it('parse un appel d’outil (arguments chaîne JSON) et l’usage', async () => {
    const { http } = mockFetch([
      jsonReply(
        completion(
          {
            content: '',
            tool_calls: [{ id: 'D681PevKs', type: 'function', function: { name: 'search_analyses', arguments: '{"query": "HbA1c"}' } }],
          },
          'tool_calls',
        ),
      ),
    ]);
    const response = await createMistralProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'x' }], tools: TOOLS });
    expect(response.finishReason).toBe('tool_calls');
    expect(response.message.toolCalls).toEqual([
      { id: 'D681PevKs', name: 'search_analyses', arguments: { query: 'HbA1c' }, rawArguments: '{"query": "HbA1c"}' },
    ]);
    expect(response.usage).toEqual({ inputTokens: 120, outputTokens: 30 });
    expect(response.provider).toBe('mistral');
    expect(response.model).toBe('test-model-2401');
  });

  it('accepte des arguments objet et signale un JSON invalide', async () => {
    const { http } = mockFetch([
      jsonReply(
        completion(
          {
            content: null,
            tool_calls: [
              { id: 'a', function: { name: 'search_analyses', arguments: { query: 'TP' } } },
              { function: { name: 'search_analyses', arguments: '{"query": ' } },
            ],
          },
          // Certains fournisseurs renvoient « stop » avec des tool_calls.
          'stop',
        ),
      ),
    ]);
    const response = await createMistralProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(response.finishReason).toBe('tool_calls');
    expect(response.message.toolCalls[0]?.arguments).toEqual({ query: 'TP' });
    expect(response.message.toolCalls[1]).toMatchObject({ id: 'call_1', arguments: undefined, rawArguments: '{"query": ' });
  });

  it('finish_reason model_length -> length ; contenu en parties texte', async () => {
    const { http } = mockFetch([
      jsonReply(completion({ content: [{ type: 'text', text: 'abc' }, { type: 'text', text: 'def' }] }, 'model_length')),
    ]);
    const response = await createMistralProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(response.finishReason).toBe('length');
    expect(response.message.content).toBe('abcdef');
  });
});

describe('Mistral : erreurs et nouvelles tentatives', () => {
  it('429 puis succès : nouvelle tentative après Retry-After', async () => {
    const { http, requests, sleeps } = mockFetch([
      jsonReply({ message: 'Requests rate limit exceeded' }, 429, { 'retry-after': '2' }),
      jsonReply(completion({ content: 'ok' })),
    ]);
    const response = await createMistralProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(response.message.content).toBe('ok');
    expect(requests).toHaveLength(2);
    expect(sleeps).toHaveLength(1);
    expect(sleeps[0]).toBeGreaterThanOrEqual(2000);
  });

  it('5xx répétés : abandon après les nouvelles tentatives bornées', async () => {
    const { http, requests } = mockFetch([jsonReply({ message: 'boom' }, 503)]);
    const error = await createMistralProvider(CONFIG, { ...http, maxRetries: 2 })
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect((error as LlmError).code).toBe('unavailable');
    expect((error as LlmError).retryable).toBe(true);
    expect(requests).toHaveLength(3);
  });

  it('erreur réseau puis succès', async () => {
    const { http, requests } = mockFetch([{ networkError: true }, jsonReply(completion({ content: 'ok' }))]);
    const response = await createMistralProvider(CONFIG, http).chat({ messages: [{ role: 'user', content: 'x' }] });
    expect(response.message.content).toBe('ok');
    expect(requests).toHaveLength(2);
  });

  it('401 : erreur d’authentification, sans nouvelle tentative ni fuite de clé', async () => {
    const { http, requests } = mockFetch([jsonReply({ message: 'Unauthorized', request_id: 'x' }, 401)]);
    const error = (await createMistralProvider(CONFIG, http)
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('auth');
    expect(error.status).toBe(401);
    expect(error.provider).toBe('mistral');
    expect(error.message).toMatch(/authentification/);
    expect(error.message).not.toContain('sk-test-secret');
    expect(JSON.stringify(error.cause)).not.toContain('sk-test-secret');
    expect(requests).toHaveLength(1);
  });

  it('délai dépassé -> timeout', async () => {
    const { http } = mockFetch([{ hang: true }]);
    const error = (await createMistralProvider({ ...CONFIG, timeoutMs: 30 }, http)
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.code).toBe('timeout');
  });

  it('annulation par signal -> aborted', async () => {
    const { http } = mockFetch([{ hang: true }]);
    const controller = new AbortController();
    const promise = createMistralProvider(CONFIG, http).chat({
      messages: [{ role: 'user', content: 'x' }],
      signal: controller.signal,
    });
    controller.abort();
    const error = (await promise.catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('aborted');
  });

  it('réponse malformée -> invalid_response', async () => {
    const empty = mockFetch([jsonReply({ id: 'x', choices: [] })]);
    const e1 = (await createMistralProvider(CONFIG, empty.http)
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(e1.code).toBe('invalid_response');

    const notJson = mockFetch([{ status: 200, text: '<html>proxy</html>' }]);
    const e2 = (await createMistralProvider(CONFIG, notJson.http)
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(e2.code).toBe('invalid_response');

    const noName = mockFetch([jsonReply(completion({ tool_calls: [{ id: 'a', function: { arguments: '{}' } }] }))]);
    const e3 = (await createMistralProvider(CONFIG, noName.http)
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(e3.code).toBe('invalid_response');
  });

  it('400 non lié à un paramètre : bad_request immédiat', async () => {
    const { http, requests } = mockFetch([jsonReply({ message: 'Invalid model: nope' }, 400)]);
    const error = (await createMistralProvider(CONFIG, http)
      .chat({ messages: [{ role: 'user', content: 'x' }] })
      .catch((e: unknown) => e)) as LlmError;
    expect(error.code).toBe('bad_request');
    expect(error.retryable).toBe(false);
    expect(requests).toHaveLength(1);
  });
});
