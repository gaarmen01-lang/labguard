/**
 * Parseurs sur le corpus FICTIF : texte par page, lignes de tableau intactes
 * (une ligne de tableau = une ligne de texte, cellules jamais mélangées),
 * détection du type réel, erreurs en français.
 */
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_PARSE_LIMITS,
  IngestionError,
  parseCsvRows,
  parseDocument,
  resolveFileKind,
  SCANNED_PDF_MESSAGE,
  splitTableRow,
  type ParsedDocument,
} from '@/lib/ingestion';

import { corpusFile, mimeFor } from './helpers/ingest';

async function parse(filename: string, bytes = corpusFile(filename)): Promise<ParsedDocument> {
  return parseDocument({ bytes, mimeType: mimeFor(filename), filename });
}

function rowsOf(document: ParsedDocument): string[][] {
  return document.pages.flatMap((page) => page.text.split('\n').map(splitTableRow).filter((cells): cells is string[] => cells !== null));
}

function findRow(document: ParsedDocument, firstCell: string): string[] {
  const row = rowsOf(document).find((cells) => cells[0] === firstCell);
  if (!row) throw new Error(`ligne « ${firstCell} » introuvable`);
  return row;
}

async function expectIngestionError(promise: Promise<unknown>, code: string): Promise<IngestionError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(IngestionError);
    expect((error as IngestionError).code).toBe(code);
    return error as IngestionError;
  }
  throw new Error(`erreur ${code} attendue`);
}

describe('PDF texte (manuel de prélèvement v3)', () => {
  it('produit une page par page physique, sans le pied de page répété', async () => {
    const document = await parse('manuel-prelevement-v3.pdf');
    expect(document.kind).toBe('pdf');
    expect(document.pages).toHaveLength(9);
    expect(document.pages.map((page) => page.label)).toEqual(Array.from({ length: 9 }, (_, i) => `p. ${i + 1}`));
    for (const page of document.pages) expect(page.text).not.toMatch(/Page \d+\/9/);
    expect(document.warnings).toEqual([]);
  });

  it('reconstruit chaque ligne du catalogue avec ses 8 cellules, cellules multi-lignes recollées', async () => {
    const document = await parse('manuel-prelevement-v3.pdf');
    const header = rowsOf(document).find((cells) => cells[0] === 'Analyse');
    expect(header).toEqual([
      'Analyse', 'Code', 'Tube(s) accepté(s)', 'Tube(s) refusé(s)', 'Volume', 'Conservation / transport', 'Stabilité', 'Délai de rendu',
    ]);
    expect(findRow(document, 'NFS (hémogramme)')).toEqual([
      'NFS (hémogramme)', 'NFS', 'EDTA K2 (bouchon mauve)', 'Citrate, héparine de lithium', '2 mL', 'Température ambiante',
      '24 h à température ambiante', '2 h',
    ]);
    // Cellules sur 3 à 4 lignes visuelles dans le PDF.
    expect(findRow(document, 'Vitesse de sédimentation (VS)')[2]).toBe('Citrate 3,8 % (bouchon noir) ; EDTA K2 si analyse dans les 4 h');
    expect(findRow(document, 'Groupe sanguin ABO-RhD (groupage)')[3]).toBe('Tube sec, tube avec gel');
    // Cellule vide rendue « — » : la colonne suivante ne glisse pas.
    expect(findRow(document, 'CRP (protéine C réactive)').slice(3, 5)).toEqual(['—', '2 mL']);
    // Lignes voisines non mélangées.
    expect(findRow(document, 'Troponine T hypersensible')).toEqual([
      'Troponine T hypersensible', 'TROP', 'Héparine de lithium (bouchon vert)', 'EDTA', '2 mL', 'Température ambiante', '8 h', '1 h (urgence)',
    ]);
    expect(findRow(document, 'Ammoniémie')[3]).toBe("Héparine d'ammonium");
  });

  it('retrouve les 28 analyses du catalogue, toutes complètes', async () => {
    const document = await parse('manuel-prelevement-v3.pdf');
    const rows = rowsOf(document).filter((cells) => cells.length === 8 && cells[0] !== 'Analyse');
    expect(rows).toHaveLength(28);
    for (const row of rows) {
      expect(row[1]).toMatch(/^[A-Z0-9]+$/);
      expect(row[7]).toMatch(/\d+ (h|jours)/);
    }
  });

  it('repère les titres (police plus grande) et garde la prose en paragraphes', async () => {
    const document = await parse('manuel-prelevement-v3.pdf');
    const page6 = document.pages[5]!;
    expect(page6.headings.map((heading) => heading.text)).toContain('5.2 NFS');
    expect(page6.text).toContain(
      'Pour la NFS, aucun tube autre que le tube EDTA n’est accepté. Un tube citrate (bouchon bleu clair) reçu seul pour une NFS est refusé',
    );
  });

  it('la v2 diffère de la v3 sur la troponine', async () => {
    const v2 = await parse('manuel-prelevement-v2.pdf');
    expect(findRow(v2, 'Troponine T hypersensible')[2]).toBe('Héparine de lithium (bouchon vert) ; EDTA K2 (bouchon mauve)');
    expect(rowsOf(v2).some((cells) => cells[0] === 'Calcium ionisé')).toBe(false);
  });

  it('refuse un PDF scanné (sans texte) avec un message clair', async () => {
    const error = await expectIngestionError(parse('scan-sans-texte.pdf'), 'scanned_pdf');
    expect(error.message).toBe(SCANNED_PDF_MESSAGE);
    expect(error.message).toMatch(/OCR/);
    expect(error.retryable).toBe(false);
  });

  it('refuse un PDF corrompu et un PDF trop long', async () => {
    const corrupt = new TextEncoder().encode('%PDF-1.7\nceci n’est pas un PDF');
    await expectIngestionError(parse('x.pdf', corrupt), 'corrupt_file');
    await expectIngestionError(
      parseDocument(
        { bytes: corpusFile('manuel-prelevement-v3.pdf'), mimeType: 'application/pdf', filename: 'm.pdf' },
        { ...DEFAULT_PARSE_LIMITS, maxPages: 5 },
      ),
      'too_many_pages',
    );
  });
});

