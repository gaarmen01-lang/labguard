/**
 * Découpage des pages en chunks.
 *
 * Règles :
 *  - un chunk ne déborde jamais d'une page ; son contenu est une sous-chaîne
 *    EXACTE du texte de la page (`content === page.slice(char_start, char_end)`),
 *    condition de la vérification des citations ;
 *  - prose : ~800-1200 caractères, coupée aux paragraphes puis aux phrases,
 *    nouveau chunk à chaque titre de section, léger recouvrement (dernière(s)
 *    phrase(s) du chunk précédent) quand une section est coupée ;
 *  - tableaux : jamais coupés au milieu d'une ligne. Tableau « catalogue »
 *    (une ligne = une analyse) : un chunk par ligne (`table_row`) ; autres
 *    tableaux : lignes groupées (`table`). Les en-têtes de colonnes sont
 *    répétés dans `heading` de chaque chunk de tableau (le contenu restant une
 *    sous-chaîne fidèle) et dans `metadata.table.header` ;
 *  - `heading` = chemin des titres (« 4. Catalogue > 4.1 Hématologie »).
 */
import type { ChunkKind } from '@/lib/contracts';

import { countKnownHeaders, mapHeader } from './analysis-fields';
import { findTableBlocks, type TableBlock } from './text-layout';
import type { ParsedHeading } from './types';

export interface ChunkerPage {
  pageNumber: number;
  text: string;
  /** Titres connus du parseur ; à défaut, heuristiques. */
  headings?: ParsedHeading[];
}

export interface ChunkTableMetadata {
  header: string[];
  /** Le tableau décrit des analyses (extraction déterministe possible). */
  catalog: boolean;
  /** Index (0-based, hors en-tête) des lignes de données couvertes. */
  rows: [number, number];
  /** L'en-tête vient d'un tableau précédent (tableau continué). */
  header_inherited?: boolean;
}

export interface ChunkMetadata {
  heading_path: string[];
  table?: ChunkTableMetadata;
  /** Lignes de la page couvertes (0-based, incluses). */
  lines: [number, number];
  /** Partie d'un paragraphe trop long coupé aux phrases. */
  split?: boolean;
  [key: string]: unknown;
}

export interface ChunkDraft {
  pageNumber: number;
  chunkIndex: number;
  kind: ChunkKind;
  heading: string | null;
  content: string;
  charStart: number;
  charEnd: number;
  metadata: ChunkMetadata;
}

export interface ChunkerOptions {
  targetChars: number;
  maxChars: number;
  overlapChars: number;
}

export const DEFAULT_CHUNKER_OPTIONS: ChunkerOptions = { targetChars: 1000, maxChars: 1200, overlapChars: 160 };

// --- Titres --------------------------------------------------------------------

const NUMBERED_HEADING_RE = /^((?:\d+|[A-Z])(?:\.\d+)*)\.?\s+\S/;
const MARKDOWN_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;

function isStandalone(lines: string[], index: number): boolean {
  const before = index === 0 || lines[index - 1]!.trim() === '';
  const after = index === lines.length - 1 || lines[index + 1]!.trim() === '';
  return before && after;
}

/** Titres repérés par heuristique (Markdown, titres numérotés isolés, annexes). */
export function detectHeadings(lines: string[]): ParsedHeading[] {
  const headings: ParsedHeading[] = [];
  lines.forEach((raw, index) => {
    const line = raw.trim();
    if (!line) return;
    const markdown = MARKDOWN_HEADING_RE.exec(line);
    if (markdown) {
      headings.push({ line: index, level: markdown[1]!.length, text: markdown[2]! });
      return;
    }
    if (!isStandalone(lines, index) || line.length > 100 || /[.;:,]$/.test(line) || line.includes(' | ')) return;
    const numbered = NUMBERED_HEADING_RE.exec(line);
    if (numbered && /\p{Lu}/u.test(line.charAt(numbered[0].length - 1))) {
      headings.push({ line: index, level: numbered[1]!.split('.').length, text: line });
      return;
    }
    if (/^(annexe|chapitre|partie|section)\s+\S+/i.test(line)) {
      headings.push({ line: index, level: 1, text: line });
    }
  });
  return headings;
}

// --- Unités --------------------------------------------------------------------

type Unit =
  | { type: 'heading'; start: number; end: number; firstLine: number; lastLine: number; level: number; text: string }
  | { type: 'paragraph'; start: number; end: number; firstLine: number; lastLine: number }
  | { type: 'table'; start: number; end: number; firstLine: number; lastLine: number; block: TableBlock };

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') offsets.push(i + 1);
  return offsets;
}

