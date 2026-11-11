/**
 * Pipeline d'ingestion par étapes, piloté par `ingestion_jobs`, pour tenir
 * dans la durée maximale d'une fonction serverless (~60 s) :
 *
 *   POST /ingest       startIngestion   -> job « queued » (ou reprise du job échoué)
 *   POST /ingest/step  runIngestionStep -> avance tant que le budget de temps le permet
 *
 * Étapes : parse (téléchargement, contrôle du type réel, texte par page)
 *       -> chunk (découpage)
 *       -> extract_analyses (déterministe sur les tableaux catalogue, puis LLM
 *          par lots sur les autres passages pertinents, si un LLM est configuré)
 *       -> finalize (document « ready »).
 *
 * Idempotence : chaque étape REMPLACE ses résultats (pages, chunks, fiches
 * d'un lot) ; le curseur n'avance qu'après écriture. Rejouer une étape après
 * un échec ne crée donc aucun doublon. Un verrou (locked_at/locked_by, périmé
 * après LOCK_TTL_MS) empêche deux exécutions simultanées du même job.
 * Les erreurs sont stockées en français dans le job et le document.
 */
import { createHash, randomUUID } from 'node:crypto';

import { HttpError } from '@/lib/auth/errors';
import {
  ingestionReportSchema,
  LlmError,
  type IngestionJob,
  type IngestionReport,
  type IngestionStage,
  type IngestResponse,
  type LabDocument,
  type LlmProvider,
} from '@/lib/contracts';

import { chunkPages, DEFAULT_CHUNKER_OPTIONS, type ChunkerOptions } from './chunker';
import { extractCatalogRow, isCatalogRow } from './deterministic';
import { IngestionError } from './errors';
import type { ExtractionChunk } from './extraction';
import { extractWithLlm, looksLikeAnalysisContent } from './llm-extract';
import { DEFAULT_PARSE_LIMITS, parseDocument } from './parsers';
import type { IngestionRepository } from './repository';
import type { DocumentStorage } from './storage';
import { createTubeMatcher } from './tubes';
import type { ParsedHeading, ParseLimits } from './types';

export const LOCK_TTL_MS = 90_000;
export const DEFAULT_STEP_BUDGET_MS = 45_000;
/** Temps minimal restant pour lancer un appel LLM dans le pas courant. */
export const MIN_LLM_CALL_MS = 15_000;
const MAX_LLM_CALL_MS = 40_000;

export interface PipelineDeps {
  repo: IngestionRepository;
  storage: DocumentStorage;
  /** null : aucun fournisseur configuré, extraction déterministe seulement. */
  llm: LlmProvider | null;
  now?: () => Date;
  /** Budget de temps d'un pas (ms). */
  budgetMs?: number;
  parseLimits?: ParseLimits;
  chunker?: ChunkerOptions;
  llmBatch?: { maxChunks: number; maxChars: number };
}

/** Curseur du job : bilan public (IngestionReport) + état interne de reprise. */
export interface PipelineCursor extends IngestionReport {
  headings?: Record<string, ParsedHeading[]>;
  extract?: { phase: 'deterministic' | 'llm' | 'done'; next_chunk_index: number };
}

export const STAGE_LABELS: Record<IngestionStage, string> = {
  parse: 'Lecture du fichier',
  chunk: 'Découpage',
  extract_analyses: 'Extraction des fiches',
  finalize: 'Finalisation',
};

export const LLM_UNAVAILABLE_WARNING =
  "Extraction assistée par IA désactivée (aucun fournisseur configuré) : seules les fiches issues des tableaux reconnus ont été créées. Les autres passages restent consultables par la recherche.";

function readCursor(job: IngestionJob): PipelineCursor {
  const raw = job.cursor ?? {};
  const report = ingestionReportSchema.parse(raw);
  return { ...(raw as Record<string, unknown>), ...report } as PipelineCursor;
}

function addStat(cursor: PipelineCursor, key: keyof NonNullable<IngestionReport['stats']>, delta: number): void {
  cursor.stats[key] = (cursor.stats[key] ?? 0) + delta;
}

function addWarning(cursor: PipelineCursor, warning: string): void {
  if (!cursor.warnings.includes(warning)) cursor.warnings.push(warning);
}

function isFinished(job: IngestionJob | null): boolean {
  return !!job && (job.status === 'succeeded' || job.status === 'failed' || job.status === 'cancelled');
}

async function state(deps: PipelineDeps, documentId: string): Promise<IngestResponse> {
  const document = await deps.repo.getDocument(documentId);
  if (!document) throw new HttpError('not_found', 'Document introuvable.');
  const job = await deps.repo.getLatestJob(documentId);
  if (!job) throw new HttpError('not_found', "Aucun traitement n'a encore été lancé pour ce document.");
  return { job, document, done: isFinished(job) };
}

