/**
 * Convention de mise en texte des pages (cf. types.ts) : construction par les
 * parseurs (PageTextBuilder) et relecture par le découpage (splitTableRow,
 * findTableBlocks).
 */
import type { ParsedHeading, ParsedPage, ParsedTable } from './types';

export const CELL_SEPARATOR = ' | ';
export const EMPTY_CELL = '—';

/** Nettoie une cellule : espaces réduits, pas de « | », jamais vide. */
export function cleanCell(value: string): string {
  const cleaned = value.replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  return cleaned === '' ? EMPTY_CELL : cleaned;
}

export function isEmptyCell(value: string | undefined | null): boolean {
  if (value === undefined || value === null) return true;
  const trimmed = value.trim();
  return trimmed === '' || trimmed === EMPTY_CELL || trimmed === '-' || trimmed === '–';
}

/** Réduit les espaces d'une ligne de prose (sans toucher aux sauts de ligne). */
export function cleanInline(value: string): string {
  return value.replace(/[ \t ]+/g, ' ').trim();
}

export function renderRow(cells: string[]): string {
  return cells.map(cleanCell).join(CELL_SEPARATOR);
}

/** Retire les colonnes vides à droite et complète les lignes à la même largeur. */
export function normalizeTable(rows: string[][]): string[][] {
  let width = 0;
  for (const row of rows) {
    for (let i = row.length - 1; i >= 0; i -= 1) {
      if (!isEmptyCell(row[i])) {
        width = Math.max(width, i + 1);
        break;
      }
    }
  }
  return rows.map((row) => Array.from({ length: width }, (_, i) => row[i] ?? ''));
}

/**
 * Assemble le texte d'une page bloc par bloc en suivant la convention, et
 * mémorise les titres et tableaux.
 */
export class PageTextBuilder {
  private blocks: string[] = [];
  private lineCount = 0;
  private readonly headings: ParsedHeading[] = [];
  private readonly tables: ParsedTable[] = [];

  get length(): number {
    return this.blocks.reduce((sum, block) => sum + block.length + 2, 0);
  }

  get isEmpty(): boolean {
    return this.blocks.length === 0;
  }

  private push(block: string): number {
    const startLine = this.blocks.length === 0 ? 0 : this.lineCount + 1;
    this.blocks.push(block);
    this.lineCount = startLine + block.split('\n').length;
    return startLine;
  }

  heading(text: string, level: number): void {
    const cleaned = cleanInline(text);
    if (!cleaned) return;
    const line = this.push(cleaned);
    this.headings.push({ line, level: Math.max(1, Math.min(6, level)), text: cleaned });
  }

  paragraph(text: string): void {
    const cleaned = text
      .split('\n')
      .map(cleanInline)
      .filter((line) => line.length > 0)
      .join('\n');
    if (cleaned) this.push(cleaned);
  }

  /** `rows[0]` est l'en-tête. Un tableau d'une seule ligne est rendu en prose. */
  table(rows: string[][]): void {
    const normalized = normalizeTable(rows).filter((row) => row.some((cell) => !isEmptyCell(cell)));
    if (normalized.length === 0 || (normalized[0]?.length ?? 0) === 0) return;
    if (normalized.length < 2 || (normalized[0]?.length ?? 0) < 2) {
      for (const row of normalized) {
        this.paragraph(row.filter((cell) => !isEmptyCell(cell)).map(cleanCell).join(' '));
      }
      return;
    }
    this.push(normalized.map(renderRow).join('\n'));
    const [header, ...body] = normalized.map((row) => row.map(cleanCell));
    this.tables.push({ header: header!, rows: body });
  }

  build(pageNumber: number, label: string | null): ParsedPage {
    return {
      pageNumber,
      text: this.blocks.join('\n\n'),
      label,
      tables: this.tables,
      headings: this.headings,
    };
  }
}

// --- Relecture -------------------------------------------------------------------

const MD_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;

export function isMarkdownSeparator(line: string): boolean {
  return MD_SEPARATOR_RE.test(line);
}

/**
 * Cellules d'une ligne de tableau, ou null si la ligne n'en est pas une.
 * Accepte la convention LabGuard (`a | b`) et les tableaux Markdown (`| a | b |`).
 */
export function splitTableRow(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes('|')) return null;
  const markdown = trimmed.startsWith('|') && trimmed.endsWith('|') && trimmed.length > 1;
  if (!markdown && !trimmed.includes(CELL_SEPARATOR)) return null;
  let body = trimmed;
  if (markdown) body = body.slice(1, -1);
  const cells = body.split('|').map((cell) => cell.trim());
  return cells.length >= 2 ? cells : null;
}

export interface TableBlock {
  /** Index de la première et de la dernière ligne (incluses). */
  startLine: number;
  endLine: number;
  /** Index des lignes de données (hors séparateurs Markdown), en-tête compris. */
  rowLines: number[];
  rows: string[][];
}

/**
 * Blocs de tableau : au moins deux lignes consécutives découpables avec le même
 * nombre de cellules (les séparateurs Markdown sont tolérés).
 */
export function findTableBlocks(lines: string[]): TableBlock[] {
  const blocks: TableBlock[] = [];
  let current: TableBlock | null = null;
  const close = () => {
    if (current && current.rows.length >= 2) blocks.push(current);
    current = null;
  };
  lines.forEach((line, index) => {
    if (current && isMarkdownSeparator(line)) {
      current.endLine = index;
      return;
    }
    const cells = splitTableRow(line);
    if (!cells) {
      close();
      return;
    }
    const block = current as TableBlock | null;
    if (block && block.rows[0]!.length === cells.length) {
      block.endLine = index;
      block.rowLines.push(index);
      block.rows.push(cells);
      return;
    }
    close();
    current = { startLine: index, endLine: index, rowLines: [index], rows: [cells] };
  });
  close();
  return blocks;
}