function buildUnits(text: string, headings: ParsedHeading[]): Unit[] {
  const lines = text.split('\n');
  const offsets = lineOffsets(text);
  const lineEnd = (index: number) => offsets[index]! + lines[index]!.length;
  const headingByLine = new Map(headings.map((heading) => [heading.line, heading]));
  const tables = findTableBlocks(lines);
  const tableByStart = new Map(tables.map((block) => [block.startLine, block]));
  const units: Unit[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.trim() === '') {
      index += 1;
      continue;
    }
    const table = tableByStart.get(index);
    if (table) {
      units.push({
        type: 'table',
        start: offsets[index]!,
        end: lineEnd(table.endLine),
        firstLine: index,
        lastLine: table.endLine,
        block: table,
      });
      index = table.endLine + 1;
      continue;
    }
    const heading = headingByLine.get(index);
    if (heading) {
      units.push({
        type: 'heading',
        start: offsets[index]!,
        end: lineEnd(index),
        firstLine: index,
        lastLine: index,
        level: heading.level,
        text: heading.text,
      });
      index += 1;
      continue;
    }
    // Paragraphe : lignes non vides consécutives (hors titres et tableaux).
    let last = index;
    while (
      last + 1 < lines.length &&
      lines[last + 1]!.trim() !== '' &&
      !headingByLine.has(last + 1) &&
      !tableByStart.has(last + 1)
    ) {
      last += 1;
    }
    units.push({ type: 'paragraph', start: offsets[index]!, end: lineEnd(last), firstLine: index, lastLine: last });
    index = last + 1;
  }
  return units;
}

// --- Découpage ------------------------------------------------------------------

/** Débuts de phrase dans [start, end) (positions absolues), hors `start`. */
function sentenceStarts(text: string, start: number, end: number): number[] {
  const starts: number[] = [];
  const re = /[.!?;:»)](\s+)(?=[\p{Lu}\d«(•-])/gu;
  const slice = text.slice(start, end);
  let match: RegExpExecArray | null;
  while ((match = re.exec(slice)) !== null) {
    starts.push(start + match.index + match[0].length);
  }
  // Fins de ligne (listes) : aussi des points de coupe.
  for (let i = start; i < end; i += 1) {
    if (text[i] === '\n' && i + 1 < end && text[i + 1] !== '\n') starts.push(i + 1);
  }
  return [...new Set(starts)].sort((a, b) => a - b);
}

function trimRange(text: string, start: number, end: number): [number, number] {
  let s = start;
  let e = end;
  while (s < e && /\s/.test(text[s]!)) s += 1;
  while (e > s && /\s/.test(text[e - 1]!)) e -= 1;
  return [s, e];
}

function lineOf(offsets: number[], position: number): number {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (offsets[mid]! <= position) low = mid;
    else high = mid - 1;
  }
  return low;
}

interface PreviousTable {
  header: string[];
  catalog: boolean;
}

/**
 * Découpe un document entier. Les titres et le dernier en-tête de tableau
 * sont reportés d'une page à l'autre (tableaux continués sans en-tête).
 */