export function getIngestionState(deps: PipelineDeps, documentId: string): Promise<IngestResponse> {
  return state(deps, documentId);
}

/**
 * Crée un job (ou reprend le dernier job échoué). `restart` force un nouveau
 * job repartant de la lecture du fichier.
 */
export async function startIngestion(
  deps: PipelineDeps,
  documentId: string,
  options: { restart?: boolean; userId?: string | null } = {},
): Promise<IngestResponse> {
  const { repo } = deps;
  const document = await repo.getDocument(documentId);
  if (!document) throw new HttpError('not_found', 'Document introuvable.');
  if (document.status !== 'draft') {
    throw new HttpError(
      'conflict',
      "Seul un document en brouillon peut être traité. Pour modifier un document actif ou archivé, importez une nouvelle version.",
    );
  }
  if (!document.storage_path) throw new HttpError('conflict', "Aucun fichier n'est associé à ce document.");

  const latest = await repo.getLatestJob(documentId);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  let job: IngestionJob;
  if (latest && !options.restart && (latest.status === 'queued' || latest.status === 'running')) {
    job = latest;
  } else if (latest && !options.restart && latest.status === 'failed') {
    job = await repo.updateJob(latest.id, { status: 'queued', last_error: null, locked_at: null, locked_by: null, finished_at: null });
  } else {
    if (latest && (latest.status === 'queued' || latest.status === 'running')) {
      await repo.updateJob(latest.id, { status: 'cancelled', finished_at: now, locked_at: null, locked_by: null });
    }
    const cursor: PipelineCursor = { warnings: [], llm: 'pending', stats: {} };
    job = await repo.insertJob({ document_id: documentId, created_by: options.userId ?? null, cursor: { ...cursor } });
  }
  const updated = await repo.updateDocument(documentId, { ingestion_status: 'processing', ingestion_error: null });
  return { job, document: updated, done: false };
}

/** Message d'erreur affichable, en français. */
export function describeError(error: unknown, stage: IngestionStage): string {
  if (error instanceof IngestionError) return error.message;
  if (error instanceof HttpError) return error.message;
  if (error instanceof LlmError) {
    return `Le service d'IA n'a pas pu traiter l'extraction des fiches (${error.code}). Relancez le traitement : il reprendra là où il s'est arrêté.`;
  }
  return `Erreur inattendue pendant l'étape « ${STAGE_LABELS[stage]} ». Relancez le traitement ; si le problème persiste, contactez un administrateur.`;
}

interface StepContext {
  deps: PipelineDeps;
  document: LabDocument;
  job: IngestionJob;
  cursor: PipelineCursor;
  deadline: number;
  owner: string;
  clock: () => Date;
}

/** Enregistre l'avancement (le verrou est prolongé à chaque écriture). */
async function persist(ctx: StepContext, patch: Partial<Pick<IngestionJob, 'stage' | 'progress' | 'total'>> = {}) {
  ctx.job = await ctx.deps.repo.updateJob(ctx.job.id, {
    ...patch,
    cursor: { ...ctx.cursor },
    locked_at: ctx.clock().toISOString(),
    locked_by: ctx.owner,
  });
}

async function stageParse(ctx: StepContext): Promise<void> {
  const { deps, document } = ctx;
  const bytes = await deps.storage.download(document.storage_path!);
  const parsed = await parseDocument(
    { bytes, mimeType: document.mime_type, filename: document.original_filename },
    deps.parseLimits ?? DEFAULT_PARSE_LIMITS,
  );
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  if (document.sha256 && document.sha256 !== sha256) {
    addWarning(ctx.cursor, "L'empreinte SHA-256 du fichier reçu diffère de celle annoncée à l'import : c'est le fichier stocké qui a été traité.");
  }
  await deps.repo.replacePages(
    document.id,
    parsed.pages.map((page) => ({ page_number: page.pageNumber, content: page.text, label: page.label })),
  );
  ctx.document = await deps.repo.updateDocument(document.id, { page_count: parsed.pages.length, sha256 });
  ctx.cursor.headings = Object.fromEntries(parsed.pages.map((page) => [String(page.pageNumber), page.headings]));
  for (const warning of parsed.warnings) addWarning(ctx.cursor, warning);
  ctx.cursor.stats.pages = parsed.pages.length;
  delete ctx.cursor.extract;
  await persist(ctx, { stage: 'chunk', progress: 0, total: null });
}

