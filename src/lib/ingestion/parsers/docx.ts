/**
 * DOCX -> pages logiques, via `mammoth` (HTML sémantique : titres, listes,
 * tableaux) puis un petit lecteur HTML limité aux balises que mammoth produit.
 *
 * Un DOCX n'a pas de pagination exploitable : le texte est découpé en
 * « pages » logiques aux titres de premier niveau (ou au-delà d'une taille
 * maximale), avec un libellé « Section … ».
 * Cellules fusionnées : rowspan -> valeur répétée sur chaque ligne couverte
 * (chaque ligne reste autonome), colspan -> cellules vides complémentaires.
 */
import { IngestionError } from '../errors';
import { PageTextBuilder, cleanInline } from '../text-layout';
import type { ParsedDocument, ParsedPage, ParseLimits } from '../types';

type Block =
  | { type: 'heading'; level: number; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'table'; rows: string[][] };

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity.toLowerCase()] ?? match;
  });
}

interface CellState {
  text: string;
  rowspan: number;
  colspan: number;
}

/** HTML de mammoth -> blocs. Tolérant : les balises inconnues sont ignorées. */
export function htmlToBlocks(html: string): Block[] {
  const blocks: Block[] = [];
  const tokenRe = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let text = '';
  let headingLevel = 0;
  let listDepth = 0;
  // Pile de tableaux (tableaux imbriqués aplatis dans la cellule parente).
  const tables: Array<{ rows: CellState[][]; row: CellState[] | null; cell: CellState | null }> = [];
  const currentTable = () => tables[tables.length - 1];

  const flushText = (kind: 'paragraph' | 'heading' | 'item') => {
    const value = cleanInline(text);
    text = '';
    if (!value) return;
    const table = currentTable();
    if (table?.cell) {
      table.cell.text = table.cell.text ? `${table.cell.text} ${value}` : value;
      return;
    }
    if (kind === 'heading') blocks.push({ type: 'heading', level: headingLevel || 1, text: value });
    else blocks.push({ type: 'paragraph', text: kind === 'item' ? `- ${value}` : value });
  };

  let match: RegExpExecArray | null;
  while ((match = tokenRe.exec(html)) !== null) {
    const [, closing, rawTag, attrs = '', rawText] = match;
    if (rawText !== undefined) {
      text += decodeEntities(rawText);
      continue;
    }
    const tag = rawTag!.toLowerCase();
    const isClosing = closing === '/';
    switch (tag) {
      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6':
        if (isClosing) {
          flushText('heading');
          headingLevel = 0;
        } else {
          flushText('paragraph');
          headingLevel = Number(tag.slice(1));
        }
        break;
      case 'p':
        if (isClosing) flushText(listDepth > 0 ? 'item' : headingLevel ? 'heading' : 'paragraph');
        else if (!currentTable()?.cell) flushText('paragraph');
        else text += ' ';
        break;
      case 'br':
        text += currentTable()?.cell ? ' ' : '\n';
        break;
      case 'ul':
      case 'ol':
        flushText(listDepth > 0 ? 'item' : 'paragraph');
        listDepth += isClosing ? -1 : 1;
        listDepth = Math.max(0, listDepth);
        break;
      case 'li':
        flushText('item');
        break;
      case 'table':
        if (isClosing) {
          const table = tables.pop();
          if (!table) break;
          const rows = expandSpans(table.rows);
          const parent = currentTable();
          if (parent?.cell) {
            const flat = rows.map((row) => row.filter(Boolean).join(' ; ')).join(' / ');
            parent.cell.text = parent.cell.text ? `${parent.cell.text} ${flat}` : flat;
          } else if (rows.length > 0) {
            blocks.push({ type: 'table', rows });
          }
        } else {
          flushText('paragraph');
          tables.push({ rows: [], row: null, cell: null });
        }
        break;
      case 'tr': {
        const table = currentTable();
        if (!table) break;
        if (isClosing) {
          if (table.row) table.rows.push(table.row);
          table.row = null;
        } else {
          table.row = [];
        }
        break;
      }
      case 'td':
      case 'th': {
        const table = currentTable();
        if (!table) break;
        if (isClosing) {
          flushText('paragraph');
          if (table.cell) (table.row ??= []).push(table.cell);
          table.cell = null;
        } else {
          const rowspan = Number(/rowspan="(\d+)"/i.exec(attrs)?.[1] ?? 1);
          const colspan = Number(/colspan="(\d+)"/i.exec(attrs)?.[1] ?? 1);
          table.cell = { text: '', rowspan: Math.max(1, Math.min(rowspan, 100)), colspan: Math.max(1, Math.min(colspan, 50)) };
        }
        break;
      }
      default:
        break;
    }
  }
  flushText('paragraph');
  return blocks;
}

