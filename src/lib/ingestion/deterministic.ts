/**
 * Extraction déterministe (sans LLM) des fiches d'analyses à partir des
 * lignes de tableaux « catalogue » (en-têtes reconnus, cf. analysis-fields.ts).
 * Chaque champ cite la cellule dont il provient ; la citation est vérifiée
 * comme pour le LLM (filet de sécurité).
 */
import type { AnalysisField } from '@/lib/contracts';

import { mapHeader } from './analysis-fields';
import type { ChunkMetadata } from './chunker';
import { buildAnalysis, type BuildResult, type ExtractionChunk, type FieldCandidate } from './extraction';
import { isEmptyCell, splitTableRow } from './text-layout';
import type { TubeMatcher } from './tubes';

function tableMetadata(chunk: ExtractionChunk): ChunkMetadata['table'] | null {
  const table = (chunk.metadata as Partial<ChunkMetadata>).table;
  if (!table || !Array.isArray(table.header)) return null;
  return table;
}

/** Vrai si le chunk est une ligne de tableau catalogue exploitable sans LLM. */
export function isCatalogRow(chunk: ExtractionChunk): boolean {
  return chunk.kind === 'table_row' && tableMetadata(chunk)?.catalog === true;
}

/** Unité indiquée dans l'en-tête (« Volume minimal (mL) » -> « mL »). */
function headerUnit(label: string): string | null {
  const unit = /\(([^)]{1,8})\)\s*$/.exec(label)?.[1]?.trim();
  return unit && /^[\p{L}µ/%°]+$/u.test(unit) ? unit : null;
}

function splitList(value: string): string[] {
  return value
    .split(/\s*[;,]\s*/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/** Synonyme entre parenthèses dans le nom (« NFS (hémogramme) »), sans liste. */
function parentheticalSynonym(name: string): string | null {
  const match = /^(.+?)\s*\(([^()]{2,60})\)\s*$/.exec(name);
  if (!match) return null;
  const inner = match[2]!.trim();
  if (/[,;]/.test(inner) || /^\d/.test(inner)) return null;
  return inner;
}

export function extractCatalogRow(chunk: ExtractionChunk, tubes: TubeMatcher): BuildResult | null {
  const table = tableMetadata(chunk);
  if (!table || !table.catalog) return null;
  const cells = splitTableRow(chunk.content);
  if (!cells || cells.length !== table.header.length) return null;
  const { columns } = mapHeader(table.header);
  const candidates: Partial<Record<AnalysisField, FieldCandidate>> = {};
  columns.forEach((field, index) => {
    const cell = cells[index]!;
    if (!field || isEmptyCell(cell)) return;
    if (field === 'codes' || field === 'synonyms') {
      candidates[field] = { value: splitList(cell), quote: cell };
      return;
    }
    if (field === 'accepted_tubes' || field === 'rejected_tubes') {
      candidates[field] = { value: [cell], quote: cell };
      return;
    }
    if (field === 'volume' && /^\d+(?:[,.]\d+)?$/.test(cell)) {
      const unit = headerUnit(table.header[index]!);
      if (unit) {
        candidates[field] = { value: `${cell} ${unit}`, quote: cell, allowedExtra: unit };
        return;
      }
    }
    candidates[field] = { value: cell, quote: cell };
  });
  const name = candidates.name;
  if (name && typeof name.value === 'string' && !candidates.synonyms) {
    const synonym = parentheticalSynonym(name.value);
    if (synonym) candidates.synonyms = { value: [synonym], quote: name.value };
  }
  return buildAnalysis(chunk, candidates, tubes);
}
