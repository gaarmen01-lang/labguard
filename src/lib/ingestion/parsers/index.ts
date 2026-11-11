/**
 * Point d'entrée des parseurs : contrôle des limites et du type réel, puis
 * parseur dédié. Tous renvoient la représentation commune (types.ts).
 */
import { MAX_UPLOAD_BYTES } from '@/lib/contracts';

import { resolveFileKind } from '../detect';
import { IngestionError } from '../errors';
import type { ParsedDocument, ParseLimits } from '../types';
import { parseDocx } from './docx';
import { parsePdf } from './pdf';
import { parseCsv, parseXlsx } from './spreadsheet';
import { parseText } from './text';

export { SCANNED_PDF_MESSAGE } from './pdf';
export { detectDelimiter, detectHeaderRow, parseCsvRows, MAX_ROWS_PER_PAGE } from './spreadsheet';
export { decodeText } from './text';

export const DEFAULT_PARSE_LIMITS: ParseLimits = {
  maxBytes: MAX_UPLOAD_BYTES,
  maxPages: 300,
  maxChars: 3_000_000,
};

export interface ParseInput {
  bytes: Uint8Array;
  /** Type MIME déclaré à l'import (documents.mime_type). */
  mimeType: string | null;
  filename: string | null;
}

function formatMegabytes(bytes: number): string {
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} Mo`;
}

export async function parseDocument(input: ParseInput, limits: ParseLimits = DEFAULT_PARSE_LIMITS): Promise<ParsedDocument> {
  const { bytes } = input;
  if (bytes.byteLength === 0) {
    throw new IngestionError('empty_document', 'Le fichier est vide.');
  }
  if (bytes.byteLength > limits.maxBytes) {
    throw new IngestionError(
      'too_large',
      `Le fichier pèse ${formatMegabytes(bytes.byteLength)} ; la limite est de ${formatMegabytes(limits.maxBytes)}.`,
    );
  }
  const kind = resolveFileKind(bytes, input.mimeType, input.filename);
  let parsed: ParsedDocument;
  switch (kind) {
    case 'pdf':
      parsed = await parsePdf(bytes, limits);
      break;
    case 'docx':
      parsed = await parseDocx(bytes, limits);
      break;
    case 'xlsx':
      parsed = await parseXlsx(bytes, limits);
      break;
    case 'csv':
      parsed = parseCsv(bytes, limits);
      break;
    case 'text':
      parsed = parseText(bytes, limits);
      break;
  }
  const totalChars = parsed.pages.reduce((sum, page) => sum + page.text.length, 0);
  if (parsed.pages.length === 0 || parsed.pages.every((page) => page.text.trim().length === 0)) {
    throw new IngestionError('empty_document', "Aucun texte n'a pu être extrait de ce fichier.");
  }
  if (totalChars > limits.maxChars) {
    throw new IngestionError(
      'too_large',
      `Le texte extrait compte ${totalChars} caractères ; la limite est de ${limits.maxChars}. Découpez le document.`,
    );
  }
  if (parsed.pages.length > limits.maxPages) {
    throw new IngestionError('too_many_pages', `Le document compte ${parsed.pages.length} pages ; la limite est de ${limits.maxPages}.`);
  }
  return parsed;
}