async function stageChunk(ctx: StepContext): Promise<void> {
  const { deps, document } = ctx;
  const pages = await deps.repo.listPages(document.id);
  const headings = ctx.cursor.headings ?? {};
  const drafts = chunkPages(
    pages.map((page) => ({ pageNumber: page.page_number, text: page.content, headings: headings[String(page.page_number)] })),
    deps.chunker ?? DEFAULT_CHUNKER_OPTIONS,
  );
  if (drafts.length === 0) {
    throw new IngestionError('empty_document', "Le document ne contient aucun passage exploitable après découpage.");
  }
  await deps.repo.replaceChunks(
    document.id,
    drafts.map((draft) => ({
      page_number: draft.pageNumber,
      chunk_index: draft.chunkIndex,
      kind: draft.kind,
      heading: draft.heading,
      content: draft.content,
      char_start: draft.charStart,
      char_end: draft.charEnd,
      metadata: draft.metadata,
    })),
  );
  ctx.cursor.stats.chunks = drafts.length;
  ctx.cursor.stats.table_rows = drafts.filter((draft) => draft.kind === 'table_row').length;
  ctx.cursor.extract = { phase: 'deterministic', next_chunk_index: 0 };
  await persist(ctx, { stage: 'extract_analyses', progress: 0, total: drafts.length });
}

async function loadChunks(ctx: StepContext): Promise<ExtractionChunk[]> {
  const all: ExtractionChunk[] = [];
  const pageSize = 1000;
  for (let offset = 0; ; offset += pageSize) {
    const batch = await ctx.deps.repo.listChunks(ctx.document.id, { offset, limit: pageSize });
    all.push(...batch);
    if (batch.length < pageSize) break;
  }
  return all.sort((a, b) => a.chunk_index - b.chunk_index);
}

/** Retourne vrai si l'étape est terminée, faux si le budget de temps est épuisé. */
async function stageExtract(ctx: StepContext): Promise<boolean> {
  const { deps, document } = ctx;
  const extract = (ctx.cursor.extract ??= { phase: 'deterministic', next_chunk_index: 0 });
  const chunks = await loadChunks(ctx);
  const tubes = createTubeMatcher(await deps.repo.loadGlossary());

  if (extract.phase === 'deterministic') {
    const analyses = [];
    let rejectedFields = 0;
    let rejectedAnalyses = 0;
    for (const chunk of chunks) {
      if (!isCatalogRow(chunk)) continue;
      const result = extractCatalogRow(chunk, tubes);
      if (!result) continue;
      rejectedFields += result.rejections.length;
      if (result.analysis) analyses.push(result.analysis);
      else rejectedAnalyses += 1;
    }
    await deps.repo.replaceAnalyses(document.id, 'all', analyses);
    ctx.cursor.stats.analyses_deterministic = analyses.length;
    ctx.cursor.stats.analyses_llm = 0;
    ctx.cursor.stats.rejected_fields = rejectedFields;
    ctx.cursor.stats.rejected_analyses = rejectedAnalyses;
    ctx.cursor.extract = { phase: 'llm', next_chunk_index: 0 };
    await persist(ctx, { progress: 0 });
  }

  const llmState = ctx.cursor.extract!;
  if (llmState.phase === 'llm') {
    const candidates = chunks.filter(
      (chunk) => chunk.chunk_index >= llmState.next_chunk_index && !isCatalogRow(chunk) && looksLikeAnalysisContent(chunk, tubes.terms),
    );
    if (candidates.length > 0 && !deps.llm) {
      ctx.cursor.llm = 'unavailable';
      addWarning(ctx.cursor, LLM_UNAVAILABLE_WARNING);
      llmState.phase = 'done';
    } else if (candidates.length === 0) {
      if (ctx.cursor.llm === 'pending') ctx.cursor.llm = 'not_needed';
      llmState.phase = 'done';
    } else {
      const batchLimits = deps.llmBatch ?? { maxChunks: 4, maxChars: 5000 };
      let index = 0;
      let batchesThisStep = 0;
      while (index < candidates.length) {
        const remaining = ctx.deadline - Date.now();
        // Au moins un lot par pas (progression garantie), puis selon le budget.
        if (batchesThisStep > 0 && remaining < MIN_LLM_CALL_MS) return false;
        batchesThisStep += 1;
        const batch: ExtractionChunk[] = [];
        let chars = 0;
        while (index < candidates.length && batch.length < batchLimits.maxChunks) {
          const next = candidates[index]!;
          if (batch.length > 0 && chars + next.content.length > batchLimits.maxChars) break;
          batch.push(next);
          chars += next.content.length;
          index += 1;
        }
        const result = await extractWithLlm(deps.llm!, batch, tubes, {
          signal: AbortSignal.timeout(Math.max(MIN_LLM_CALL_MS, Math.min(MAX_LLM_CALL_MS, remaining - 2_000))),
        });
        await deps.repo.replaceAnalyses(document.id, batch.map((chunk) => chunk.id), result.analyses);
        ctx.cursor.llm = 'used';
        addStat(ctx.cursor, 'llm_calls', result.usage.calls);
        addStat(ctx.cursor, 'analyses_llm', result.analyses.length);
        addStat(ctx.cursor, 'rejected_fields', result.rejections.length);
        addStat(ctx.cursor, 'rejected_analyses', result.rejectedAnalyses);
        if (result.invalidResponse) {
          addStat(ctx.cursor, 'llm_invalid_responses', 1);
          const pages = [...new Set(batch.map((chunk) => chunk.page_number))].join(', ');
          addWarning(ctx.cursor, `Réponse de l'IA inexploitable pour un lot de passages (page(s) ${pages}) : aucune fiche créée pour ce lot.`);
        }
        const last = batch[batch.length - 1]!;
        llmState.next_chunk_index = last.chunk_index + 1;
        await persist(ctx, { progress: Math.min(llmState.next_chunk_index, chunks.length) });
      }
      llmState.phase = 'done';
    }
  }
  await persist(ctx, { stage: 'finalize', progress: chunks.length });
  return true;
}

