import { afterEach, describe, expect, it, vi } from 'vitest';

import { AGENT_TOOL_DEFINITIONS, LlmError } from '@/lib/contracts';
import { createLlmProvider, FAKE_READY_TEXT, FakeProvider, getLlmProvider } from '@/lib/llm';

describe('FakeProvider (script)', () => {
  it('rejoue le script, enregistre les requêtes, accepte les fonctions et les erreurs', async () => {
    const provider = new FakeProvider({
      script: [
        { toolCalls: [{ name: 'search_documents', arguments: { query: 'a' } }] },
        (request) => ({ content: `vu ${request.messages.length} messages` }),
        { error: new LlmError('x', { code: 'unavailable', provider: 'fake' }) },
      ],
    });
    const first = await provider.chat({ messages: [{ role: 'user', content: 'q' }] });
    expect(first.finishReason).toBe('tool_calls');
    expect(first.message.toolCalls[0]).toMatchObject({ id: 'fake_0_0', name: 'search_documents', arguments: { query: 'a' } });
    expect((await provider.chat({ messages: [{ role: 'user', content: 'q' }] })).message.content).toBe('vu 1 messages');
    await expect(provider.chat({ messages: [] })).rejects.toMatchObject({ code: 'unavailable' });
    await expect(provider.chat({ messages: [] })).rejects.toMatchObject({ code: 'invalid_response' });
    expect(provider.requests).toHaveLength(4);
    expect(provider.remaining).toBe(0);
  });

  it('simule des arguments JSON invalides', async () => {
    const provider = new FakeProvider({ script: [{ toolCalls: [{ name: 'read_page', rawArguments: '{"page":' }] }] });
    const response = await provider.chat({ messages: [] });
    expect(response.message.toolCalls[0]).toMatchObject({ arguments: undefined, rawArguments: '{"page":' });
  });

  it('respecte le signal d’annulation', async () => {
    const controller = new AbortController();
    controller.abort();
    const provider = new FakeProvider({ script: [{ content: 'x' }] });
    await expect(provider.chat({ messages: [], signal: controller.signal })).rejects.toMatchObject({ code: 'aborted' });
  });
});

describe('FakeProvider (heuristique)', () => {
  it('cherche d’abord, puis PRÊT, puis cite mot pour mot un extrait', async () => {
    const provider = new FakeProvider();
    const tools = [...AGENT_TOOL_DEFINITIONS];
    const question = 'HbA1c : tube mauve accepté ?';
    const first = await provider.chat({ messages: [{ role: 'user', content: question }], tools });
    expect(first.message.toolCalls.map((c) => c.name)).toEqual(['search_analyses', 'search_documents']);
    expect(first.message.toolCalls[0]?.arguments).toEqual({ query: question });

    const chunk = '11111111-1111-4111-8111-111111111111';
    const second = await provider.chat({
      messages: [
        { role: 'user', content: question },
        { role: 'assistant', content: null, toolCalls: first.message.toolCalls },
        {
          role: 'tool',
          toolCallId: 'fake_0_1',
          name: 'search_documents',
          content: JSON.stringify({ results: [{ chunk_id: chunk, content: 'Autre sujet. HbA1c : prélever sur tube EDTA (bouchon mauve), 2 mL.' }] }),
        },
      ],
      tools,
    });
    expect(second.message.content).toBe(FAKE_READY_TEXT);

    const final = await provider.chat({
      messages: [
        {
          role: 'user',
          content: `Question : ${question}\n\`\`\`json\n${JSON.stringify({ passages: [{ chunk_id: chunk, content: 'Autre sujet. HbA1c : prélever sur tube EDTA (bouchon mauve), 2 mL.' }] })}\n\`\`\``,
        },
      ],
      responseFormat: { type: 'json_schema', name: 'final_answer', schema: {} },
    });
    const answer = JSON.parse(final.message.content!) as { insufficient: boolean; paragraphs: Array<{ citations: unknown[] }> };
    expect(answer.insufficient).toBe(false);
    expect(answer.paragraphs[0]?.citations).toEqual([
      { chunk_id: chunk, quote: 'HbA1c : prélever sur tube EDTA (bouchon mauve), 2 mL.' },
    ]);
  });

  it('sans résultat : insufficient', async () => {
    const final = await new FakeProvider().chat({
      messages: [{ role: 'user', content: 'Question : météo ?' }],
      responseFormat: { type: 'json_schema', name: 'final_answer', schema: {} },
    });
    expect(JSON.parse(final.message.content!)).toEqual({ insufficient: true, verdict: null, paragraphs: [] });
  });
});

describe('fabrique', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('crée chaque adaptateur avec le modèle configuré', () => {
    expect(createLlmProvider({ provider: 'mistral', model: 'm', apiKey: 'k' }).name).toBe('mistral');
    expect(createLlmProvider({ provider: 'anthropic', model: 'm', apiKey: 'k' }).name).toBe('anthropic');
    expect(
      createLlmProvider({ provider: 'openai_compatible', model: 'm', apiKey: 'k', baseUrl: 'https://x.test/v1' }).name,
    ).toBe('openai_compatible');
    const fake = createLlmProvider({ provider: 'fake', model: 'm', apiKey: '' });
    expect(fake).toBeInstanceOf(FakeProvider);
    expect(fake.model).toBe('m');
  });

  it('getLlmProvider lit l’environnement et n’invente pas de modèle', () => {
    vi.stubEnv('LLM_PROVIDER', 'fake');
    vi.stubEnv('LLM_MODEL', 'local-fake');
    expect(getLlmProvider().model).toBe('local-fake');
    vi.stubEnv('LLM_MODEL', '');
    expect(() => getLlmProvider()).toThrow(/LLM_MODEL/);
  });
});
