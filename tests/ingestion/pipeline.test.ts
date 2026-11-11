/**
 * Pipeline par étapes sur PGlite : bout en bout, sans LLM, avec faux LLM,
 * budget de temps court (plusieurs pas), reprise idempotente après échec,
 * rejeu d'étapes sans doublon, verrou, erreurs lisibles en français.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HttpError } from '@/lib/auth/errors';
import { ingestionReportSchema, LlmError, type LlmChatRequest } from '@/lib/contracts';
import {
  activateDocument,
  LLM_UNAVAILABLE_WARNING,
  LOCK_TTL_MS,
  runIngestionStep,
  SCANNED_PDF_MESSAGE,
  startIngestion,
} from '@/lib/ingestion';

import { createTestDb, type TestDb } from '../helpers/db';
import { corpusFile, createHarness, emptySheet, ingest, ScriptedLlm, type Harness } from './helpers/ingest';

const MANUAL = { code: 'MP-PRE-001', title: 'Manuel de prélèvement', version: '3', docType: 'sampling_manual', filename: 'manuel-prelevement-v3.pdf' } as const;

let db: TestDb;

beforeEach(async () => {
  db = await createTestDb();
});

afterEach(async () => {
  await db.close();
});

async function counts(documentId: string) {
  const [row] = await db.query<{ pages: number; chunks: number; analyses: number; sources: number }>(
    `select (select count(*)::int from public.document_pages where document_id = $1) as pages,
            (select count(*)::int from public.chunks where document_id = $1) as chunks,
            (select count(*)::int from public.analyses where document_id = $1) as analyses,
            (select count(*)::int from public.analysis_field_sources fs join public.analyses a on a.id = fs.analysis_id
              where a.document_id = $1) as sources`,
    [documentId],
  );
  return row!;
}

async function duplicateAnalyses(documentId: string): Promise<number> {
  const [row] = await db.query<{ n: number }>(
    `select count(*)::int as n from (select source_chunk_id, name from public.analyses where document_id = $1
       group by 1, 2 having count(*) > 1) d`,
    [documentId],
  );
  return row!.n;
}

/** Passages du prompt d'extraction : [ref, contenu]. */
function passages(request: LlmChatRequest): Array<[string, string]> {
  const user = request.messages.find((message) => message.role === 'user')!.content as string;
  return [...user.matchAll(/### Passage (P\d+) \(page \d+\)\n(?:Section : .*\n)?"""\n([\s\S]*?)\n"""/g)].map((m) => [m[1]!, m[2]!]);
}

/** Faux LLM : une fiche pour chaque passage « Ammoniémie » ou « Glycémie » en prose, dont un champ inventé. */
function extractionLlm(options: { failOnCall?: number } = {}) {
  return new ScriptedLlm((request, index) => {
    if (options.failOnCall === index) return new LlmError('indisponible', { code: 'unavailable', provider: 'fake' });
    const analyses = [];
    for (const [ref, content] of passages(request)) {
      if (content.includes('5.4 Ammoniémie\n')) {
        analyses.push({
          ...emptySheet(ref),
          name: { value: 'Ammoniémie', quote: '5.4 Ammoniémie' },
          accepted_tubes: { values: ['tube EDTA K2'], quote: 'sur tube EDTA K2 placé immédiatement dans la glace' },
          rejected_tubes: { values: ["tube à l'héparine d'ammonium"], quote: 'Le tube à l’héparine d’ammonium est strictement refusé' },
          // Champ inventé : doit être rejeté.
          volume: { value: '5 mL', quote: 'Prélever 5 mL' },
        });
      }
      if (content.includes('5.1 Glycémie\n')) {
        analyses.push({
          ...emptySheet(ref),
          name: { value: 'Glycémie', quote: 'Glycémie' },
          accepted_tubes: { values: ['tube hépariné (bouchon vert)'], quote: 'un tube hépariné (bouchon vert) est accepté pour la glycémie' },
          remarks: {
            value: 'centrifugé dans les 30 minutes suivant le prélèvement',
            quote: 'à condition d’être centrifugé dans les 30 minutes suivant le prélèvement',
          },
        });
      }
    }
    return JSON.stringify({ analyses });
  });
}

describe('sans LLM configuré', () => {
  it('ingère le manuel : pages, chunks, fiches déterministes, avertissement', async () => {
    const harness = await createHarness(db, null);
    const result = await ingest(harness, MANUAL);
    expect(result.job.status).toBe('succeeded');
    expect(result.document.ingestion_status).toBe('ready');
    expect(result.document.page_count).toBe(9);
    const report = ingestionReportSchema.parse(result.job.cursor);
    expect(report.llm).toBe('unavailable');
    expect(report.warnings).toContain(LLM_UNAVAILABLE_WARNING);
    expect(report.stats).toMatchObject({ pages: 9, table_rows: 28, analyses_deterministic: 28, analyses_llm: 0 });
    const current = await counts(result.document.id);
    expect(current).toMatchObject({ pages: 9, analyses: 28 });
    expect(current.chunks).toBe(report.stats.chunks);
    expect(result.job.progress).toBe(current.chunks);
    expect(result.job.locked_by).toBeNull();
  });
});

describe('avec un faux LLM', () => {
  it('ajoute les fiches des passages en prose, champs inventés rejetés', async () => {
    const llm = extractionLlm();
    const harness = await createHarness(db, llm);
    const result = await ingest(harness, MANUAL);
    expect(result.job.status).toBe('succeeded');
    const report = ingestionReportSchema.parse(result.job.cursor);
    expect(report.llm).toBe('used');
    expect(report.stats.analyses_llm).toBe(2);
    expect(report.stats.rejected_fields).toBeGreaterThanOrEqual(1);
    expect(llm.requests.length).toBe(report.stats.llm_calls);
    // Les lignes du catalogue ne sont jamais envoyées au LLM.
    for (const request of llm.requests) {
      for (const [, content] of passages(request)) expect(content).not.toMatch(/^NFS \(hémogramme\) \|/);
    }
    const [ammonia] = await db.query<{ volume: string | null; rejected_tubes: string[]; quote: string }>(
      `select a.volume, a.rejected_tubes, fs.quote from public.analyses a
       join public.analysis_field_sources fs on fs.analysis_id = a.id and fs.field = 'rejected_tubes'
       join public.chunks c on c.id = a.source_chunk_id
       where a.document_id = $1 and a.name = 'Ammoniémie' and c.kind = 'text'`,
      [result.document.id],
    );
    expect(ammonia).toEqual({
      volume: null,
      rejected_tubes: ["tube à l'héparine d'ammonium"],
      quote: 'Le tube à l’héparine d’ammonium est strictement refusé',
    });
    expect(await counts(result.document.id)).toMatchObject({ analyses: 30 });
  });

  it('budget court : plusieurs pas, même résultat', async () => {
    const llm = extractionLlm();
    const harness = await createHarness(db, llm, { budgetMs: 1, llmBatch: { maxChunks: 1, maxChars: 5000 } });
    const result = await ingest(harness, MANUAL);
    expect(result.job.status).toBe('succeeded');
    expect(result.steps).toBeGreaterThan(5);
    expect(await counts(result.document.id)).toMatchObject({ analyses: 30 });
    expect(await duplicateAnalyses(result.document.id)).toBe(0);
  });

  it('échec du fournisseur au 2e lot : erreur en français, reprise sans refaire le 1er lot ni doublon', async () => {
    const reference = await (async () => {
      const harness = await createHarness(db, extractionLlm(), { llmBatch: { maxChunks: 2, maxChars: 5000 } });
      const done = await ingest(harness, { ...MANUAL, version: 'référence', withSha256: false });
      return counts(done.document.id);
    })();

    const failing = extractionLlm({ failOnCall: 1 });
    const harness = await createHarness(db, failing, { llmBatch: { maxChunks: 2, maxChars: 5000 } });
    const failed = await ingest(harness, { ...MANUAL, withSha256: false });
    expect(failed.job.status).toBe('failed');
    expect(failed.job.stage).toBe('extract_analyses');
    expect(failed.job.last_error).toMatch(/^Le service d'IA n'a pas pu traiter l'extraction des fiches \(unavailable\)\. Relancez le traitement/);
    expect(failed.document.ingestion_status).toBe('failed');
    expect(failed.document.ingestion_error).toBe(failed.job.last_error);
    expect(failed.job.attempts).toBe(1);
    const cursorAfterFailure = failed.job.cursor as { extract: { next_chunk_index: number } };
    expect(cursorAfterFailure.extract.next_chunk_index).toBeGreaterThan(0);

    // Reprise : même job, même étape, le fournisseur répond de nouveau.
    const working = extractionLlm();
    harness.deps.llm = working;
    const resumed = await startIngestion(harness.deps, failed.document.id);
    expect(resumed.job.id).toBe(failed.job.id);
    expect(resumed.job.status).toBe('queued');
    let state = resumed;
    while (!state.done) state = await runIngestionStep(harness.deps, failed.document.id);
    expect(state.job.status).toBe('succeeded');
    expect(state.document.ingestion_status).toBe('ready');
    expect(state.document.ingestion_error).toBeNull();
    // Le 1er lot (déjà traité) n'est pas renvoyé au fournisseur.
    const firstBatch = passages(failing.requests[0]!).map(([, content]) => content);
    for (const request of working.requests) {
      for (const [, content] of passages(request)) expect(firstBatch).not.toContain(content);
    }
    expect(await counts(failed.document.id)).toEqual(reference);
    expect(await duplicateAnalyses(failed.document.id)).toBe(0);
  });

  it('rejouer des étapes déjà faites ne crée aucun doublon', async () => {
    const harness = await createHarness(db, extractionLlm());
    const done = await ingest(harness, MANUAL);
    const before = await counts(done.document.id);
    for (const stage of ['extract_analyses', 'chunk', 'parse'] as const) {
      await db.query(
        `update public.ingestion_jobs set status = 'running', stage = $2,
           cursor = cursor - 'extract', finished_at = null where id = $1`,
        [done.job.id, stage],
      );
      let state = await runIngestionStep(harness.deps, done.document.id);
      while (!state.done) state = await runIngestionStep(harness.deps, done.document.id);
      expect(state.job.status).toBe('succeeded');
      expect(await counts(done.document.id)).toEqual(before);
      expect(await duplicateAnalyses(done.document.id)).toBe(0);
    }
    // Redémarrage complet : nouveau job, même contenu.
    const restarted = await startIngestion(harness.deps, done.document.id, { restart: true });
    expect(restarted.job.id).not.toBe(done.job.id);
    let state = restarted;
    while (!state.done) state = await runIngestionStep(harness.deps, done.document.id);
    expect(await counts(done.document.id)).toEqual(before);
  });
});

describe('verrou et états', () => {
  it('un job verrouillé par un autre pas n’avance pas ; un verrou périmé est repris', async () => {
    const harness = await createHarness(db, null);
    const created = await ingest(harness, { ...MANUAL, bytes: corpusFile('analyses-specialisees.csv'), filename: 'analyses-specialisees.csv' });
    const restarted = await startIngestion(harness.deps, created.document.id, { restart: true });
    await db.query(`update public.ingestion_jobs set locked_at = now(), locked_by = 'autre' where id = $1`, [restarted.job.id]);
    const blocked = await runIngestionStep(harness.deps, created.document.id);
    expect(blocked.done).toBe(false);
    expect(blocked.job.stage).toBe('parse');
    await db.query(`update public.ingestion_jobs set locked_at = now() - $2::interval where id = $1`, [
      restarted.job.id,
      `${Math.ceil(LOCK_TTL_MS / 1000) + 5} seconds`,
    ]);
    const resumed = await runIngestionStep(harness.deps, created.document.id);
    expect(resumed.done).toBe(true);
    expect(resumed.job.status).toBe('succeeded');
  });

  it('PDF scanné : job en échec avec le message OCR, document « failed », non activable', async () => {
    const harness = await createHarness(db, null);
    const result = await ingest(harness, { ...MANUAL, filename: 'scan-sans-texte.pdf' });
    expect(result.job.status).toBe('failed');
    expect(result.job.stage).toBe('parse');
    expect(result.job.last_error).toBe(SCANNED_PDF_MESSAGE);
    expect(result.document.ingestion_status).toBe('failed');
    await expect(activateDocument(harness.deps, result.document.id)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('fichier absent du stockage ou de type falsifié : message clair', async () => {
    const harness = await createHarness(db, null);
    const missing = await ingest(harness, MANUAL);
    harness.storage.files.clear();
    await startIngestion(harness.deps, missing.document.id, { restart: true });
    const state = await runIngestionStep(harness.deps, missing.document.id);
    expect(state.job.last_error).toMatch(/introuvable dans le stockage/);

    const forged = await ingest(harness, { ...MANUAL, version: '4', filename: 'faux.pdf', bytes: corpusFile('procedure-non-conformites.docx') });
    expect(forged.job.status).toBe('failed');
    expect(forged.job.last_error).toBe('Le contenu du fichier (DOCX) ne correspond pas au type déclaré (PDF).');
  });

  it('seul un brouillon peut être (ré)ingéré', async () => {
    const harness: Harness = await createHarness(db, null);
    const done = await ingest(harness, { ...MANUAL, activate: true });
    await expect(startIngestion(harness.deps, done.document.id)).rejects.toBeInstanceOf(HttpError);
    await expect(runIngestionStep(harness.deps, '00000000-0000-4000-8000-000000000000')).rejects.toMatchObject({ code: 'not_found' });
  });
});
