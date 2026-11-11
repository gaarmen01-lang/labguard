/**
 * Détection du type réel d'un fichier par sa signature (et non par son
 * extension ou le type MIME déclaré par le navigateur).
 */
import { unzipSync } from 'fflate';

import type { SupportedMimeType } from '@/lib/contracts';

import { IngestionError } from './errors';
import type { FileKind } from './types';

export const MIME_BY_KIND: Record<FileKind, SupportedMimeType> = {
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  text: 'text/plain',
};

const EXTENSIONS: Record<string, FileKind> = {
  pdf: 'pdf',
  docx: 'docx',
  xlsx: 'xlsx',
  csv: 'csv',
  txt: 'text',
  md: 'text',
  markdown: 'text',
};

export function kindFromFilename(filename: string): FileKind | null {
  const extension = /\.([a-z0-9]+)$/i.exec(filename.trim())?.[1]?.toLowerCase();
  return extension ? (EXTENSIONS[extension] ?? null) : null;
}

export function kindFromMime(mime: string): FileKind | null {
  const entry = (Object.entries(MIME_BY_KIND) as Array<[FileKind, string]>).find(([, value]) => value === mime);
  return entry?.[0] ?? null;
}

function startsWith(bytes: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, i) => bytes[i] === byte);
}

/** Noms des entrées d'une archive ZIP (sans décompresser le contenu). */
function zipEntryNames(bytes: Uint8Array): string[] {
  const names: string[] = [];
  try {
    unzipSync(bytes, {
      filter(file) {
        names.push(file.name);
        return false;
      },
    });
  } catch {
    return [];
  }
  return names;
}

function looksLikeText(bytes: Uint8Array): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  let control = 0;
  for (const byte of sample) {
    if (byte === 0) return false;
    if (byte < 9 || (byte > 13 && byte < 32)) control += 1;
  }
  return control <= sample.length * 0.01;
}

/** Type réel du contenu, ou null s'il n'est pas pris en charge. */
export function sniffKind(bytes: Uint8Array): Exclude<FileKind, 'csv'> | 'text' | null {
  if (bytes.length === 0) return null;
  // « %PDF- » (éventuellement précédé de quelques octets parasites).
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, 1024));
  if (head.includes('%PDF-')) return 'pdf';
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    const names = zipEntryNames(bytes);
    if (names.includes('word/document.xml')) return 'docx';
    if (names.includes('xl/workbook.xml')) return 'xlsx';
    return null;
  }
  // Formats binaires courants refusés explicitement (OLE2 .doc/.xls, images).
  if (startsWith(bytes, [0xd0, 0xcf, 0x11, 0xe0])) return null;
  if (looksLikeText(bytes)) return 'text';
  return null;
}

/**
 * Vérifie que le contenu correspond au type déclaré et renvoie le type de
 * parseur à utiliser. CSV et TXT partagent la signature « texte » : le type
 * déclaré (vérifié à l'import contre l'extension) départage.
 */
export function resolveFileKind(bytes: Uint8Array, declaredMime: string | null, filename: string | null): FileKind {
  const declared = declaredMime ? kindFromMime(declaredMime) : null;
  const fromName = filename ? kindFromFilename(filename) : null;
  const expected = declared ?? fromName;
  const sniffed = sniffKind(bytes);
  if (sniffed === null) {
    throw new IngestionError(
      'unsupported_type',
      'Type de fichier non pris en charge ou fichier endommagé. Formats acceptés : PDF (texte), DOCX, XLSX, CSV, TXT, Markdown.',
    );
  }
  if (sniffed === 'text') {
    if (expected === 'csv' || expected === 'text') return expected;
    if (expected === null) return fromName === 'csv' ? 'csv' : 'text';
  } else if (expected === null || expected === sniffed) {
    return sniffed;
  }
  throw new IngestionError(
    'type_mismatch',
    `Le contenu du fichier (${LABELS[sniffed]}) ne correspond pas au type déclaré (${expected ? LABELS[expected] : 'inconnu'}).`,
  );
}

const LABELS: Record<FileKind, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  xlsx: 'XLSX',
  csv: 'CSV',
  text: 'texte',
};
