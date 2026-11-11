/**
 * PDF texte -> pages. Reconstruit lignes, paragraphes, titres et tableaux à
 * partir de la position des fragments de texte (pdf.js via `unpdf`, build
 * serverless sans dépendance native).
 *
 * Tableaux : des lignes visuelles dont les fragments s'alignent sur les mêmes
 * débuts de colonnes forment une région ; une cellule sur plusieurs lignes
 * visuelles est recollée à sa ligne de tableau (un saut vertical plus grand
 * que l'interligne marque une nouvelle ligne de tableau ; à défaut, une ligne
 * sans texte en première colonne est une continuation). Chaque ligne de
 * tableau devient une ligne de texte « a | b | c » : les cellules de lignes
 * voisines ne sont jamais mélangées.
 *
 * Limites connues : cellules centrées ou à droite, tableaux sans espace entre
 * colonnes, mise en page multi-colonnes ; aucune OCR (PDF scanné refusé).
 */
import { IngestionError } from '../errors';
import { PageTextBuilder, cleanInline } from '../text-layout';
import type { ParsedDocument, ParsedPage, ParseLimits } from '../types';

interface RawItem {
  str: string;
  x: number;
  y: number;
  width: number;
  size: number;
}

interface Segment {
  x: number;
  end: number;
  text: string;
  size: number;
}

interface VisualLine {
  y: number;
  size: number;
  segments: Segment[];
}

const BULLET_RE = /^[•◦▪▫●■□○·\-–*]$/u;

function joinFragments(left: string, right: string): string {
  if (!left) return right;
  if (!right) return left;
  // Coupure après un trait d'union (« D-» + « dimères », « ABO-» + « RhD ») : recollé sans espace.
  if (/[\p{L}\p{N}]-$/u.test(left) && /^[\p{L}\p{N}]/u.test(right)) return left + right;
  return `${left} ${right}`;
}

/** Fragments -> lignes visuelles (même ligne de base) -> segments (blocs séparés par un grand espace). */
function buildLines(items: RawItem[]): VisualLine[] {
  const sorted = items
    .filter((item) => item.str.trim().length > 0)
    .sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: Array<{ y: number; size: number; items: RawItem[] }> = [];
  for (const item of sorted) {
    const tolerance = Math.max(1.5, item.size * 0.3);
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= tolerance);
    if (line) {
      line.items.push(item);
      line.size = Math.max(line.size, item.size);
    } else {
      lines.push({ y: item.y, size: item.size, items: [item] });
    }
  }
  lines.sort((a, b) => b.y - a.y);
  return lines.map((line) => {
    const lineItems = line.items.sort((a, b) => a.x - b.x);
    const segments: Segment[] = [];
    for (const item of lineItems) {
      const text = item.str.replace(/\s+/g, ' ');
      const last = segments[segments.length - 1];
      const gap = last ? item.x - last.end : Number.POSITIVE_INFINITY;
      const splitGap = Math.max(4, 0.8 * item.size);
      if (last && gap < splitGap) {
        last.text = gap > item.size * 0.12 ? `${last.text.trimEnd()} ${text.trimStart()}` : last.text + text;
        last.end = Math.max(last.end, item.x + item.width);
      } else {
        segments.push({ x: item.x, end: item.x + item.width, text, size: item.size });
      }
    }
    // Puce isolée en début de ligne, suivie du texte de l'élément : un seul segment.
    const first = segments[0];
    const second = segments[1];
    if (first && second && BULLET_RE.test(first.text.trim()) && second.x - first.end < first.size * 2.5) {
      second.text = `${first.text.trim()} ${second.text.trim()}`;
      second.x = first.x;
      segments.shift();
    }
    for (const segment of segments) segment.text = cleanInline(segment.text);
    return { y: line.y, size: line.size, segments: segments.filter((segment) => segment.text.length > 0) };
  });
}

interface TableRegion {
  lines: VisualLine[];
  columns: number[];
}

const ALIGN_TOLERANCE = 3;

function columnIndex(columns: number[], x: number): number {
  for (let i = columns.length - 1; i >= 0; i -= 1) {
    if (x >= columns[i]! - ALIGN_TOLERANCE) return i;
  }
  return 0;
}

function isAligned(columns: number[], x: number): boolean {
  return columns.some((start) => Math.abs(start - x) <= ALIGN_TOLERANCE);
}

