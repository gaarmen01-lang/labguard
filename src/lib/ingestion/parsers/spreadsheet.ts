/**
 * XLSX et CSV -> pages : une feuille = une page (découpée en plusieurs pages
 * au-delà de MAX_ROWS_PER_PAGE lignes, en-tête répété). La ligne d'en-tête est
 * détectée (titres éventuels au-dessus rendus en prose) ; une ligne qui n'a
 * qu'une cellule au milieu d'un tableau est traitée comme un intertitre.
 */
import { IngestionError } from '../errors';
import { matchHeaderField } from '../analysis-fields';
import { PageTextBuilder, isEmptyCell, normalizeTable } from '../text-layout';
import type { ParsedDocument, ParsedPage, ParseLimits } from '../types';
import { decodeText } from './text';

export const MAX_ROWS_PER_PAGE = 300;

type RawCell = string | number | boolean | Date | null | undefined;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function formatCell(value: RawCell): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${pad(value.getUTCDate())}/${pad(value.getUTCMonth() + 1)}/${value.getUTCFullYear()}`;
  }
  if (typeof value === 'boolean') return value ? 'oui' : 'non';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return '';
    const rounded = Math.round(value * 1e6) / 1e6;
    return String(rounded).replace('.', ',');
  }
  return value.replace(/\s+/g, ' ').trim();
}

function nonEmptyCount(row: string[]): number {
  return row.filter((cell) => !isEmptyCell(cell)).length;
}

/**
 * Index de la ligne d'en-tête parmi les premières lignes : de préférence une
 * ligne dont plusieurs cellules sont des intitulés connus ; sinon la première
 * ligne d'au moins deux cellules textuelles suivie d'une ligne d'au moins deux
 * cellules. -1 si aucune (feuille de prose).
 */
export function detectHeaderRow(rows: string[][]): number {
  const limit = Math.min(rows.length, 20);
  let best = -1;
  let bestScore = 0;
  for (let i = 0; i < limit; i += 1) {
    const row = rows[i]!;
    const filled = row.filter((cell) => !isEmptyCell(cell));
    if (filled.length < 2) continue;
    const known = filled.filter((cell) => matchHeaderField(cell) !== null).length;
    const textual = filled.filter((cell) => !/^[\d\s,.%/-]+$/.test(cell)).length;
    if (known >= 2 && known > bestScore) {
      best = i;
      bestScore = known;
    }
    if (best === -1 && textual === filled.length && nonEmptyCount(rows[i + 1] ?? []) >= 2) {
      return i;
    }
  }
  return best;
}

export function sheetToPages(
  rawRows: string[][],
  sheetLabel: string | null,
  firstPageNumber: number,
): ParsedPage[] {
  const rows = normalizeTable(rawRows).filter((row) => nonEmptyCount(row) > 0);
  if (rows.length === 0) return [];
  const headerIndex = detectHeaderRow(rows);
  const pages: ParsedPage[] = [];
  const preamble = headerIndex > 0 ? rows.slice(0, headerIndex) : headerIndex === -1 ? rows : [];
  const header = headerIndex >= 0 ? rows[headerIndex]! : null;
  const body = headerIndex >= 0 ? rows.slice(headerIndex + 1) : [];

  let builder = new PageTextBuilder();
  for (const row of preamble) {
    const filled = row.filter((cell) => !isEmptyCell(cell));
    if (header === null && filled.length >= 2) {
      // Feuille sans en-tête reconnu : chaque ligne en prose « a — b ».
      builder.paragraph(filled.join(' — '));
    } else {
      builder.paragraph(filled.join(' '));
    }
  }
  if (header) {
    const width = header.length;
    let tableRows: string[][] = [];
    let rowsOnPage = 0;
    const flushTable = () => {
      if (tableRows.length > 0) builder.table([header, ...tableRows]);
      tableRows = [];
    };
    const flushPage = () => {
      flushTable();
      const pageNumber = firstPageNumber + pages.length;
      const label = sheetLabel ?? null;
      pages.push(builder.build(pageNumber, label && pages.length > 0 ? `${label} (suite ${pages.length + 1})` : label));
      builder = new PageTextBuilder();
      rowsOnPage = 0;
    };
    for (const row of body) {
      const filled = nonEmptyCount(row);
      if (filled === 1 && width > 2 && !isEmptyCell(row[0])) {
        // Intertitre dans le tableau (« Hématologie »).
        flushTable();
        builder.heading(row[0]!, 2);
        continue;
      }
      tableRows.push(row);
      rowsOnPage += 1;
      if (rowsOnPage >= MAX_ROWS_PER_PAGE) flushPage();
    }
    flushTable();
  }
  if (!builder.isEmpty) {
    const pageNumber = firstPageNumber + pages.length;
    pages.push(builder.build(pageNumber, sheetLabel && pages.length > 0 ? `${sheetLabel} (suite ${pages.length + 1})` : sheetLabel));
  }
  return pages;
}

// --- XLSX ----------------------------------------------------------------------

export async function parseXlsx(bytes: Uint8Array, limits: ParseLimits): Promise<ParsedDocument> {
  const { default: readXlsxFile } = await import('read-excel-file/node');
  let sheets: Array<{ sheet: string; data: RawCell[][] }>;
  try {
    sheets = (await readXlsxFile(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))) as Array<{
      sheet: string;
      data: RawCell[][];
    }>;
  } catch (error) {
    throw new IngestionError('corrupt_file', 'Le classeur XLSX est illisible ou endommagé.', { cause: error });
  }
  const pages: ParsedPage[] = [];
  const warnings: string[] = [];
  for (const sheet of sheets) {
    const rows = sheet.data.map((row) => row.map(formatCell));
    const sheetPages = sheetToPages(rows, `Feuille « ${sheet.sheet} »`, pages.length + 1);
    if (sheetPages.length === 0) warnings.push(`La feuille « ${sheet.sheet} » est vide : ignorée.`);
    pages.push(...sheetPages);
    if (pages.length > limits.maxPages) {
      throw new IngestionError('too_many_pages', `Le classeur produit plus de ${limits.maxPages} pages. Découpez-le.`);
    }
  }
  return { kind: 'xlsx', pages, warnings };
}

// --- CSV -----------------------------------------------------------------------

/** Séparateur le plus régulier parmi « ; », « , » et tabulation (hors guillemets). */
export function detectDelimiter(text: string): string {
  const lines = text.split(/\r?\n/).filter((line) => line.trim() && !line.startsWith('#')).slice(0, 20);
  let best = ';';
  let bestScore = -1;
  for (const delimiter of [';', ',', '\t']) {
    const counts = lines.map((line) => {
      let count = 0;
      let quoted = false;
      for (const char of line) {
        if (char === '"') quoted = !quoted;
        else if (char === delimiter && !quoted) count += 1;
      }
      return count;
    });
    const nonZero = counts.filter((count) => count > 0);
    if (nonZero.length === 0) continue;
    const mode = nonZero.sort((a, b) => nonZero.filter((v) => v === b).length - nonZero.filter((v) => v === a).length)[0]!;
    const score = counts.filter((count) => count === mode).length * 10 + mode;
    if (score > bestScore) {
      best = delimiter;
      bestScore = score;
    }
  }
  return best;
}

/** Lecteur CSV RFC 4180 (guillemets, guillemets doublés, sauts de ligne dans les champs). */
export function parseCsvRows(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }
    if (char === '"' && field.trim() === '') {
      quoted = true;
      field = '';
    } else if (char === delimiter) {
      row.push(field);
      field = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += char;
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

export function parseCsv(bytes: Uint8Array, limits: ParseLimits): ParsedDocument {
  const text = decodeText(bytes);
  const delimiter = detectDelimiter(text);
  const rows = parseCsvRows(text, delimiter).map((row) =>
    row.length === 1 && row[0]!.startsWith('#') ? [row[0]!.replace(/^#\s*/, '')] : row.map((cell) => formatCell(cell)),
  );
  const pages = sheetToPages(rows, null, 1);
  if (pages.length > limits.maxPages) {
    throw new IngestionError('too_many_pages', `Le fichier CSV produit plus de ${limits.maxPages} pages. Découpez-le.`);
  }
  return { kind: 'csv', pages, warnings: [] };
}