export function chunkPages(pages: ChunkerPage[], options: ChunkerOptions = DEFAULT_CHUNKER_OPTIONS): ChunkDraft[] {
  const drafts: ChunkDraft[] = [];
  const headingStack: Array<{ level: number; text: string }> = [];
  /** Tableau qui terminait la page précédente (candidat à une suite). */
  let tableAtPageEnd: PreviousTable | null = null;

  for (const page of pages) {
    const { text } = page;
    if (!text.trim()) continue;
    const lines = text.split('\n');
    const offsets = lineOffsets(text);
    const headings = page.headings && page.headings.length > 0 ? page.headings : detectHeadings(lines);
    const units = buildUnits(text, headings);

    const path = () => headingStack.map((entry) => entry.text);
    const pathText = () => (headingStack.length ? path().join(' > ') : null);

    const emit = (
      kind: ChunkKind,
      rawStart: number,
      rawEnd: number,
      heading: string | null,
      extra: Partial<ChunkMetadata> = {},
    ) => {
      const [start, end] = trimRange(text, rawStart, rawEnd);
      if (end <= start) return;
      drafts.push({
        pageNumber: page.pageNumber,
        chunkIndex: drafts.length,
        kind,
        heading,
        content: text.slice(start, end),
        charStart: start,
        charEnd: end,
        metadata: {
          heading_path: path(),
          lines: [lineOf(offsets, start), lineOf(offsets, end - 1)],
          ...extra,
        },
      });
    };

    // Prose en cours : [start, end) et chemin de titres figé au début du chunk.
    let proseStart = -1;
    let proseEnd = -1;
    let proseHeading: string | null = null;
    let proseHasBody = false;
    const flushProse = () => {
      if (proseStart >= 0 && proseHasBody) emit('text', proseStart, proseEnd, proseHeading);
      proseStart = -1;
      proseEnd = -1;
      proseHasBody = false;
    };
    const startProse = (start: number) => {
      proseStart = start;
      proseHeading = pathText();
    };

    /** Coupe un paragraphe trop long aux phrases, avec recouvrement. */
    const addLongParagraph = (unitStart: number, unitEnd: number) => {
      const cuts = sentenceStarts(text, unitStart, unitEnd);
      let start = proseStart >= 0 ? proseStart : unitStart;
      if (proseStart < 0) startProse(unitStart);
      while (unitEnd - start > options.maxChars) {
        // Dernière coupe possible avant start + target (sinon avant max, sinon espace).
        const limit = start + options.targetChars;
        let cut = [...cuts].reverse().find((position) => position > start + options.targetChars * 0.5 && position <= limit);
        cut ??= [...cuts].reverse().find((position) => position > start && position <= start + options.maxChars);
        if (cut === undefined) {
          const space = text.lastIndexOf(' ', start + options.maxChars);
          cut = space > start ? space + 1 : start + options.maxChars;
        }
        emit('text', start, cut, proseHeading, { split: true });
        // Recouvrement : reprendre à la dernière phrase commencée dans la marge.
        const overlap = [...cuts].find((position) => position >= cut! - options.overlapChars && position < cut!);
        start = overlap ?? cut;
      }
      proseStart = start;
      proseEnd = unitEnd;
      proseHeading ??= pathText();
      proseHasBody = true;
    };

    let lastTable: PreviousTable | null = null;
    units.forEach((unit, unitIndex) => {
      if (unit.type === 'heading') {
        // Nouveau titre : on clôt le chunk sauf s'il ne contient que des titres.
        if (proseHasBody) flushProse();
        while (headingStack.length && headingStack[headingStack.length - 1]!.level >= unit.level) headingStack.pop();
        headingStack.push({ level: unit.level, text: unit.text });
        if (proseStart < 0) startProse(unit.start);
        proseEnd = unit.end;
        proseHeading = pathText();
        return;
      }

      if (unit.type === 'paragraph') {
        const length = unit.end - unit.start;
        const current = proseStart >= 0 ? proseEnd - proseStart : 0;
        if (proseHasBody && current + length + 2 > options.maxChars) {
          // Recouvrement : reprendre la dernière phrase du chunk précédent.
          const previousEnd = proseEnd;
          const cuts = sentenceStarts(text, proseStart, previousEnd);
          flushProse();
          const overlap = cuts.find((position) => position >= previousEnd - options.overlapChars && position < previousEnd);
          if (overlap !== undefined) startProse(overlap);
        }
        if (unit.end - (proseStart >= 0 ? proseStart : unit.start) > options.maxChars) {
          addLongParagraph(unit.start, unit.end);
          return;
        }
        if (proseStart < 0) startProse(unit.start);
        proseEnd = unit.end;
        proseHasBody = true;
        return;
      }

      // Tableau.
      const { block } = unit;
      let rows = block.rows;
      let rowLines = block.rowLines;
      let header = rows[0]!;
      let inherited = false;
      if (
        unitIndex === 0 &&
        tableAtPageEnd &&
        tableAtPageEnd.header.length === header.length &&
        countKnownHeaders(header) < 2 &&
        header.join('|') !== tableAtPageEnd.header.join('|')
      ) {
        // Suite (en haut de page) du tableau qui terminait la page précédente,
        // sans en-tête répété : on reprend son en-tête.
        header = tableAtPageEnd.header;
        inherited = true;
      } else {
        rows = rows.slice(1);
        rowLines = rowLines.slice(1);
      }
      const mapping = mapHeader(header);
      const headerLine = header.join(' | ');
      // Titre courant : on rattache le tableau au chunk de prose en cours
      // seulement s'il ne contient que des titres (ils restent dans heading).
      if (proseHasBody) flushProse();
      proseStart = -1;
      proseEnd = -1;
      const basePath = pathText();
      const heading = basePath ? `${basePath} — ${headerLine}` : headerLine;
      const headerStart = inherited ? null : offsets[block.startLine]!;

      if (mapping.isCatalog) {
        rows.forEach((_row, i) => {
          const line = rowLines[i]!;
          const start = offsets[line]!;
          emit('table_row', start, start + lines[line]!.length, heading, {
            table: { header, catalog: true, rows: [i, i], ...(inherited ? { header_inherited: true } : {}) },
          });
        });
      } else {
        let groupStart = headerStart ?? (rowLines[0] !== undefined ? offsets[rowLines[0]]! : unit.start);
        let groupFirstRow = 0;
        rows.forEach((_row, i) => {
          const line = rowLines[i]!;
          const lineEnd = offsets[line]! + lines[line]!.length;
          const nextLine = rowLines[i + 1];
          const nextEnd = nextLine !== undefined ? offsets[nextLine]! + lines[nextLine]!.length : null;
          const isLast = nextEnd === null;
          if (isLast || nextEnd - groupStart > options.maxChars) {
            emit('table', groupStart, lineEnd, heading, {
              table: { header, catalog: false, rows: [groupFirstRow, i], ...(inherited ? { header_inherited: true } : {}) },
            });
            if (!isLast) {
              groupStart = offsets[nextLine!]!;
              groupFirstRow = i + 1;
            }
          }
        });
      }
      lastTable = { header, catalog: mapping.isCatalog };
    });
    const lastUnit = units[units.length - 1];
    tableAtPageEnd = lastUnit?.type === 'table' ? lastTable : null;
    flushProse();
  }
  return drafts;
}