/** La ligne prolonge-t-elle la région de tableau en cours ? */
function continuesRegion(region: TableRegion, line: VisualLine): boolean {
  const previous = region.lines[region.lines.length - 1]!;
  const gap = previous.y - line.y;
  if (gap > Math.max(previous.size, line.size) * 3.2) return false;
  if (line.segments.length >= 2) {
    const aligned = line.segments.filter((segment) => isAligned(region.columns, segment.x)).length;
    return aligned >= Math.ceil(line.segments.length / 2);
  }
  // Une seule cellule : continuation d'une cellule (ou cellule seule d'une
  // ligne) si elle commence sur une colonne et ne déborde pas sur la suivante.
  const segment = line.segments[0]!;
  if (!isAligned(region.columns, segment.x)) return false;
  const index = columnIndex(region.columns, segment.x);
  const nextStart = region.columns[index + 1];
  if (nextStart !== undefined) return segment.end <= nextStart + ALIGN_TOLERANCE;
  // Dernière colonne : on n'accepte pas une ligne de prose qui démarrerait là.
  return region.columns.length >= 2 && index > 0;
}

function addColumns(columns: number[], line: VisualLine): number[] {
  const next = [...columns];
  for (const segment of line.segments) {
    if (!isAligned(next, segment.x)) next.push(segment.x);
  }
  return next.sort((a, b) => a - b);
}

/** Région -> lignes de tableau (cellules recollées). Null si ce n'est pas un vrai tableau. */
function regionToRows(region: TableRegion): string[][] | null {
  const { lines, columns } = region;
  if (columns.length < 2) return null;
  const pitches = lines.slice(1).map((line, i) => lines[i]!.y - line.y);
  const minPitch = pitches.length ? Math.min(...pitches) : 0;
  const hasRowSpacing = pitches.some((pitch) => pitch > minPitch * 1.3);
  const rows: string[][] = [];
  lines.forEach((line, i) => {
    const hasFirstColumn = line.segments.some((segment) => columnIndex(columns, segment.x) === 0);
    const pitch = i === 0 ? Number.POSITIVE_INFINITY : pitches[i - 1]!;
    const startsRow =
      i === 0 || (hasRowSpacing ? pitch > minPitch * 1.3 : hasFirstColumn);
    if (startsRow) rows.push(columns.map(() => ''));
    const row = rows[rows.length - 1]!;
    for (const segment of line.segments) {
      const index = columnIndex(columns, segment.x);
      row[index] = joinFragments(row[index]!, segment.text);
    }
  });
  if (rows.length < 2) return null;
  return rows;
}

function lineText(line: VisualLine): string {
  return line.segments.map((segment) => segment.text).join(' ');
}

