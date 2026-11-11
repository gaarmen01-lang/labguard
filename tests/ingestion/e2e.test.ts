/**
 * Bout en bout : ingestion du corpus FICTIF complet dans PGlite (sans LLM,
 * extraction déterministe seulement), activation, puis interrogation via les
 * RPC search_chunks / search_analyses avec un compte membre (RLS appliquée).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { AnalysisSearchResult, ChunkSearchResult } from '@/lib/contracts';

import { createTestDb, type TestDb } from '../helpers/db';
import { createHarness, ingest, type Harness } from './helpers/ingest';

let db: TestDb;
let harness: Harness;
let memberId: string;
const ids: Record<string, string> = {};

beforeAll(async () => {
  db = await createTestDb();
  harness = await createHarness(db, null);
  memberId = (await db.createUser('membre@lab.test', { role: 'member' })).id;
  const documents = [
    { key: 'manualV2', code: 'MP-PRE-001', title: 'Manuel de prélèvement', version: '2', docType: 'sampling_manual', filename: 'manuel-prelevement-v2.pdf' },
    { key: 'manualV3', code: 'MP-PRE-001', title: 'Manuel de prélèvement', version: '3', docType: 'sampling_manual', filename: 'manuel-prelevement-v3.pdf' },
    { key: 'catalog', code: 'CAT-ANA', title: 'Catalogue des analyses', version: '2026-03', docType: 'test_catalog', filename: 'catalogue-analyses.xlsx' },
    { key: 'special', code: 'CAT-SPEC', title: 'Analyses spécialisées transmises', version: '1', docType: 'test_catalog', filename: 'analyses-specialisees.csv' },
    { key: 'procedure', code: 'PROC-NC-001', title: 'Gestion des non-conformités pré-analytiques', version: '1.2', docType: 'procedure', filename: 'procedure-non-conformites.docx' },
    { key: 'transport', code: 'CONS-TR-001', title: 'Consignes de transport', version: '1', docType: 'procedure', filename: 'consignes-transport.md' },
  ] as const;
  for (const document of documents) {
    const result = await ingest(harness, { ...document, activate: true });
    expect(result.job.status, `${document.filename} : ${result.job.last_error}`).toBe('succeeded');
    ids[document.key] = result.document.id;
  }
});

afterAll(async () => {
  await db?.close();
});

const searchChunks = (q: string, max = 8) =>
  db.asUser(memberId, async (tx) => (await tx.query<ChunkSearchResult>('select * from public.search_chunks($1, $2)', [q, max])).rows);
const searchAnalyses = (q: string, max = 5) =>
  db.asUser(memberId, async (tx) => (await tx.query<AnalysisSearchResult>('select * from public.search_analyses($1, $2)', [q, max])).rows);

describe('corpus ingéré', () => {
  it('active la v3 du manuel et archive la v2', async () => {
    const [v2] = await db.query<{ status: string }>('select status::text from public.documents where id = $1', [ids.manualV2]);
    const [v3] = await db.query<{ status: string; page_count: number }>('select status::text, page_count from public.documents where id = $1', [ids.manualV3]);
    expect(v2!.status).toBe('archived');
    expect(v3!.status).toBe('active');
    expect(v3!.page_count).toBe(9);
  });

  it('crée les fiches déterministes des tableaux (PDF, XLSX, CSV)', async () => {
    const counts = await db.query<{ document_id: string; n: number }>(
      'select document_id, count(*)::int as n from public.analyses group by document_id',
    );
    const byId = Object.fromEntries(counts.map((row) => [row.document_id, row.n]));
    expect(byId[ids.manualV3!]).toBe(28);
    expect(byId[ids.catalog!]).toBe(15);
    expect(byId[ids.special!]).toBe(6);
  });
});

describe('search_analyses', () => {
  it('« NFS tube mauve » -> fiche NFS du manuel v3, tube EDTA', async () => {
    const [first] = await searchAnalyses('NFS tube mauve');
    expect(first?.name).toBe('NFS (hémogramme)');
    expect(first?.document_version).toBe('3');
    expect(first?.accepted_tubes.join(' ')).toMatch(/EDTA K2/);
    expect(first?.rejected_tubes).toEqual(['Citrate', 'héparine de lithium']);
    expect(first?.field_sources.accepted_tubes?.quote).toBe('EDTA K2 (bouchon mauve)');
  });

  it('tolère une faute de frappe (« ammoniemie », « hemoglobine glyqee »)', async () => {
    expect((await searchAnalyses('ammoniemie'))[0]?.name).toBe('Ammoniémie');
    expect((await searchAnalyses('hemoglobine glyqee'))[0]?.name).toBe('Hémoglobine glyquée (HbA1c)');
    expect((await searchAnalyses('hémogrome tube violet'))[0]?.name).toBe('NFS (hémogramme)');
  });

  it('distingue les noms proches (Calcium / Calcium ionisé, Fer / Ferritine)', async () => {
    // Limite du classement SQL (tâche 1) : « Calcium » et « Calcium ionisé »
    // obtiennent le même score ; on vérifie que la bonne fiche est en tête de liste.
    const calcium = await searchAnalyses('calcium ionisé');
    expect(calcium.slice(0, 2).map((result) => result.name)).toContain('Calcium ionisé');
    expect((await searchAnalyses('ferritine'))[0]?.name).toBe('Ferritine');
    expect((await searchAnalyses('fer sérique'))[0]?.name).toBe('Fer sérique');
  });

  it('troponine : seule la v3 (EDTA refusé) est interrogeable', async () => {
    const results = await searchAnalyses('troponine');
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.document_version).not.toBe('2');
    const [first] = results;
    expect(first?.name).toBe('Troponine T hypersensible');
    expect(first?.rejected_tubes).toEqual(['EDTA']);
  });

  it('trouve par code exact et dans le catalogue XLSX / CSV', async () => {
    expect((await searchAnalyses('PCT'))[0]?.name).toBe('Procalcitonine');
    expect((await searchAnalyses('ACTH'))[0]?.document_code).toBe('CAT-SPEC');
  });
});

describe('search_chunks', () => {
  it('« NFS tube mauve » remonte la ligne du catalogue NFS', async () => {
    const results = await searchChunks('NFS tube mauve');
    const row = results.find((result) => result.kind === 'table_row' && result.content.startsWith('NFS (hémogramme)'));
    expect(row, JSON.stringify(results.map((r) => r.content.slice(0, 60)))).toBeDefined();
    expect(row!.document_version).toBe('3');
    expect(row!.page_number).toBe(4);
  });

  it('« tube citrate pour une NFS » remonte la règle du § 5.2', async () => {
    const results = await searchChunks('NFS reçue sur tube citrate refusée');
    expect(results.some((result) => result.content.includes('Un tube citrate (bouchon bleu clair) reçu seul pour une NFS est refusé'))).toBe(true);
  });

  it('« ammoniémie glace » remonte le cas particulier et la consigne de transport', async () => {
    const results = await searchChunks('ammoniémie dans la glace délai');
    const codes = new Set(results.map((result) => result.document_code));
    expect(codes.has('MP-PRE-001')).toBe(true);
    expect(codes.has('CONS-TR-001')).toBe(true);
  });

  it('la procédure DOCX est interrogeable (dérogation échantillon précieux)', async () => {
    const results = await searchChunks('dérogation échantillon précieux');
    expect(results.some((result) => result.document_code === 'PROC-NC-001')).toBe(true);
  });

  it("n'expose jamais la v2 archivée", async () => {
    const results = await searchChunks('troponine EDTA', 20);
    expect(results.every((result) => result.document_version !== '2' || result.document_code !== 'MP-PRE-001')).toBe(true);
  });
});
