/**
 * Découpage : sous-chaînes fidèles du texte de page, lignes de tableau jamais
 * coupées, en-têtes de colonnes répétés, prose ~800-1200 caractères avec
 * recouvrement, titres conservés comme contexte.
 */
import { describe, expect, it } from 'vitest';

import { quoteAppearsIn } from '@/lib/contracts';
import { chunkPages, detectHeadings, parseDocument, splitTableRow, type ChunkDraft, type ParsedDocument } from '@/lib/ingestion';

import { corpusFile, mimeFor } from './helpers/ingest';

const FILES = [
  'manuel-prelevement-v3.pdf',
  'manuel-prelevement-v2.pdf',
  'procedure-non-conformites.docx',
  'catalogue-analyses.xlsx',
  'analyses-specialisees.csv',
  'consignes-transport.md',
];

async function parsed(filename: string): Promise<ParsedDocument> {
  return parseDocument({ bytes: corpusFile(filename), mimeType: mimeFor(filename), filename });
}

function chunksOf(document: ParsedDocument): ChunkDraft[] {
  return chunkPages(document.pages.map((page) => ({ pageNumber: page.pageNumber, text: page.text, headings: page.headings })));
}

describe.each(FILES)('%s', (filename) => {
  it('chaque chunk est une sous-chaîne exacte de sa page, aux positions annoncées', async () => {
    const document = await parsed(filename);
    const chunks = chunksOf(document);
    expect(chunks.length).toBeGreaterThan(0);
    chunks.forEach((chunk, index) => {
      const page = document.pages.find((candidate) => candidate.pageNumber === chunk.pageNumber)!;
      expect(chunk.chunkIndex).toBe(index);
      expect(page.text.slice(chunk.charStart, chunk.charEnd)).toBe(chunk.content);
      expect(quoteAppearsIn(chunk.content, page.text)).toBe(true);
      expect(chunk.content.trim()).toBe(chunk.content);
    });
  });

  it('aucune ligne de tableau coupée ; prose <= 1200 caractères', async () => {
    const document = await parsed(filename);
    const chunks = chunksOf(document);
    for (const page of document.pages) {
      const lines = page.text.split('\n');
      let offset = 0;
      for (const line of lines) {
        const start = offset;
        const end = offset + line.length;
        offset = end + 1;
        if (!splitTableRow(line)) continue;
        // Toute intersection d'un chunk avec une ligne de tableau la contient entièrement.
        for (const chunk of chunks.filter((c) => c.pageNumber === page.pageNumber)) {
          const overlaps = chunk.charStart < end && chunk.charEnd > start;
          if (overlaps) {
            expect(chunk.charStart <= start && chunk.charEnd >= end, `ligne coupée : ${line}`).toBe(true);
          }
        }
      }
    }
    for (const chunk of chunks.filter((c) => c.kind === 'text')) expect(chunk.content.length).toBeLessThanOrEqual(1200);
  });
});

