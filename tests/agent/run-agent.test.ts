import { describe, expect, it } from 'vitest';

import { AgentError, runAgent, toChatError, type AgentStepEvent } from '@/lib/agent';
import { AGENT_SYSTEM_PROMPT } from '@/lib/agent/prompt';
import { chatEventSchema, INSUFFICIENT_ANSWER_TEXT, LlmError, verifiedAnswerSchema, type LlmMessage } from '@/lib/contracts';
import { FakeProvider, type FakeScriptEntry } from '@/lib/llm/fake';

import { CHUNKS, DOC_CAT, finalJson, IDS, inMemoryExecutor } from './fixtures';

const READY = { content: 'PRÊT' };

function setup(script: FakeScriptEntry[], executorOptions: Parameters<typeof inMemoryExecutor>[0] = {}) {
  const provider = new FakeProvider({ script });
  const tools = inMemoryExecutor(executorOptions);
  const events: AgentStepEvent[] = [];
  return { provider, tools, events, onEvent: (e: AgentStepEvent) => events.push(e) };
}

function toolMessages(messages: LlmMessage[]) {
  return messages.filter((m): m is Extract<LlmMessage, { role: 'tool' }> => m.role === 'tool');
}

describe('runAgent : scénarios métier', () => {
  it('fiche trouvée -> verdict conforme, citation enrichie depuis la base', async () => {
    const { provider, tools, events, onEvent } = setup([
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      finalJson('conforme', [
        {
          text: 'Conforme : la fiche HbA1c du catalogue accepte le tube EDTA (bouchon mauve).',
          citations: [{ chunk_id: IDS.hba1c, quote: 'prélever sur tube EDTA (bouchon mauve), 2 mL' }],
        },
      ]),
    ]);
    const result = await runAgent({
      question: "Pour l'HbA1c je n'ai reçu qu'un tube mauve, puis-je faire l'analyse ?",
      tools,
      provider,
      onEvent,
    });

    expect(result.status).toBe('complete');
    expect(result.verdict).toBe('conforme');
    expect(result.rejection).toBeNull();
    expect(verifiedAnswerSchema.parse(result.answer)).toEqual(result.answer);
    expect(result.answer.paragraphs[0]?.citations[0]).toEqual({
      chunk_id: IDS.hba1c,
      quote: 'prélever sur tube EDTA (bouchon mauve), 2 mL',
      ...DOC_CAT,
      page_number: 12,
    });
    expect(result.turns).toBe(1);
    expect(result.usage.calls).toBe(3);
    expect(result.usage.input_tokens).toBeGreaterThan(0);
    expect(result.provider).toBe('fake');

    // 1er appel : outils, recherche obligatoire, prompt système.
    const [first, second, compose] = provider.requests;
    expect(first?.toolChoice).toBe('required');
    expect(first?.tools?.map((t) => t.name)).toEqual(['search_analyses', 'search_documents', 'read_page']);
    expect(first?.messages[0]).toEqual({ role: 'system', content: AGENT_SYSTEM_PROMPT });
    expect(second?.toolChoice).toBe('auto');
    // Rédaction : sans outils, sortie JSON imposée, preuves dans le message.
    expect(compose?.tools).toBeUndefined();
    expect(compose?.responseFormat).toMatchObject({ type: 'json_schema', name: 'final_answer', strict: true });
    const composeUser = compose?.messages.at(-1);
    expect(composeUser?.role).toBe('user');
    expect((composeUser as { content: string }).content).toContain(IDS.hba1c);

    expect(events.map((e) => e.step)).toEqual(['search_analyses', 'compose', 'verify']);
    expect(events[0]).toMatchObject({ label: "Recherche dans les fiches d'analyses : « HbA1c »", turn: 1 });
    for (const event of events) expect(chatEventSchema.safeParse(event).success).toBe(true);
  });

  it('tube explicitement refusé -> non_conforme (appels parallèles)', async () => {
    const { provider, tools, events, onEvent } = setup([
      {
        toolCalls: [
          { name: 'search_analyses', arguments: { query: 'TP INR' } },
          { name: 'search_documents', arguments: { query: 'INR EDTA mauve' } },
        ],
      },
      READY,
      finalJson('non_conforme', [
        {
          text: 'Non conforme : pour le TP/INR, le catalogue refuse les tubes EDTA (mauve) ; seul le citrate 3,2 % est accepté.',
          citations: [
            { chunk_id: IDS.tp, quote: 'Les tubes EDTA (bouchon mauve) sont refusés.' },
            { chunk_id: IDS.tp, quote: 'tube citrate de sodium 3,2 % (bouchon bleu) exclusivement' },
          ],
        },
      ]),
    ]);
    const result = await runAgent({ question: 'TP INR reçu sur tube mauve, OK ?', tools, provider, onEvent });
    expect(result.verdict).toBe('non_conforme');
    expect(result.answer.paragraphs[0]?.citations).toHaveLength(2);
    expect(tools.calls.map((c) => c.tool)).toEqual(['search_analyses', 'search_documents']);
    const replies = toolMessages(provider.requests[1]!.messages);
    expect(replies.map((r) => r.toolCallId)).toEqual(['fake_0_0', 'fake_0_1']);
    expect(events.filter((e) => e.step.startsWith('search')).map((e) => e.turn)).toEqual([1, 1]);
  });

  it('document muet -> a_verifier, avec qui contacter', async () => {
    const { provider, tools } = setup([
      {
        toolCalls: [
          { name: 'search_analyses', arguments: { query: 'ionogramme' } },
          { name: 'search_documents', arguments: { query: 'ionogramme doute' } },
        ],
      },
      READY,
      finalJson('a_verifier', [
        {
          text: "À vérifier : la fiche de l'ionogramme ne mentionne que le tube hépariné (vert) ; le tube mauve n'y est ni accepté ni refusé.",
          citations: [{ chunk_id: IDS.iono, quote: 'Ionogramme sanguin : tube hépariné (bouchon vert).' }],
        },
        {
          text: 'En cas de doute, le manuel demande de contacter le biologiste de garde avant analyse.',
          citations: [{ chunk_id: IDS.doubt, quote: 'contacter le biologiste de garde avant toute analyse' }],
        },
      ]),
    ]);
    const result = await runAgent({ question: 'Ionogramme sur tube mauve ?', tools, provider });
    expect(result.status).toBe('complete');
    expect(result.verdict).toBe('a_verifier');
    expect(result.answer.paragraphs).toHaveLength(2);
    expect(result.answer.paragraphs[1]?.citations[0]).toMatchObject({ document_code: 'MP-002', page_number: 7 });
  });

  it('rien trouvé -> insufficient sans appel de rédaction', async () => {
    const { provider, tools } = setup([
      { toolCalls: [{ name: 'search_documents', arguments: { query: 'météo demain' } }] },
      READY,
    ]);
    const result = await runAgent({ question: 'Quel temps fera-t-il demain ?', tools, provider });
    expect(result.status).toBe('insufficient');
    expect(result.verdict).toBeNull();
    expect(result.answer.paragraphs[0]?.text).toBe(INSUFFICIENT_ANSWER_TEXT);
    expect(result.rejection).toBeNull();
    expect(provider.requests).toHaveLength(2);
    const reply = toolMessages(provider.requests[1]!.messages)[0];
    expect(JSON.parse(reply!.content)).toMatchObject({ results: [], message: expect.stringContaining('Reformule') });
  });

  it('modèle déclarant insufficient -> réponse standard', async () => {
    const { provider, tools } = setup([
      { toolCalls: [{ name: 'search_documents', arguments: { query: 'HbA1c' } }] },
      READY,
      // verdict non nul avec insufficient : toléré, ramené à « insuffisant ».
      { content: '{"insufficient": true, "verdict": "conforme", "paragraphs": []}' },
    ]);
    const result = await runAgent({ question: 'HbA1c chez la femme enceinte : valeurs normales ?', tools, provider });
    expect(result.status).toBe('insufficient');
    expect(result.verdict).toBeNull();
  });

  it('relance de recherche après un premier résultat vide', async () => {
    const { provider, tools, events, onEvent } = setup([
      { toolCalls: [{ name: 'search_documents', arguments: { query: 'xyzzy trucmuche' } }] },
      { toolCalls: [{ name: 'search_documents', arguments: { query: 'HbA1c' } }] },
      READY,
      finalJson('conforme', [
        { text: 'Le tube EDTA mauve est accepté.', citations: [{ chunk_id: IDS.hba1c, quote: 'Tubes acceptés : EDTA uniquement' }] },
      ]),
    ]);
    const result = await runAgent({ question: 'Hémoglobine glyquée sur mauve ?', tools, provider, onEvent });
    expect(result.turns).toBe(2);
    expect(result.status).toBe('complete');
    expect(events.filter((e) => e.step !== 'compose' && e.step !== 'verify').map((e) => e.turn)).toEqual([1, 2]);
    // Le résultat vide invite à reformuler.
    expect(toolMessages(provider.requests[1]!.messages)[0]?.content).toContain('Reformule');
  });

  it('dépassement du nombre de tours : arrêt puis rédaction avec les preuves', async () => {
    const searchForever: FakeScriptEntry = (_req, index) => ({
      toolCalls: [{ name: 'search_documents', arguments: { query: index === 0 ? 'HbA1c' : `reformulation ${index}` } }],
    });
    const { provider, tools } = setup([
      searchForever,
      searchForever,
      searchForever,
      searchForever,
      finalJson('conforme', [
        { text: 'EDTA accepté.', citations: [{ chunk_id: IDS.hba1c, quote: 'prélever sur tube EDTA (bouchon mauve)' }] },
      ]),
    ]);
    const result = await runAgent({ question: 'HbA1c mauve ?', tools, provider });
    expect(result.turns).toBe(4);
    expect(provider.requests).toHaveLength(5);
    expect(provider.requests[4]?.responseFormat?.type).toBe('json_schema');
    expect((provider.requests[4]?.messages.at(-1) as { content: string }).content).toContain('nombre maximal de recherches');
    expect(result.status).toBe('complete');
  });

  it('dépassement du nombre de tours sans preuve : insufficient (max_turns_exceeded), borne configurable', async () => {
    const searchForever: FakeScriptEntry = () => ({ toolCalls: [{ name: 'search_documents', arguments: { query: 'zzz' } }] });
    const { provider, tools } = setup([searchForever, searchForever]);
    const result = await runAgent({ question: 'zzz ?', tools, provider, maxTurns: 2 });
    expect(provider.requests).toHaveLength(2);
    expect(result.status).toBe('insufficient');
    expect(result.rejection?.reason).toBe('max_turns_exceeded');
  });

  it('annulation pendant une recherche -> AgentError aborted', async () => {
    const controller = new AbortController();
    const { provider, tools } = setup(
      [{ toolCalls: [{ name: 'search_documents', arguments: { query: 'HbA1c' } }] }, READY],
      { onCall: () => controller.abort() },
    );
    const error = await runAgent({ question: 'HbA1c ?', tools, provider, signal: controller.signal }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('aborted');
    expect(provider.requests).toHaveLength(1);
  });

  it('annulation avant le début : aucun appel au fournisseur', async () => {
    const controller = new AbortController();
    controller.abort();
    const { provider, tools } = setup([READY]);
    await expect(runAgent({ question: 'x', tools, provider, signal: controller.signal })).rejects.toMatchObject({
      code: 'aborted',
    });
    expect(provider.requests).toHaveLength(0);
  });
});

describe('runAgent : robustesse', () => {
  it('JSON invalide -> une réparation réussie', async () => {
    const { provider, tools } = setup([
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      { content: 'Voici la réponse : conforme.' },
      finalJson('conforme', [
        { text: 'EDTA accepté.', citations: [{ chunk_id: IDS.hba1c, quote: 'prélever sur tube EDTA (bouchon mauve)' }] },
      ]),
    ]);
    const result = await runAgent({ question: 'HbA1c mauve ?', tools, provider });
    expect(result.status).toBe('complete');
    const repairMsg = provider.requests[3]?.messages.at(-1) as { content: string };
    expect(repairMsg.content).toContain('inexploitable');
  });

  it('JSON invalide deux fois -> insufficient (invalid_json)', async () => {
    const { provider, tools } = setup([
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      { content: '{"insufficient": false, "paragraphs": [' },
      { content: 'toujours pas du JSON' },
    ]);
    const result = await runAgent({ question: 'HbA1c mauve ?', tools, provider });
    expect(result.status).toBe('insufficient');
    expect(result.rejection?.reason).toBe('invalid_json');
  });

  it('schéma violé (paragraphe sans citation) puis réparation impossible -> schema_violation', async () => {
    const bad = finalJson('conforme', [{ text: 'Conforme.', citations: [] }]);
    const { provider, tools } = setup([{ toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] }, READY, bad, bad]);
    const result = await runAgent({ question: 'HbA1c mauve ?', tools, provider });
    expect(result.rejection?.reason).toBe('schema_violation');
  });

  it('citation inventée -> régénération ciblée qui corrige', async () => {
    const { provider, tools } = setup([
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      finalJson('conforme', [
        { text: 'Le tube mauve est accepté.', citations: [{ chunk_id: IDS.hba1c, quote: 'le tube mauve est accepté pour HbA1c' }] },
      ]),
      finalJson('conforme', [
        { text: 'Le tube mauve (EDTA) est accepté.', citations: [{ chunk_id: IDS.hba1c, quote: 'prélever sur tube EDTA (bouchon mauve)' }] },
      ]),
    ]);
    const result = await runAgent({ question: 'HbA1c mauve ?', tools, provider });
    expect(result.status).toBe('complete');
    expect(result.answer.paragraphs[0]?.text).toBe('Le tube mauve (EDTA) est accepté.');
    const fix = provider.requests[3]?.messages.at(-1) as { content: string };
    expect(fix.content).toContain('ne figure pas mot pour mot');
    expect(fix.content).toContain(IDS.hba1c);
  });

  it('citation inventée deux fois -> insufficient (quote_not_found)', async () => {
    const invented = finalJson('conforme', [
      { text: 'Accepté.', citations: [{ chunk_id: IDS.hba1c, quote: 'le tube mauve convient parfaitement ici' }] },
    ]);
    const { provider, tools } = setup([
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      invented,
      invented,
    ]);
    const result = await runAgent({ question: 'HbA1c mauve ?', tools, provider });
    expect(result.status).toBe('insufficient');
    expect(result.rejection?.reason).toBe('quote_not_found');
    expect(provider.requests).toHaveLength(4);
  });

  it('fournisseur en panne pendant la régénération : version élaguée conservée si elle tient', async () => {
    const { provider, tools } = setup([
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      finalJson(null, [
        { text: 'EDTA accepté.', citations: [{ chunk_id: IDS.hba1c, quote: 'prélever sur tube EDTA (bouchon mauve)' }] },
        { text: 'Inventé.', citations: [{ chunk_id: IDS.never, quote: 'ceci nexiste pas du tout' }] },
      ]),
      { error: new LlmError('x', { code: 'unavailable', provider: 'fake' }) },
    ]);
    const result = await runAgent({ question: 'HbA1c ?', tools, provider });
    expect(result.status).toBe('complete');
    expect(result.answer.paragraphs).toHaveLength(1);
  });

  it('arguments invalides et outil inconnu -> erreurs renvoyées au modèle, boucle poursuivie', async () => {
    const { provider, tools } = setup([
      {
        toolCalls: [
          { name: 'read_page', rawArguments: '{"document_id": ' },
          { name: 'delete_everything', arguments: {} },
          { name: 'read_page', arguments: { document_id: 'pas-un-uuid', page: 1 } },
          { name: 'read_page', arguments: { document_id: CHUNKS[0]!.document_id, page: '12' } },
        ],
      },
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      finalJson(null, [
        { text: 'EDTA.', citations: [{ chunk_id: IDS.hba1c, quote: 'prélever sur tube EDTA (bouchon mauve)' }] },
      ]),
    ]);
    const result = await runAgent({ question: 'HbA1c ?', tools, provider });
    const replies = toolMessages(provider.requests[1]!.messages);
    expect(replies.slice(0, 3).every((r) => r.isError)).toBe(true);
    expect(replies[1]?.content).toContain('Outil inconnu');
    expect(replies[3]?.isError).toBeUndefined();
    expect(tools.calls[0]).toEqual({ tool: 'read_page', args: { document_id: CHUNKS[0]!.document_id, page: 12 } });
    expect(result.status).toBe('complete');
    expect(result.toolCalls.filter((t) => !t.ok)).toHaveLength(3);
  });

  it('erreur du fournisseur -> LlmError propagée, mappée en erreur SSE', async () => {
    const { provider, tools } = setup([{ error: new LlmError('Service indisponible', { code: 'unavailable', provider: 'fake' }) }]);
    const error = await runAgent({ question: 'x', tools, provider }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LlmError);
    expect(toChatError(error)).toEqual({ code: 'llm_unavailable', message: 'Service indisponible' });
    expect(toChatError(new LlmError('lent', { code: 'rate_limit', provider: 'fake' })).code).toBe('rate_limited');
  });

  it('outils tous en échec -> AgentError tools_unavailable', async () => {
    const { provider, tools } = setup(
      [{ toolCalls: [{ name: 'search_documents', arguments: { query: 'HbA1c' } }] }, READY],
      { failWith: new Error('db down') },
    );
    const error = await runAgent({ question: 'HbA1c ?', tools, provider }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AgentError);
    expect((error as AgentError).code).toBe('tools_unavailable');
    expect(toChatError(error).code).toBe('internal');
  });

  it('résultats d’outils tronqués au budget et historique limité', async () => {
    const big = Array.from({ length: 30 }, (_, i) => ({
      ...CHUNKS[0]!,
      chunk_id: `c1000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      content: `HbA1c passage ${i} ${'x'.repeat(1500)}`,
    }));
    const { provider, tools } = setup(
      [{ toolCalls: [{ name: 'search_documents', arguments: { query: 'HbA1c' } }] }, READY, finalJson(null, [], true)],
      { chunks: big },
    );
    const history = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'assistant' : 'user') as 'user' | 'assistant',
      content: `message ${i} ${'y'.repeat(3000)}`,
    }));
    await runAgent({ question: 'HbA1c ?', history, tools, provider, limits: { toolResultChars: 6000 } });
    const reply = toolMessages(provider.requests[1]!.messages)[0]!;
    expect(reply.content.length).toBeLessThanOrEqual(6000);
    expect(JSON.parse(reply.content)).toMatchObject({ truncated: true });
    const sent = provider.requests[0]!.messages;
    const historyMsgs = sent.slice(1, -1);
    expect(historyMsgs.length).toBeLessThanOrEqual(6);
    expect(historyMsgs[0]?.role).toBe('user');
    expect(historyMsgs.every((m) => (m as { content: string }).content.length < 1600)).toBe(true);
  });

  it('relit via getChunks un chunk connu seulement par une fiche (page exacte depuis la base)', async () => {
    const script: FakeScriptEntry[] = [
      { toolCalls: [{ name: 'search_analyses', arguments: { query: 'HbA1c' } }] },
      READY,
      finalJson(null, [
        {
          text: "La stabilité de l'HbA1c est de 7 jours à +4 °C.",
          citations: [{ chunk_id: IDS.hba1cStability, quote: 'stabilité 7 jours à +4 °C sur sang total' }],
        },
      ]),
    ];
    const withLookup = setup(script, { withGetChunks: true });
    const ok = await runAgent({ question: 'Stabilité HbA1c ?', tools: withLookup.tools, provider: withLookup.provider });
    expect(ok.status).toBe('complete');
    expect(ok.answer.paragraphs[0]?.citations[0]?.page_number).toBe(13);
    expect(withLookup.tools.calls.map((c) => c.tool)).toContain('get_chunks');

    // Sans relecture possible, la page est inconnue : citation refusée (jamais de page inventée).
    const without = setup([...script, script[2]!]);
    const refused = await runAgent({ question: 'Stabilité HbA1c ?', tools: without.tools, provider: without.provider });
    expect(refused.status).toBe('insufficient');
  });
});

describe('runAgent : FakeProvider heuristique de bout en bout', () => {
  it('cherche, cite un extrait réel, passe la vérification', async () => {
    const provider = new FakeProvider();
    const tools = inMemoryExecutor();
    const result = await runAgent({ question: 'HbA1c tube mauve EDTA', tools, provider });
    expect(result.status).toBe('complete');
    const citation = result.answer.paragraphs[0]?.citations[0];
    expect(citation?.document_code).toBe('CAT-001');
    expect(provider.requests).toHaveLength(3);
  });
});
