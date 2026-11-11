/**
 * Aides de test : ingestion complète d'un fichier du corpus FICTIF dans une
 * base PGlite (dépôt PGlite + stockage en mémoire), sans réseau.
 */
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';

import type {
  DocType,
  IngestResponse,
  LlmChatRequest,
  LlmChatResponse,
  LlmProvider,
  SupportedMimeType,
} from '@/lib/contracts';
import { createDocument, runIngestionStep, startIngestion, type PipelineDeps } from '@/lib/ingestion';

import type { TestDb } from '../../helpers/db';
import { createPgliteRepository, MemoryStorage } from './pglite-repository';

export const CORPUS_DIR = resolve(import.meta.dirname, '..', '..', 'fixtures', 'corpus');

export function corpusFile(name: string): Uint8Array {
  return new Uint8Array(readFileSync(join(CORPUS_DIR, name)));
}

export const MIME: Record<string, SupportedMimeType> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  md: 'text/plain',
};

export function mimeFor(filename: string): SupportedMimeType {
  return MIME[filename.split('.').pop()!.toLowerCase()]!;
}

export interface IngestOptions {
  code: string;
  title: string;
  version: string;
  docType: DocType;
  filename: string;
  bytes?: Uint8Array;
  activate?: boolean;
  /** Faux : n'annonce pas d'empreinte (contourne la détection de doublon). */
  withSha256?: boolean;
}

export interface Harness {
  db: TestDb;
  storage: MemoryStorage;
  deps: PipelineDeps;
  adminId: string;
}

export async function createHarness(db: TestDb, llm: LlmProvider | null = null, extra: Partial<PipelineDeps> = {}): Promise<Harness> {
  const admin = await db.createUser(`admin-${Math.random().toString(36).slice(2)}@lab.test`, { role: 'admin' });
  const storage = new MemoryStorage();
  return { db, storage, adminId: admin.id, deps: { repo: createPgliteRepository(db), storage, llm, ...extra } };
}

/** Crée le document, « envoie » le fichier, lance puis termine l'ingestion. */
export async function ingest(harness: Harness, options: IngestOptions): Promise<IngestResponse & { steps: number }> {
  const bytes = options.bytes ?? corpusFile(options.filename);
  const created = await createDocument(
    harness.deps,
    {
      code: options.code,
      title: options.title,
      version: options.version,
      doc_type: options.docType,
      filename: options.filename,
      mime_type: mimeFor(options.filename),
      file_size: bytes.byteLength,
      ...(options.withSha256 === false ? {} : { sha256: createHash('sha256').update(bytes).digest('hex') }),
    },
    harness.adminId,
  );
  harness.storage.put(created.upload.path, bytes);
  await startIngestion(harness.deps, created.document.id, { userId: harness.adminId });
  let result: IngestResponse;
  let steps = 0;
  do {
    result = await runIngestionStep(harness.deps, created.document.id);
    steps += 1;
    if (steps > 50) throw new Error('ingestion sans fin');
  } while (!result.done);
  if (options.activate && result.job.status === 'succeeded') {
    await harness.deps.repo.activateDocument(created.document.id);
  }
  return { ...result, steps };
}

/** Faux fournisseur LLM programmable (aucun réseau). */
export class ScriptedLlm implements LlmProvider {
  readonly name = 'fake' as const;
  readonly model = 'fake-extraction';
  readonly requests: LlmChatRequest[] = [];

  constructor(private readonly respond: (request: LlmChatRequest, index: number) => string | Error) {}

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    this.requests.push(request);
    const output = this.respond(request, this.requests.length - 1);
    if (output instanceof Error) throw output;
    return {
      message: { role: 'assistant', content: output, toolCalls: [] },
      finishReason: 'stop',
      usage: { inputTokens: 100, outputTokens: 50 },
      provider: 'fake',
      model: this.model,
    };
  }
}

/** Champs vides au format du schéma d'extraction. */
export function emptySheet(passage: string) {
  const text = { value: null, quote: null };
  const list = { values: [], quote: null };
  return {
    passage,
    name: text,
    synonyms: list,
    codes: list,
    accepted_tubes: list,
    rejected_tubes: list,
    volume: text,
    transport: text,
    storage: text,
    stability: text,
    turnaround_time: text,
    remarks: text,
  };
}
