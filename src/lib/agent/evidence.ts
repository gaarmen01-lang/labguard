/**
 * Registre des chunks réellement renvoyés par les outils pendant UN tour de
 * question, et sérialisation compacte (avec budget) des résultats d'outils
 * transmis au modèle.
 *
 * Les métadonnées (document, version, page) viennent toujours des résultats
 * des RPC (donc de la base), jamais du modèle.
 */
import type {
  AnalysisField,
  AnalysisSearchResult,
  ChunkRecord,
  ChunkSearchResult,
  PageReadResult,
} from '@/lib/contracts';

export interface RetrievedChunk {
  chunk_id: string;
  document_id: string;
  document_code: string;
  document_title: string;
  document_version: string;
  /** null si seule une fiche y renvoie sans page connue. */
  page_number: number | null;
  /** Texte intégral (search_documents, getChunks) ; null si inconnu. */
  content: string | null;
  /** Extraits déjà vérifiés à l'ingestion (field_sources, source_quote). */
  excerpts: string[];
}

export class RetrievedChunks {
  private readonly byId = new Map<string, RetrievedChunk>();

  get size(): number {
    return this.byId.size;
  }

  get(chunkId: string): RetrievedChunk | undefined {
    return this.byId.get(chunkId);
  }

  has(chunkId: string): boolean {
    return this.byId.has(chunkId);
  }

  values(): RetrievedChunk[] {
    return [...this.byId.values()];
  }

  /** Chunks connus seulement par un extrait, ou sans page : à relire si possible. */
  incomplete(): string[] {
    return this.values()
      .filter((chunk) => chunk.content === null || chunk.page_number === null)
      .map((chunk) => chunk.chunk_id);
  }

  private upsert(entry: RetrievedChunk): void {
    const existing = this.byId.get(entry.chunk_id);
    if (!existing) {
      this.byId.set(entry.chunk_id, { ...entry, excerpts: [...new Set(entry.excerpts)] });
      return;
    }
    if (existing.content === null && entry.content !== null) existing.content = entry.content;
    if (existing.page_number === null && entry.page_number !== null) existing.page_number = entry.page_number;
    for (const excerpt of entry.excerpts) {
      if (!existing.excerpts.includes(excerpt)) existing.excerpts.push(excerpt);
    }
  }

  addChunkResults(results: readonly ChunkSearchResult[]): void {
    for (const result of results) this.addChunkRecords([result]);
  }

  addChunkRecords(records: readonly ChunkRecord[]): void {
    for (const record of records) {
      this.upsert({
        chunk_id: record.chunk_id,
        document_id: record.document_id,
        document_code: record.document_code,
        document_title: record.document_title,
        document_version: record.document_version,
        page_number: record.page_number,
        content: record.content,
        excerpts: [],
      });
    }
  }

  addAnalysisResults(results: readonly AnalysisSearchResult[]): void {
    for (const analysis of results) {
      const meta = {
        document_id: analysis.document_id,
        document_code: analysis.document_code,
        document_title: analysis.document_title,
        document_version: analysis.document_version,
        content: null,
      };
      const pageOf = (chunkId: string) =>
        chunkId === analysis.source_chunk_id ? analysis.source_page_number : null;
      if (analysis.source_chunk_id && analysis.source_quote) {
        this.upsert({
          ...meta,
          chunk_id: analysis.source_chunk_id,
          page_number: analysis.source_page_number,
          excerpts: [analysis.source_quote],
        });
      }
      for (const source of Object.values(analysis.field_sources)) {
        if (!source) continue;
        this.upsert({ ...meta, chunk_id: source.chunk_id, page_number: pageOf(source.chunk_id), excerpts: [source.quote] });
      }
    }
  }
}

// --- Sérialisation pour le modèle ----------------------------------------------

export interface EvidenceLimits {
  /** Taille max (caractères) du JSON d'un résultat d'outil. */
  toolResultChars: number;
  /** Taille max du texte d'un passage / d'une page dans un résultat. */
  itemContentChars: number;
  /** Taille max du bloc de preuves transmis à la rédaction finale. */
  composeEvidenceChars: number;
}