/** Applique rowspan / colspan pour obtenir une grille rectangulaire. */
function expandSpans(rows: CellState[][]): string[][] {
  const grid: string[][] = [];
  const pending: Array<{ text: string; remaining: number } | undefined> = [];
  for (const row of rows) {
    const out: string[] = [];
    let column = 0;
    const takePending = () => {
      while (pending[column] && pending[column]!.remaining > 0) {
        out[column] = pending[column]!.text;
        pending[column]!.remaining -= 1;
        column += 1;
      }
    };
    for (const cell of row) {
      takePending();
      for (let span = 0; span < cell.colspan; span += 1) {
        out[column] = span === 0 ? cell.text : '';
        if (cell.rowspan > 1) pending[column] = { text: span === 0 ? cell.text : '', remaining: cell.rowspan - 1 };
        column += 1;
      }
    }
    takePending();
    grid.push(Array.from({ length: out.length }, (_, i) => out[i] ?? ''));
  }
  return grid;
}

/** Taille au-delà de laquelle une page logique est coupée au prochain bloc. */
const LOGICAL_PAGE_CHARS = 4000;

export function blocksToPages(blocks: Block[], options: { breakLevel: number }): ParsedPage[] {
  const pages: ParsedPage[] = [];
  let builder = new PageTextBuilder();
  let label: string | null = null;
  const flush = () => {
    if (builder.isEmpty) return;
    const pageNumber = pages.length + 1;
    pages.push(builder.build(pageNumber, label ? `Section « ${label} »` : `Section ${pageNumber}`));
    builder = new PageTextBuilder();
    label = null;
  };
  for (const block of blocks) {
    const breakAtHeading = block.type === 'heading' && block.level <= options.breakLevel && builder.length > 600;
    if (breakAtHeading || builder.length > LOGICAL_PAGE_CHARS) flush();
    if (block.type === 'heading') {
      label ??= block.text.slice(0, 80);
      builder.heading(block.text, block.level);
    } else if (block.type === 'paragraph') {
      builder.paragraph(block.text);
    } else {
      builder.table(block.rows);
    }
  }
  flush();
  return pages;
}

export async function parseDocx(bytes: Uint8Array, limits: ParseLimits): Promise<ParsedDocument> {
  const mammoth = (await import('mammoth')).default;
  let html: string;
  try {
    const result = await mammoth.convertToHtml(
      { buffer: Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength) },
      {
        styleMap: ["p[style-name='Title'] => h1:fresh", "p[style-name='Subtitle'] => h2:fresh"],
        ignoreEmptyParagraphs: true,
      },
    );
    html = result.value;
  } catch (error) {
    throw new IngestionError('corrupt_file', 'Le fichier DOCX est illisible ou endommagé.', { cause: error });
  }
  const blocks = htmlToBlocks(html);
  // Pages logiques coupées au niveau de titre le plus haut, sauf s'il n'apparaît
  // qu'une fois (titre du document) : on coupe alors au niveau suivant.
  const levels = blocks.flatMap((block) => (block.type === 'heading' ? [block.level] : []));
  const top = levels.length ? Math.min(...levels) : 1;
  const breakLevel = levels.filter((level) => level === top).length <= 1 ? top + 1 : top;
  const pages = blocksToPages(blocks, { breakLevel });
  if (pages.length > limits.maxPages) {
    throw new IngestionError(
      'too_many_pages',
      `Le document produit ${pages.length} sections ; la limite est de ${limits.maxPages}. Découpez le document.`,
    );
  }
  return { kind: 'docx', pages, warnings: [] };
}
