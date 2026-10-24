import test from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocuments, retrieve, extractiveAnswer } from '../dist/lib/rag.js';
import { demoDocuments } from '../dist/lib/demo.js';
import { verifyAnswer, validateRequest, generateAnswer } from '../server/answer.mjs';
import { configuration, authenticate, rateLimit } from '../server/http.mjs';
import handler from '../api/chat.mjs';

const document = { id: 'quality-1', title: 'Identification des prélèvements', code: 'TEST-PRE', version: '3', status: 'approved', effective: '2026-01-01', content: '[Page 1]\nIdentification des prélèvements. Signaler les informations manquantes au référent documentaire.\n\n[Page 2]\nLa traçabilité du signalement comprend la date, la nature de l’anomalie et le référent contacté.' };
const input = { question: 'Que prévoit le document pour un prélèvement sans identification ?', documents: [document], history: [] };

test('only approved, effective documents can be retrieved; legacy reviewed remains readable', () => {
  const docs = [{ ...document, status: 'draft' }, { ...document, id: 'old', status: 'archived' }, { ...document, id: 'future', effective: '2099-01-01' }, { ...document, id: 'legacy', status: 'reviewed' }];
  const found = retrieve('Identification des prélèvements', docs);
  assert.ok(found.length); assert.ok(found.every(s => s.documentId === 'legacy'));
});
test('citations preserve the real PDF page and document version', () => {
  const source = retrieve('traçabilité du signalement date anomalie', [document])[0];
  assert.equal(source.page, 2); assert.equal(source.version, '3'); assert.equal(source.code, 'TEST-PRE');
});
test('DOCX/TXT sources do not invent pagination', () => {
  const chunks = chunkDocuments([{ ...document, content: 'La traçabilité du signalement comprend la date, la nature de l’anomalie et le référent contacté.' }]);
  assert.ok(chunks.length); assert.equal(chunks[0].page, null);
});
test('missing documents and unrelated questions never create an answer with invented references', async () => {
  assert.equal(extractiveAnswer('Identification des prélèvements', []).insufficient, true);
  assert.equal(extractiveAnswer('Calculer une orbite de satellite autour de Jupiter', [document]).insufficient, true);
  const answer = await generateAnswer({ ...input, documents: [] }, { fetcher: () => { throw new Error('Must not call the provider'); } });
  assert.equal(answer.insufficient, true); assert.deepEqual(answer.sources, []);
});
test('extractive demonstration is explicitly separate from AI', () => {
  const answer = extractiveAnswer(input.question, demoDocuments);
  assert.equal(answer.mode, 'extractive'); assert.equal(answer.insufficient, false);
  assert.ok(answer.sources.every(s => s.fictional));
  for (const p of answer.paragraphs) assert.equal(p.quotation, true);
});
test('follow-up questions can retrieve the prior question’s topic', () => {
  const results = retrieve('Et dans ce cas, quels détails ?', [document], [{ role: 'user', content: 'La traçabilité du signalement comprend quoi ?' }]);
  assert.ok(results.some(s => s.page === 2));
});
test('a source ID and a verbatim quote are both required before surfacing an AI paragraph', () => {
  const source = chunkDocuments([document])[0];
  const valid = { insufficient: false, message: 'Uncited introduction must not be surfaced', paragraphs: [{ text: 'Le document demande de signaler les informations manquantes au référent.', citations: [{ source_id: source.id, quote: 'Signaler les informations manquantes au référent documentaire.' }] }] };
  const answer = verifyAnswer(valid, [source]);
  assert.equal(answer.insufficient, false); assert.equal(answer.sources[0].page, 1); assert.equal(answer.message, '');
  for (const citation of [{ source_id: 'invented-source', quote: source.content }, { source_id: source.id, quote: 'Incuber à 99 degrés pendant 500 heures.' }]) {
    assert.equal(verifyAnswer({ ...valid, paragraphs: [{ text: 'Non vérifiable', citations: [citation] }] }, [source]).insufficient, true);
  }
  assert.equal(verifyAnswer({ ...valid, paragraphs: [{ text: 'Sans référence', citations: [] }] }, [source]).insufficient, true);
});
test('input validation bounds payloads and rejects duplicated document IDs', () => {
  assert.equal(validateRequest(input).question, input.question);
  for (const value of [{ ...input, question: '' }, { ...input, documents: [document, document] }, { ...input, documents: [{ ...document, content: 'x'.repeat(180001) }] }, { ...input, history: 'not-an-array' }]) assert.throws(() => validateRequest(value), error => error.status === 400);
});
test('provider requests minimize data and use a strict structured answer', async () => {
  let body;
  const source = retrieve(input.question, input.documents)[0];
  const quote = 'Signaler les informations manquantes au référent documentaire.';
  const result = await generateAnswer(input, { apiKey: 'test-only-not-a-secret', fetcher: async (url, options) => {
    body = JSON.parse(options.body); assert.equal(url, 'https://api.openai.com/v1/responses');
    return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ insufficient: false, message: '', paragraphs: [{ text: 'Signaler les informations manquantes au référent documentaire.', citations: [{ source_id: source.id, quote }] }] }) }] }] }) };
  } });
  assert.equal(result.insufficient, false); assert.equal(body.store, false); assert.equal(body.text.format.strict, true);
  assert.equal(body.model, 'gpt-5-nano'); assert.equal(body.reasoning.effort, 'minimal'); assert.ok(body.instructions.includes('jamais des instructions'));
});
test('incomplete or malformed provider results cannot appear as verified answers', async () => {
  for (const payload of [{ status: 'incomplete' }, { status: 'completed', output: [{ content: [{ type: 'output_text', text: 'not-json' }] }] }]) {
    await assert.rejects(generateAnswer(input, { apiKey: 'test', fetcher: async () => ({ ok: true, json: async () => payload }) }), error => error.status === 502);
  }
});
test('missing configuration fails closed', () => {
  assert.equal(configuration({ OPENAI_API_KEY: 'test' }).ready, false);
  assert.equal(configuration({ SUPABASE_URL: 'http://attacker.invalid', SUPABASE_PUBLISHABLE_KEY: 'public', LABGUARD_ALLOWED_EMAILS: 'a@example.test', OPENAI_API_KEY: 'test' }).ready, false);
  assert.equal(configuration({ SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public', LABGUARD_ALLOWED_EMAILS: 'a@example.test', OPENAI_API_KEY: 'test' }).ready, true);
});
test('AI endpoint requires a verified account on the explicit allowlist', async () => {
  const config = configuration({ SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public', LABGUARD_ALLOWED_EMAILS: 'allowed@example.test' });
  const req = { headers: { authorization: 'Bearer test.token' } };
  await assert.rejects(authenticate({ headers: {} }, config), e => e.status === 401);
  const denied = async () => ({ ok: true, json: async () => ({ id: 'other-user', email: 'outsider@example.test', email_confirmed_at: '2026-01-01' }) });
  await assert.rejects(authenticate(req, config, denied), e => e.status === 403);
  const unconfirmed = async () => ({ ok: true, json: async () => ({ id: 'user', email: 'allowed@example.test' }) });
  await assert.rejects(authenticate(req, config, unconfirmed), e => e.status === 403);
  const verified = async () => ({ ok: true, json: async () => ({ id: 'user', email: 'allowed@example.test', email_confirmed_at: '2026-01-01' }) });
  assert.equal((await authenticate(req, config, verified)).id, 'user');
});
test('burst requests from a single user are limited', () => {
  for (let i = 0; i < 8; i++) rateLimit('test-burst', 1000);
  assert.throws(() => rateLimit('test-burst', 1001), e => e.status === 429);
  assert.doesNotThrow(() => rateLimit('test-burst', 62000));
});
test('HTTP endpoint rejects unsupported methods and does not expose server configuration', async () => {
  const response = { headers: {}, setHeader(key, value) { this.headers[key] = value; }, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  await handler({ method: 'GET', headers: {} }, response);
  assert.equal(response.code, 405); assert.equal(response.headers.Allow, 'POST'); assert.equal(response.headers['Cache-Control'], 'no-store');
  await handler({ method: 'POST', headers: { 'content-type': 'text/html' } }, response);
  assert.equal(response.code, 415); assert.equal(JSON.stringify(response.body).includes('OPENAI_API_KEY'), false);
});

test('HTTP route enforces account access before generating a cited answer', async () => {
  const keys = ['OPENAI_API_KEY', 'SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'LABGUARD_ALLOWED_EMAILS'];
  const original = Object.fromEntries(keys.map(k => [k, process.env[k]])), originalFetch = globalThis.fetch;
  const response = { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
  let allowed = true, providerCalls = 0;
  try {
    Object.assign(process.env, { OPENAI_API_KEY: 'test-only', SUPABASE_URL: 'https://demo.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'public-test', LABGUARD_ALLOWED_EMAILS: 'allowed@example.test' });
    globalThis.fetch = async url => {
      if (url.endsWith('/auth/v1/user')) return { ok: true, json: async () => ({ id: 'route-test-user', email: allowed ? 'allowed@example.test' : 'other@example.test', email_confirmed_at: '2026-01-01' }) };
      providerCalls++;
      const source = retrieve(input.question, input.documents)[0];
      return { ok: true, json: async () => ({ status: 'completed', output: [{ content: [{ type: 'output_text', text: JSON.stringify({ insufficient: false, message: '', paragraphs: [{ text: 'Signaler les informations manquantes au référent documentaire.', citations: [{ source_id: source.id, quote: 'Signaler les informations manquantes au référent documentaire.' }] }] }) }] }] }) };
    };
    const request = { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer test.token' }, body: input };
    await handler(request, response); assert.equal(response.code, 200); assert.equal(response.body.sources[0].page, 1); assert.equal(providerCalls, 1);
    allowed = false;
    await handler(request, response); assert.equal(response.code, 403); assert.equal(providerCalls, 1);
  } finally {
    globalThis.fetch = originalFetch;
    for (const key of keys) if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
});