async function stageFinalize(ctx: StepContext): Promise<void> {
  const { deps, document } = ctx;
  const analyses = await deps.repo.listAnalyses(document.id);
  ctx.cursor.stats.analyses_deterministic ??= 0;
  ctx.cursor.stats.analyses_llm ??= 0;
  const finishedAt = ctx.clock().toISOString();
  ctx.document = await deps.repo.updateDocument(document.id, { ingestion_status: 'ready', ingestion_error: null });
  ctx.job = await deps.repo.updateJob(ctx.job.id, {
    status: 'succeeded',
    cursor: { ...ctx.cursor, analyses_total: analyses.length },
    finished_at: finishedAt,
    last_error: null,
  });
}

/**
 * Fait avancer le job du document autant que le budget de temps le permet.
 * `done` vaut vrai quand le job est terminé (succès ou échec).
 */
export async function runIngestionStep(deps: PipelineDeps, documentId: string): Promise<IngestResponse> {
  const clock = deps.now ?? (() => new Date());
  const startedAt = Date.now();
  const document = await deps.repo.getDocument(documentId);
  if (!document) throw new HttpError('not_found', 'Document introuvable.');
  const latest = await deps.repo.getLatestJob(documentId);
  if (!latest) throw new HttpError('conflict', "Aucun traitement n'est en cours : lancez d'abord l'ingestion.");
  if (isFinished(latest)) return { job: latest, document, done: true };

  const owner = randomUUID();
  const now = clock();
  const locked = await deps.repo.tryLockJob(latest.id, owner, now, new Date(now.getTime() - LOCK_TTL_MS));
  if (!locked) return { job: latest, document, done: false };

  const ctx: StepContext = {
    deps,
    document,
    job: locked,
    cursor: readCursor(locked),
    deadline: startedAt + (deps.budgetMs ?? DEFAULT_STEP_BUDGET_MS),
    owner,
    clock,
  };
  try {
    for (;;) {
      const stage = ctx.job.stage;
      if (stage === 'parse') await stageParse(ctx);
      else if (stage === 'chunk') await stageChunk(ctx);
      else if (stage === 'extract_analyses') {
        const finished = await stageExtract(ctx);
        if (!finished) break;
      } else {
        await stageFinalize(ctx);
        break;
      }
      // Lecture et découpage sont rapides ; on s'arrête si le budget est entamé.
      if (Date.now() > ctx.deadline - MIN_LLM_CALL_MS && ctx.job.stage !== 'finalize') break;
    }
  } catch (error) {
    const stage = ctx.job.stage;
    const message = describeError(error, stage);
    if (!(error instanceof IngestionError) || error.code === 'internal') {
      console.error(`[labguard] ingestion ${documentId} (étape ${stage}) :`, error);
    }
    const failedAt = clock().toISOString();
    ctx.job = await deps.repo.updateJob(ctx.job.id, {
      status: 'failed',
      last_error: message,
      attempts: ctx.job.attempts + 1,
      cursor: { ...ctx.cursor },
      locked_at: null,
      locked_by: null,
      finished_at: failedAt,
    });
    ctx.document = await deps.repo.updateDocument(documentId, { ingestion_status: 'failed', ingestion_error: message });
    return { job: ctx.job, document: ctx.document, done: true };
  }
  if (ctx.job.status !== 'succeeded') {
    ctx.job = (await deps.repo.unlockJob(ctx.job.id, owner, { status: 'running' })) ?? ctx.job;
  } else {
    ctx.job = (await deps.repo.unlockJob(ctx.job.id, owner, {})) ?? ctx.job;
  }
  return { job: ctx.job, document: ctx.document, done: isFinished(ctx.job) };
}