/** Lignes (haut/bas de page) répétées sur la majorité des pages : en-têtes / pieds. */
function findRepeatedMargins(pages: VisualLine[][]): Set<string> {
  const repeated = new Set<string>();
  if (pages.length < 2) return repeated;
  const counts = new Map<string, number>();
  for (const lines of pages) {
    const candidates = new Set<string>();
    for (const line of [...lines.slice(0, 2), ...lines.slice(-2)]) {
      candidates.add(lineText(line).replace(/\d+/g, '#'));
    }
    for (const key of candidates) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  for (const [key, count] of counts) {
    if (count >= Math.max(2, Math.ceil(pages.length * 0.6))) repeated.add(key);
  }
  return repeated;
}

function layoutPage(lines: VisualLine[], bodySize: number, headingSizes: number[], pageNumber: number): ParsedPage {
  const builder = new PageTextBuilder();
  let paragraph: string[] = [];
  let paragraphLast: VisualLine | null = null;
  const flushParagraph = () => {
    if (paragraph.length) builder.paragraph(paragraph.join('\n'));
    paragraph = [];
    paragraphLast = null;
  };
  let region: TableRegion | null = null;
  const flushRegion = () => {
    if (!region) return;
    const rows = regionToRows(region);
    if (rows) {
      flushParagraph();
      builder.table(rows);
    } else {
      for (const line of region.lines) addProse(line);
    }
    region = null;
  };
  let pendingHeading: { text: string; size: number; y: number } | null = null;
  const flushHeading = () => {
    if (!pendingHeading) return;
    const level = Math.max(1, headingSizes.findIndex((size) => Math.abs(size - pendingHeading!.size) < 0.6) + 1);
    builder.heading(pendingHeading.text, level);
    pendingHeading = null;
  };
  const addProse = (line: VisualLine) => {
    const text = lineText(line);
    const isHeading = line.size >= bodySize * 1.1 && text.length <= 150;
    if (isHeading) {
      flushParagraph();
      if (pendingHeading && Math.abs(pendingHeading.size - line.size) < 0.6 && pendingHeading.y - line.y < line.size * 1.6) {
        pendingHeading.text = `${pendingHeading.text} ${text}`;
        pendingHeading.y = line.y;
        return;
      }
      flushHeading();
      pendingHeading = { text, size: line.size, y: line.y };
      return;
    }
    flushHeading();
    const last = paragraphLast as VisualLine | null;
    const startsItem = BULLET_RE.test(text.charAt(0)) && text.charAt(1) === ' ';
    const gap = last ? last.y - line.y : 0;
    const newParagraph = !last || gap > line.size * 1.65 || Math.abs(last.size - line.size) > 0.6;
    if (newParagraph) {
      flushParagraph();
      paragraph = [text];
    } else if (startsItem) {
      paragraph.push(text);
    } else {
      const index = paragraph.length - 1;
      paragraph[index] = joinFragments(paragraph[index]!, text);
    }
    paragraphLast = line;
  };

  for (const line of lines) {
    const current = region as TableRegion | null;
    if (current && continuesRegion(current, line)) {
      current.lines.push(line);
      if (line.segments.length >= 2) current.columns = addColumns(current.columns, line);
      continue;
    }
    flushRegion();
    if (line.segments.length >= 2) {
      flushHeading();
      region = { lines: [line], columns: addColumns([], line) };
      continue;
    }
    addProse(line);
  }
  flushRegion();
  flushHeading();
  flushParagraph();
  return builder.build(pageNumber, `p. ${pageNumber}`);
}

export const SCANNED_PDF_MESSAGE =
  "Ce PDF ne contient pas de texte exploitable : il s'agit probablement d'un document scanné (image). " +
  "La reconnaissance de caractères (OCR) n'est pas prise en charge : importez un PDF texte (export depuis le traitement de texte) ou un fichier DOCX.";

export async function parsePdf(bytes: Uint8Array, limits: ParseLimits): Promise<ParsedDocument> {
  const { getDocumentProxy } = await import('unpdf');
  let pdf: Awaited<ReturnType<typeof getDocumentProxy>>;
  try {
    // Copie : pdf.js peut transférer (détacher) le tampon fourni.
    pdf = await getDocumentProxy(new Uint8Array(bytes), { verbosity: 0 });
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    if (name === 'PasswordException') {
      throw new IngestionError('encrypted_pdf', 'Ce PDF est protégé par un mot de passe : importez une version non protégée.', {
        cause: error,
      });
    }
    throw new IngestionError('corrupt_file', 'Le PDF est illisible ou endommagé.', { cause: error });
  }
  try {
    if (pdf.numPages > limits.maxPages) {
      throw new IngestionError(
        'too_many_pages',
        `Le PDF compte ${pdf.numPages} pages ; la limite est de ${limits.maxPages} pages. Découpez le document.`,
      );
    }
    const pagesLines: VisualLine[][] = [];
    for (let pageNumber = 1; pageNumber <= pdf.numPages; pageNumber += 1) {
      const page = await pdf.getPage(pageNumber);
      const content = await page.getTextContent();
      const items: RawItem[] = [];
      for (const item of content.items) {
        if (!('str' in item)) continue;
        const [a = 0, b = 0, , , x = 0, y = 0] = item.transform as number[];
        const size = item.height || Math.hypot(a, b);
        items.push({ str: item.str, x, y, width: item.width, size });
      }
      pagesLines.push(buildLines(items));
      page.cleanup();
    }

    const repeated = findRepeatedMargins(pagesLines);
    const cleaned = pagesLines.map((lines) =>
      lines.filter((line, index) => {
        const nearEdge = index < 2 || index >= lines.length - 2;
        return !(nearEdge && repeated.has(lineText(line).replace(/\d+/g, '#')));
      }),
    );

    // Taille du corps de texte = taille la plus fréquente (pondérée par les caractères).
    const weights = new Map<number, number>();
    for (const lines of cleaned) {
      for (const line of lines) {
        const key = Math.round(line.size * 2) / 2;
        weights.set(key, (weights.get(key) ?? 0) + lineText(line).length);
      }
    }
    const bodySize = [...weights.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? 10;
    const headingSizes = [...weights.keys()].filter((size) => size >= bodySize * 1.1).sort((a, b) => b - a);

    const pages = cleaned.map((lines, index) => layoutPage(lines, bodySize, headingSizes, index + 1));
    const totalChars = pages.reduce((sum, page) => sum + page.text.replace(/\s+/g, '').length, 0);
    const pagesWithText = pages.filter((page) => page.text.replace(/\s+/g, '').length >= 20).length;
    if (pagesWithText === 0 || totalChars < 40 * pages.length * 0.1) {
      throw new IngestionError('scanned_pdf', SCANNED_PDF_MESSAGE, { retryable: false });
    }
    const warnings: string[] = [];
    const empty = pages.filter((page) => page.text.replace(/\s+/g, '').length < 20).map((page) => page.pageNumber);
    if (empty.length > 0) {
      warnings.push(
        `Pages sans texte exploitable (scannées ?) : ${empty.join(', ')}. Leur contenu n'est pas indexé.`,
      );
    }
    return { kind: 'pdf', pages, warnings };
  } finally {
    await (pdf as { destroy?: () => Promise<void> }).destroy?.().catch(() => undefined);
  }
}
