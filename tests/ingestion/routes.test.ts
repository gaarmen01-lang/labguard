/**
 * Routes /api/admin/documents/** : refus des non-admins (401/403) sans aucun
 * accès aux données, validation zod des entrées, parcours admin complet sur
 * PGlite (stockage simulé).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { HttpError } from '@/lib/auth/errors';
import {
  createDocumentResponseSchema,
  documentChunksResponseSchema,
  documentDetailResponseSchema,
  documentFileUrlResponseSchema,
  documentListResponseSchema,
  documentStatusResponseSchema,
  ingestResponseSchema,
} from '@/lib/contracts';
import type { PipelineDeps } from '@/lib/ingestion';
import type * as IngestionServer from '@/lib/ingestion/server';

import { createTestDb, type TestDb } from '../helpers/db';
import { corpusFile } from './helpers/ingest';
import { createPgliteRepository, MemoryStorage } from './helpers/pglite-repository';

const auth = vi.hoisted(() => ({
  mode: 'admin' as 'admin' | 'member' | 'anonymous',
  userId: '',
}));
const holder = vi.hoisted(() => ({ deps: null as unknown as PipelineDeps }));

vi.mock('@/lib/auth/session', async () => {
  const { HttpError: Err } = await import('@/lib/auth/errors');
  return {
    requireAdmin: vi.fn(async () => {
      if (auth.mode === 'anonymous') throw new Err('unauthenticated');
      if (auth.mode === 'member') throw new Err('forbidden', 'Accès réservé aux administrateurs.');
      return { userId: auth.userId, email: 'admin@lab.test', isAdmin: true };
    }),
  };
});

vi.mock('@/lib/ingestion/server', async (importOriginal) => ({
  ...(await importOriginal<typeof IngestionServer>()),
  getAdminDeps: () => holder.deps,
  getPipelineDeps: () => holder.deps,
}));

const collection = await import('@/app/api/admin/documents/route');
const item = await import('@/app/api/admin/documents/[id]/route');
const ingestRoute = await import('@/app/api/admin/documents/[id]/ingest/route');
const stepRoute = await import('@/app/api/admin/documents/[id]/ingest/step/route');
const activateRoute = await import('@/app/api/admin/documents/[id]/activate/route');
const archiveRoute = await import('@/app/api/admin/documents/[id]/archive/route');
const fileRoute = await import('@/app/api/admin/documents/[id]/file/route');
const chunksRoute = await import('@/app/api/admin/documents/[id]/chunks/route');

let db: TestDb;
let storage: MemoryStorage;
const calls = new Map<string, number>();
const SOME_ID = '11111111-1111-4111-8111-111111111111';

beforeAll(async () => {
  db = await createTestDb();
  auth.userId = (await db.createUser('admin@lab.test', { role: 'admin' })).id;
  storage = new MemoryStorage();
  holder.deps = { repo: createPgliteRepository(db, { calls }), storage, llm: null };
});

afterAll(async () => {
  await db.close();
});

beforeEach(() => {
  auth.mode = 'admin';
  calls.clear();
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, method = 'POST') =>
  new Request('http://localhost/api/admin/documents', { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } });
const get = (url = 'http://localhost/api/admin/documents') => new Request(url);

const validCreate = {
  code: 'CAT-SPEC',
  title: 'Analyses spécialisées',
  version: '1',
  doc_type: 'test_catalog',
  filename: 'analyses-specialisees.csv',
  mime_type: 'text/csv',
  file_size: corpusFile('analyses-specialisees.csv').byteLength,
};

const ROUTES: Array<[string, () => Promise<Response>]> = [
  ['GET /documents', () => collection.GET(get())],
  ['POST /documents', () => collection.POST(json(validCreate))],
  ['GET /documents/[id]', () => item.GET(get(), ctx(SOME_ID))],
  ['PATCH /documents/[id]', () => item.PATCH(json({ title: 'x' }, 'PATCH'), ctx(SOME_ID))],
  ['DELETE /documents/[id]', () => item.DELETE(get(), ctx(SOME_ID))],
  ['GET /ingest', () => ingestRoute.GET(get(), ctx(SOME_ID))],
  ['POST /ingest', () => ingestRoute.POST(json({}), ctx(SOME_ID))],
  ['POST /ingest/step', () => stepRoute.POST(json({}), ctx(SOME_ID))],
  ['POST /activate', () => activateRoute.POST(json({}), ctx(SOME_ID))],
  ['POST /archive', () => archiveRoute.POST(json({}), ctx(SOME_ID))],
  ['GET /file', () => fileRoute.GET(get(), ctx(SOME_ID))],
  ['GET /chunks', () => chunksRoute.GET(get(), ctx(SOME_ID))],
];

describe('accès refusé aux non-admins', () => {
  it.each(ROUTES)('%s : 403 pour un membre, 401 sans session, aucune donnée lue', async (_name, call) => {
    auth.mode = 'member';
    const forbidden = await call();
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({ error: { code: 'forbidden', message: 'Accès réservé aux administrateurs.' } });
    auth.mode = 'anonymous';
    const anonymous = await call();
    expect(anonymous.status).toBe(401);
    expect((await anonymous.json()).error.code).toBe('unauthenticated');
    expect(calls.size).toBe(0);
  });
});

describe('validation des entrées', () => {
  it('refuse un corps invalide, une extension incohérente, un identifiant non UUID', async () => {
    const invalid = await collection.POST(json({ ...validCreate, file_size: 0, mime_type: 'application/zip' }));
    expect(invalid.status).toBe(400);
    const body = await invalid.json();
    expect(body.error.code).toBe('bad_request');
    expect(body.error.issues.map((issue: { path: string }) => issue.path)).toEqual(expect.arrayContaining(['mime_type', 'file_size']));

    const mismatch = await collection.POST(json({ ...validCreate, filename: 'catalogue.pdf' }));
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json()).error.message).toMatch(/extension/);

    const badId = await item.GET(get(), ctx('pas-un-uuid'));
    expect(badId.status).toBe(400);
    const badQuery = await collection.GET(get('http://localhost/api/admin/documents?status=supprimé'));
    expect(badQuery.status).toBe(400);
    expect(new HttpError('bad_request').status).toBe(400);
  });
});

describe('parcours administrateur', () => {
  it('import -> traitement -> contrôle -> activation -> archivage -> suppression', async () => {
    const created = await collection.POST(json(validCreate));
    expect(created.status).toBe(201);
    const { document, upload } = createDocumentResponseSchema.parse(await created.json());
    expect(document.status).toBe('draft');
    expect(upload.path).toBe(`${document.id}/analyses-specialisees.csv`);

    const duplicate = await collection.POST(json(validCreate));
    expect(duplicate.status).toBe(409);

    // Activation impossible avant ingestion.
    expect((await activateRoute.POST(json({}), ctx(document.id))).status).toBe(409);

    storage.put(upload.path, corpusFile('analyses-specialisees.csv'));
    const started = await ingestRoute.POST(new Request('http://localhost', { method: 'POST' }), ctx(document.id));
    expect(started.status).toBe(202);
    expect(ingestResponseSchema.parse(await started.json()).done).toBe(false);

    let state = ingestResponseSchema.parse(await (await stepRoute.POST(json({}), ctx(document.id))).json());
    while (!state.done) state = ingestResponseSchema.parse(await (await stepRoute.POST(json({}), ctx(document.id))).json());
    expect(state.job.status).toBe('succeeded');
    expect(ingestResponseSchema.parse(await (await ingestRoute.GET(get(), ctx(document.id))).json()).job.id).toBe(state.job.id);

    const detail = documentDetailResponseSchema.parse(await (await item.GET(get(), ctx(document.id))).json());
    expect(detail.analyses.map((analysis) => analysis.name)).toContain('Parathormone (PTH)');
    expect(detail.chunk_count).toBeGreaterThan(0);
    expect(detail.page_count).toBe(1);

    const chunks = documentChunksResponseSchema.parse(
      await (await chunksRoute.GET(get(`http://localhost/x?limit=2`), ctx(document.id))).json(),
    );
    expect(chunks.chunks).toHaveLength(2);
    expect(chunks.total).toBe(detail.chunk_count);

    const file = documentFileUrlResponseSchema.parse(await (await fileRoute.GET(get(), ctx(document.id))).json());
    expect(file.expires_in).toBeLessThanOrEqual(300);

    const patched = await item.PATCH(json({ title: 'Analyses spécialisées (transmises)' }, 'PATCH'), ctx(document.id));
    expect(documentStatusResponseSchema.parse(await patched.json()).document.title).toBe('Analyses spécialisées (transmises)');

    const activated = documentStatusResponseSchema.parse(await (await activateRoute.POST(json({}), ctx(document.id))).json());
    expect(activated.document.status).toBe('active');
    expect((await item.DELETE(get(), ctx(document.id))).status).toBe(409);
    expect((await item.PATCH(json({ title: 'x' }, 'PATCH'), ctx(document.id))).status).toBe(409);

    const archived = documentStatusResponseSchema.parse(await (await archiveRoute.POST(json({}), ctx(document.id))).json());
    expect(archived.document.status).toBe('archived');

    const list = documentListResponseSchema.parse(await (await collection.GET(get('http://localhost/x?status=archived'))).json());
    expect(list.documents.map((entry) => entry.id)).toContain(document.id);

    const deleted = await item.DELETE(get(), ctx(document.id));
    expect(deleted.status).toBe(200);
    expect(storage.removed).toContain(upload.path);
    expect((await item.GET(get(), ctx(document.id))).status).toBe(404);
  });
});
