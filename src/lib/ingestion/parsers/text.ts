/**
 * TXT / Markdown -> pages logiques. Le texte est conservé tel quel (fins de
 * ligne normalisées) : les chunks restent des sous-chaînes exactes. Découpage
 * en pages au saut de page (\f) s'il existe, sinon par taille aux lignes vides.
 */
import { IngestionError } from '../errors';
import type { ParsedDocument, ParsedPage, ParseLimits } from '../types';

/** UTF-8 (BOM toléré) ; repli Windows-1252 si l'UTF-8 est invalide (exports Excel/Bloc-notes). */
export function decodeText(bytes: Uint8Array): string {
  let start = 0;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) start = 3;
  const body = bytes.subarray(start);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return new TextDecoder('windows-1252').decode(body);
  }
}

const TEXT_PAGE_CHARS = 4000;

export function splitTextPages(text: string): string[] {
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\u0000/g, '');
  const physical = normalized.split('\f');
  const pages: string[] = [];
  for (const part of physical) {
    const paragraphs = part.split(/\n{2,}/);
    let current = '';
    for (const paragraph of paragraphs) {
      const startsSection = /^#{1,2}\s/.test(paragraph);
      if (current && (current.length + paragraph.length > TEXT_PAGE_CHARS || (startsSection && current.length > 2500))) {
        pages.push(current);
        current = '';
      }
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
    if (current.trim()) pages.push(current);
  }
  return pages.map((page) => page.replace(/^\n+|\s+$/g, '')).filter((page) => page.trim().length > 0);
}

export function parseText(bytes: Uint8Array, limits: ParseLimits): ParsedDocument {
  const text = decodeText(bytes);
  const pageTexts = splitTextPages(text);
  if (pageTexts.length > limits.maxPages) {
    throw new IngestionError('too_many_pages', `Le texte produit ${pageTexts.length} pages ; la limite est de ${limits.maxPages}.`);
  }
  const pages: ParsedPage[] = pageTexts.map((pageText, index) => ({
    pageNumber: index + 1,
    text: pageText,
    label: pageTexts.length > 1 ? `Partie ${index + 1}` : null,
    tables: [],
    headings: [],
  }));
  return { kind: 'text', pages, warnings: [] };
}