export const DEFAULT_EVIDENCE_LIMITS: EvidenceLimits = {
  toolResultChars: 12_000,
  itemContentChars: 2_500,
  composeEvidenceChars: 40_000,
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)} [… texte tronqué]`;
}

function documentLabel(item: { document_code: string; document_title: string; document_version: string }): string {
  return `${item.document_code} — ${item.document_title} (version ${item.document_version})`;
}

export function serializePassage(result: ChunkSearchResult, limits: EvidenceLimits): Record<string, unknown> {
  return {
    chunk_id: result.chunk_id,
    document_id: result.document_id,
    document: documentLabel(result),
    page: result.page_number,
    ...(result.heading ? { section: result.heading } : {}),
    content: clip(result.content, limits.itemContentChars),
  };
}

const SHEET_FIELDS: readonly AnalysisField[] = [
  'synonyms',
  'codes',
  'accepted_tubes',
  'rejected_tubes',
  'volume',
  'transport',
  'storage',
  'stability',
  'turnaround_time',
  'remarks',
];

export function serializeSheet(result: AnalysisSearchResult): Record<string, unknown> {
  const sheet: Record<string, unknown> = {
    analysis: result.name,
    document_id: result.document_id,
    document: documentLabel(result),
  };
  for (const field of SHEET_FIELDS) {
    const value = result[field];
    if (value === null || (Array.isArray(value) && value.length === 0)) continue;
    sheet[field] = value;
  }
  // Champs non renseignés : utile pour que le modèle sache que la fiche est muette.
  const missing = SHEET_FIELDS.filter((field) => {
    const value = result[field];
    return value === null || (Array.isArray(value) && value.length === 0);
  });
  if (missing.length > 0) sheet.fields_not_in_sheet = missing;
  sheet.sources = Object.entries(result.field_sources)
    .filter(([, source]) => source)
    .map(([field, source]) => ({ field, chunk_id: source!.chunk_id, quote: source!.quote }));
  sheet.source = { chunk_id: result.source_chunk_id, quote: result.source_quote };
  return sheet;
}

export function serializePage(result: PageReadResult, limits: EvidenceLimits): Record<string, unknown> {
  return {
    document_id: result.document_id,
    document: documentLabel(result),
    page: result.page_number,
    ...(result.page_count ? { page_count: result.page_count } : {}),
    content: clip(result.content, limits.itemContentChars * 2),
    note: 'Texte de page fourni pour le contexte ; pour citer, utiliser un chunk_id de passage ou de fiche.',
  };
}

/** Ajoute des éléments tant que le JSON reste sous `budget` caractères. */
export function fitToBudget<T>(items: readonly T[], budget: number): { kept: T[]; omitted: number } {
  const kept: T[] = [];
  let size = 2;
  for (const item of items) {
    const itemSize = JSON.stringify(item).length + 1;
    if (size + itemSize > budget) break;
    kept.push(item);
    size += itemSize;
  }
  return { kept, omitted: items.length - kept.length };
}

export const EMPTY_RESULT_HINT =
  'Aucun résultat. Reformule (synonyme, abréviation, nom complet, code, terme du glossaire, mots-clés plus courts).';

/** Contenu JSON d'un message `tool` (résultats tronqués au budget). */
export function toolResultContent(items: readonly Record<string, unknown>[], budget: number): string {
  if (items.length === 0) return JSON.stringify({ results: [], message: EMPTY_RESULT_HINT });
  const { kept, omitted } = fitToBudget(items, budget - 120);
  return JSON.stringify({
    results: kept,
    ...(omitted > 0 ? { truncated: true, omitted_results: omitted } : {}),
  });
}

/** Preuves accumulées pendant la recherche, dédoublonnées, pour la rédaction finale. */
export class EvidenceLog {
  private readonly sheets = new Map<string, Record<string, unknown>>();
  private readonly passages = new Map<string, Record<string, unknown>>();
  private readonly pages = new Map<string, Record<string, unknown>>();

  constructor(private readonly limits: EvidenceLimits) {}

  get isEmpty(): boolean {
    return this.sheets.size === 0 && this.passages.size === 0 && this.pages.size === 0;
  }

  addSheets(results: readonly AnalysisSearchResult[]): void {
    for (const result of results) {
      if (!this.sheets.has(result.analysis_id)) this.sheets.set(result.analysis_id, serializeSheet(result));
    }
  }

  addPassages(results: readonly ChunkSearchResult[]): void {
    for (const result of results) {
      if (!this.passages.has(result.chunk_id)) this.passages.set(result.chunk_id, serializePassage(result, this.limits));
    }
  }

  addPages(results: readonly PageReadResult[]): void {
    for (const result of results) {
      const key = `${result.document_id}#${result.page_number}`;
      if (!this.pages.has(key)) this.pages.set(key, serializePage(result, this.limits));
    }
  }

  /** JSON des preuves ; priorité fiches > passages > pages si le budget est dépassé. */
  toJson(): string {
    let budget = this.limits.composeEvidenceChars;
    const take = (items: Record<string, unknown>[]) => {
      const { kept } = fitToBudget(items, budget);
      budget -= JSON.stringify(kept).length;
      return kept;
    };
    const fiches = take([...this.sheets.values()]);
    const passages = take([...this.passages.values()]);
    const pages = take([...this.pages.values()]);
    return JSON.stringify({ fiches, passages, pages }, null, 1);
  }
}