describe('DOCX (procédure non-conformités)', () => {
  it('extrait titres, listes et tableau, découpe en sections logiques', async () => {
    const document = await parse('procedure-non-conformites.docx');
    expect(document.kind).toBe('docx');
    expect(document.pages.length).toBeGreaterThanOrEqual(2);
    expect(document.pages[0]!.label).toMatch(/^Section/);
    const all = document.pages.map((page) => page.text).join('\n');
    expect(all).toContain('- Dérogation : décision tracée d’un biologiste d’analyser malgré une non-conformité.');
    expect(findRow(document, 'Tube inadapté à l’analyse')).toEqual([
      'Tube inadapté à l’analyse',
      'NFS reçue uniquement sur tube citrate',
      'Refuser l’analyse et demander un nouveau prélèvement sur le tube indiqué au manuel',
      'Non',
    ]);
    const headings = document.pages.flatMap((page) => page.headings.map((heading) => heading.text));
    expect(headings).toContain('4. Critères de non-conformité et conduite à tenir');
  });
});

describe('XLSX et CSV', () => {
  it('XLSX : une feuille = une page, en-tête détecté sous le titre', async () => {
    const document = await parse('catalogue-analyses.xlsx');
    expect(document.pages.map((page) => page.label)).toEqual(['Feuille « Biochimie »', 'Feuille « Hématologie »', 'Feuille « Légende »']);
    const biochemistry = document.pages[0]!;
    expect(biochemistry.tables[0]!.header[0]).toBe('Code');
    expect(biochemistry.tables[0]!.rows).toHaveLength(12);
    expect(biochemistry.text.split('\n')[0]).toMatch(/^Catalogue FICTIF/);
    expect(findRow(document, 'PCT')).toEqual([
      'PCT', 'Procalcitonine', '—', 'Héparine de lithium (bouchon vert)', '—', '0,5', 'Température ambiante', '24 h à 2-8 °C', '2 h', '—',
    ]);
  });

  it('CSV : BOM, séparateur « ; », champ entre guillemets avec saut de ligne', async () => {
    const document = await parse('analyses-specialisees.csv');
    expect(document.pages).toHaveLength(1);
    const row = findRow(document, 'PTH');
    expect(row[4]).toBe('Réfrigéré (2-8 °C) ; centrifuger dans les 2 h');
    expect(row[6]).toBe('Tube sec refusé. Préciser l’heure du prélèvement');
    expect(document.pages[0]!.text.charCodeAt(0)).not.toBe(0xfeff);
  });

  it('CSV Windows-1252 décodé correctement', async () => {
    const latin1 = Uint8Array.from([...'Code;Analyse;Tube\nGLY;Glyc'].map((c) => c.charCodeAt(0)).concat([0xe9], [...'mie;Fluorure\nK;Potassium;H'].map((c) => c.charCodeAt(0)), [0xe9], [...'parine\n'].map((c) => c.charCodeAt(0))));
    const document = await parse('x.csv', latin1);
    expect(document.pages[0]!.text).toContain('GLY | Glycémie | Fluorure');
  });

  it('parseCsvRows gère guillemets doublés et séparateurs entre guillemets', () => {
    expect(parseCsvRows('a;"b ""x"";c";d\n1;2;3\n', ';')).toEqual([['a', 'b "x";c', 'd'], ['1', '2', '3']]);
  });
});

describe('TXT / Markdown', () => {
  it('conserve le texte tel quel, tableau Markdown lisible ligne à ligne', async () => {
    const document = await parse('consignes-transport.md');
    expect(document.kind).toBe('text');
    expect(document.pages[0]!.text).toContain('| Ammoniémie | Dans la glace | 30 minutes |');
    expect(splitTableRow('| Ammoniémie | Dans la glace | 30 minutes |')).toEqual(['Ammoniémie', 'Dans la glace', '30 minutes']);
  });
});

describe('type réel du fichier', () => {
  it('se fie à la signature, pas à l’extension', async () => {
    const pdf = corpusFile('manuel-prelevement-v3.pdf');
    const docx = corpusFile('procedure-non-conformites.docx');
    const xlsx = corpusFile('catalogue-analyses.xlsx');
    expect(resolveFileKind(pdf, 'application/pdf', 'a.pdf')).toBe('pdf');
    expect(resolveFileKind(xlsx, null, 'a.xlsx')).toBe('xlsx');
    const mismatch = await expectIngestionError(parse('faux.docx', pdf), 'type_mismatch');
    expect(mismatch.message).toMatch(/ne correspond pas au type déclaré/);
    await expectIngestionError(parse('faux.xlsx', docx), 'type_mismatch');
    await expectIngestionError(parse('texte.pdf', new TextEncoder().encode('bonjour')), 'type_mismatch');
  });

  it('refuse binaires inconnus, fichiers vides et trop volumineux', async () => {
    const exe = Uint8Array.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00, 0x04, 0x00]);
    await expectIngestionError(parse('a.txt', exe), 'unsupported_type');
    await expectIngestionError(parse('a.txt', new Uint8Array()), 'empty_document');
    await expectIngestionError(
      parseDocument({ bytes: new Uint8Array(2048).fill(65), mimeType: 'text/plain', filename: 'a.txt' }, { ...DEFAULT_PARSE_LIMITS, maxBytes: 1024 }),
      'too_large',
    );
  });
});