describe('tableaux', () => {
  it('catalogue PDF : un chunk par analyse, en-têtes répétés dans heading et metadata', async () => {
    const chunks = chunksOf(await parsed('manuel-prelevement-v3.pdf'));
    const rows = chunks.filter((chunk) => chunk.kind === 'table_row');
    expect(rows).toHaveLength(28);
    for (const row of rows) {
      expect(row.heading).toContain('Analyse | Code | Tube(s) accepté(s) | Tube(s) refusé(s)');
      expect(row.metadata.table?.catalog).toBe(true);
      expect(row.metadata.table?.header).toHaveLength(8);
      expect(splitTableRow(row.content)).toHaveLength(8);
    }
    const nfs = rows.find((row) => row.content.startsWith('NFS'))!;
    expect(nfs.pageNumber).toBe(4);
    expect(nfs.heading).toMatch(/^Manuel de prélèvement > 4\. Catalogue des analyses > 4\.1 Hématologie — /);
    // Page 5 : suite du tableau de biochimie, rattachée à la bonne section.
    const calcium = rows.find((row) => row.content.startsWith('Calcium |'))!;
    expect(calcium.pageNumber).toBe(5);
    expect(calcium.heading).toContain('4.3 Biochimie');
  });

  it('tableau non catalogue : lignes groupées avec en-tête en tête du premier chunk', async () => {
    const chunks = chunksOf(await parsed('manuel-prelevement-v3.pdf'));
    const tubes = chunks.find((chunk) => chunk.kind === 'table' && chunk.content.startsWith('Couleur du bouchon'))!;
    expect(tubes.content.split('\n')).toHaveLength(7);
    expect(tubes.metadata.table?.catalog).toBe(false);
  });

  it('grand tableau groupé : plusieurs chunks, chacun avec l’en-tête dans heading', () => {
    const header = 'Non-conformité | Conduite à tenir';
    const body = Array.from({ length: 40 }, (_, i) => `Cas numéro ${i + 1} | Refuser l’analyse et tracer l’événement numéro ${i + 1}.`);
    const text = `Tableau des cas\n\n${[header, ...body].join('\n')}`;
    const chunks = chunkPages([{ pageNumber: 1, text }]);
    const tables = chunks.filter((chunk) => chunk.kind === 'table');
    expect(tables.length).toBeGreaterThan(2);
    for (const table of tables) {
      expect(table.heading).toContain(header);
      expect(table.content.length).toBeLessThanOrEqual(1200);
    }
    expect(tables.map((table) => table.content).join('\n')).toBe([header, ...body].join('\n'));
  });

  it('tableau continué sans en-tête en haut de page : reprend l’en-tête précédent', () => {
    const header = 'Analyse | Code | Tube | Stabilité';
    const page1 = `Catalogue\n\n${header}\nNFS | NFS | EDTA | 24 h\nTP | TP | Citrate | 24 h`;
    const page2 = 'Glycémie | GLY | Fluorure | 24 h\nLactate | LACT | Fluorure | 15 minutes';
    const chunks = chunkPages([
      { pageNumber: 1, text: page1 },
      { pageNumber: 2, text: page2 },
    ]);
    const second = chunks.filter((chunk) => chunk.pageNumber === 2);
    expect(second.map((chunk) => chunk.content)).toEqual(['Glycémie | GLY | Fluorure | 24 h', 'Lactate | LACT | Fluorure | 15 minutes']);
    for (const chunk of second) {
      expect(chunk.kind).toBe('table_row');
      expect(chunk.metadata.table?.header_inherited).toBe(true);
      expect(chunk.heading).toContain(header);
    }
  });
});

describe('prose', () => {
  it('coupe un long texte en chunks de 800-1200 caractères avec recouvrement', () => {
    const sentences = Array.from(
      { length: 60 },
      (_, i) => `Phrase ${i + 1} : le tube doit être acheminé au laboratoire dans les délais prévus par le manuel.`,
    );
    const paragraphs = [sentences.slice(0, 20).join(' '), sentences.slice(20, 40).join(' '), sentences.slice(40).join(' ')];
    const text = `3. Transport\n\n${paragraphs.join('\n\n')}`;
    const chunks = chunkPages([{ pageNumber: 1, text }]);
    expect(chunks.length).toBeGreaterThanOrEqual(5);
    for (const chunk of chunks) {
      expect(chunk.content.length).toBeLessThanOrEqual(1200);
      expect(chunk.heading).toBe('3. Transport');
    }
    for (const chunk of chunks.slice(0, -1)) expect(chunk.content.length).toBeGreaterThanOrEqual(500);
    // Recouvrement : chaque chunk commence avant la fin du précédent.
    for (let i = 1; i < chunks.length; i += 1) {
      expect(chunks[i]!.charStart).toBeLessThan(chunks[i - 1]!.charEnd);
      expect(chunks[i - 1]!.charEnd - chunks[i]!.charStart).toBeLessThanOrEqual(200);
    }
  });

  it('nouveau chunk à chaque section ; le titre est dans le contenu et dans heading', async () => {
    const chunks = chunksOf(await parsed('manuel-prelevement-v3.pdf'));
    const nfs = chunks.find((chunk) => chunk.content.startsWith('5.2 NFS'))!;
    expect(nfs.heading).toBe('Manuel de prélèvement > 5. Cas particuliers et tubes alternatifs > 5.2 NFS');
    expect(nfs.content).not.toContain('5.3 Troponine');
  });

  it('heuristiques de titres pour le texte brut', () => {
    const lines = ['# Titre', '', '2.1 Règles générales', '', 'Texte normal.', '', 'Annexe B', '', 'Une phrase qui finit par un point.'];
    expect(detectHeadings(lines).map((heading) => [heading.text, heading.level])).toEqual([
      ['Titre', 1],
      ['2.1 Règles générales', 2],
      ['Annexe B', 1],
    ]);
  });
});
