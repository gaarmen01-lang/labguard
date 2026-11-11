/**
 * Extraction des fiches : déterministe (colonnes reconnues, sans LLM) et LLM
 * avec un faux fournisseur, y compris rejet d'une citation inventée, d'une
 * valeur non portée par sa citation et d'un JSON invalide.
 */
import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { LlmError, type Chunk } from '@/lib/contracts';
import {
  chunkPages,
  createTubeMatcher,
  extractCatalogRow,
  extractWithLlm,
  isCatalogRow,
  mapHeader,
  matchHeaderField,
  parseDocument,
  splitTubeList,
  type ExtractionChunk,
} from '@/lib/ingestion';

import { corpusFile, emptySheet, mimeFor, ScriptedLlm } from './helpers/ingest';

// Extrait du glossaire initial (0005_seed_synonyms.sql).
const GLOSSARY = [
  ['tube_edta', 'EDTA'], ['tube_edta', 'K2 EDTA'], ['tube_edta', 'tube mauve'], ['tube_edta', 'tube violet'],
  ['tube_edta', 'bouchon mauve'], ['tube_edta', 'mauve'], ['tube_edta', 'lavande'],
  ['tube_citrate', 'citrate'], ['tube_citrate', 'tube bleu'], ['tube_citrate', 'bouchon bleu clair'],
  ['tube_heparin', 'héparine'], ['tube_heparin', 'héparine de lithium'], ['tube_heparin', 'tube vert'], ['tube_heparin', 'bouchon vert'],
  ['tube_serum_plain', 'tube sec'], ['tube_serum_plain', 'tube rouge'],
  ['tube_serum_gel', 'tube sec avec gel'], ['tube_serum_gel', 'bouchon jaune'], ['tube_serum_gel', 'gel séparateur'],
  ['tube_fluoride', 'fluorure'], ['tube_fluoride', 'tube gris'], ['tube_fluoride', 'bouchon gris'],
  ['tube_esr', 'bouchon noir'], ['test_cbc', 'NFS'],
].map(([group_key, term]) => ({ group_key: group_key!, term: term! }));
const tubes = createTubeMatcher(GLOSSARY);

function asChunk(content: string, extra: Partial<Chunk> = {}): ExtractionChunk {
  return { id: randomUUID(), chunk_index: 0, page_number: 1, kind: 'text', heading: null, content, metadata: {}, ...extra };
}

async function catalogChunks(filename: string): Promise<ExtractionChunk[]> {
  const document = await parseDocument({ bytes: corpusFile(filename), mimeType: mimeFor(filename), filename });
  return chunkPages(document.pages).map((draft) => ({
    id: randomUUID(),
    chunk_index: draft.chunkIndex,
    page_number: draft.pageNumber,
    kind: draft.kind,
    heading: draft.heading,
    content: draft.content,
    metadata: draft.metadata,
  }));
}

describe('correspondance des en-têtes', () => {
  it('reconnaît les intitulés usuels', () => {
    expect(matchHeaderField('Tube(s) refusé(s)')).toBe('rejected_tubes');
    expect(matchHeaderField('Tube(s) accepté(s)')).toBe('accepted_tubes');
    expect(matchHeaderField('Conservation / transport')).toBe('transport');
    expect(matchHeaderField('Délai de rendu')).toBe('turnaround_time');
    expect(matchHeaderField('Volume minimal (mL)')).toBe('volume');
    expect(matchHeaderField('Principales analyses')).toBeNull();
    expect(mapHeader(['Couleur du bouchon', 'Type de tube', 'Additif', 'Principales analyses']).isCatalog).toBe(false);
    expect(mapHeader(['Analyse', 'Température', 'Délai maximal']).isCatalog).toBe(false);
  });
});

describe('tubes', () => {
  it('normalise vers la forme canonique en gardant le libellé original', () => {
    expect(tubes.format('Tube violet')).toBe('EDTA (« Tube violet »)');
    expect(tubes.format('EDTA K2 (bouchon mauve)')).toBe('EDTA K2 (bouchon mauve)');
    expect(tubes.format('bouchon gris')).toBe('Fluorure (« bouchon gris »)');
    expect(tubes.format('Tube sec avec gel (bouchon jaune)')).toBe('Tube sec avec gel (bouchon jaune)');
    expect(tubes.format("Héparine d'ammonium")).toBe("Héparine d'ammonium");
    expect(tubes.format('Seringue héparinée pour gaz du sang')).toBe('Seringue héparinée pour gaz du sang');
    expect(tubes.match('Citrate 3,8 % (bouchon noir)')?.groupKey).toBe('tube_esr');
  });

  it('découpe une liste de tubes sans couper « 3,2 % » ni les parenthèses', () => {
    expect(splitTubeList('EDTA, héparine de lithium, tube sec')).toEqual(['EDTA', 'héparine de lithium', 'tube sec']);
    expect(splitTubeList('Citrate de sodium 3,2 % (bouchon bleu clair)')).toEqual(['Citrate de sodium 3,2 % (bouchon bleu clair)']);
    expect(splitTubeList('Héparine de lithium (bouchon vert) ; tube sec avec gel (bouchon jaune)')).toEqual([
      'Héparine de lithium (bouchon vert)',
      'tube sec avec gel (bouchon jaune)',
    ]);
    expect(splitTubeList('tube sec ou tube gel (a, b)')).toEqual(['tube sec', 'tube gel (a, b)']);
  });
});

describe('extraction déterministe', () => {
  it('manuel PDF : fiche NFS complète, chaque champ cité depuis sa cellule', async () => {
    const chunks = await catalogChunks('manuel-prelevement-v3.pdf');
    const nfs = chunks.find((chunk) => isCatalogRow(chunk) && chunk.content.startsWith('NFS'))!;
    const { analysis, rejections } = extractCatalogRow(nfs, tubes)!;
    expect(rejections).toEqual([]);
    expect(analysis).toMatchObject({
      name: 'NFS (hémogramme)',
      synonyms: ['hémogramme'],
      codes: ['NFS'],
      accepted_tubes: ['EDTA K2 (bouchon mauve)'],
      rejected_tubes: ['Citrate', 'héparine de lithium'],
      volume: '2 mL',
      transport: 'Température ambiante',
      storage: null,
      stability: '24 h à température ambiante',
      turnaround_time: '2 h',
      remarks: null,
      source_chunk_id: nfs.id,
      source_quote: 'NFS (hémogramme)',
    });
    expect(analysis!.field_sources.rejected_tubes).toEqual({ chunk_id: nfs.id, quote: 'Citrate, héparine de lithium' });
    expect(analysis!.field_sources.remarks).toBeUndefined();
  });

  it('case vide = champ null (le document ne dit rien)', async () => {
    const chunks = await catalogChunks('manuel-prelevement-v3.pdf');
    const crp = chunks.find((chunk) => chunk.content.startsWith('CRP'))!;
    const { analysis } = extractCatalogRow(crp, tubes)!;
    expect(analysis!.rejected_tubes).toEqual([]);
    expect(analysis!.field_sources.rejected_tubes).toBeUndefined();
  });

  it('XLSX : volume numérique complété par l’unité de l’en-tête, synonymes en liste', async () => {
    const chunks = await catalogChunks('catalogue-analyses.xlsx');
    const asat = chunks.find((chunk) => chunk.content.startsWith('ASAT |'))!;
    const { analysis } = extractCatalogRow(asat, tubes)!;
    expect(analysis).toMatchObject({
      name: 'ASAT',
      codes: ['ASAT'],
      synonyms: ['TGO', 'aspartate aminotransférase'],
      accepted_tubes: ['Héparine de lithium (bouchon vert)'],
      volume: '2 mL',
      storage: 'Température ambiante',
      remarks: 'Hémolyse : résultat faussement augmenté',
    });
    expect(analysis!.field_sources.volume?.quote).toBe('2');
  });

  it('ne traite pas les tableaux non catalogue', async () => {
    const chunks = await catalogChunks('procedure-non-conformites.docx');
    expect(chunks.some(isCatalogRow)).toBe(false);
  });
});

describe('extraction LLM (faux fournisseur)', () => {
  const passage = asChunk(
    "5.4 Ammoniémie\n\nPrélever sans garrot prolongé, sur tube EDTA K2 placé immédiatement dans la glace. L’analyse doit être réalisée dans les 30 minutes suivant le prélèvement. Le tube à l’héparine d’ammonium est strictement refusé.",
    { heading: '5. Cas particuliers > 5.4 Ammoniémie' },
  );

  function sheet(overrides: Record<string, unknown>) {
    return { ...emptySheet('P1'), ...overrides };
  }

  it('retient les champs dont la citation figure mot pour mot dans le passage', async () => {
    const llm = new ScriptedLlm(() =>
      JSON.stringify({
        analyses: [
          sheet({
            name: { value: 'Ammoniémie', quote: 'Ammoniémie' },
            accepted_tubes: { values: ['tube EDTA K2'], quote: 'sur tube EDTA K2 placé immédiatement dans la glace' },
            rejected_tubes: { values: ["tube à l'héparine d'ammonium"], quote: 'Le tube à l’héparine d’ammonium est strictement refusé' },
            transport: { value: 'dans la glace', quote: 'placé immédiatement dans la glace' },
            stability: { value: 'analyse dans les 30 minutes', quote: 'L’analyse doit être réalisée dans les 30 minutes' },
          }),
        ],
      }),
    );
    const result = await extractWithLlm(llm, [passage], tubes);
    expect(result.invalidResponse).toBe(false);
    expect(result.rejections).toEqual([]);
    expect(result.analyses).toHaveLength(1);
    const [analysis] = result.analyses;
    expect(analysis).toMatchObject({
      name: 'Ammoniémie',
      accepted_tubes: ['tube EDTA K2'],
      rejected_tubes: ["tube à l'héparine d'ammonium"],
      transport: 'dans la glace',
      volume: null,
      source_chunk_id: passage.id,
    });
    // Requête : sortie JSON stricte, sans outils, température 0.
    const request = llm.requests[0]!;
    expect(request.responseFormat).toMatchObject({ type: 'json_schema', strict: true });
    expect(request.tools).toBeUndefined();
    expect(request.temperature).toBe(0);
    expect(request.messages[1]!.content).toContain(passage.content);
  });

  it('rejette une citation inventée et une valeur que la citation ne porte pas', async () => {
    const llm = new ScriptedLlm(() =>
      JSON.stringify({
        analyses: [
          sheet({
            name: { value: 'Ammoniémie', quote: 'Ammoniémie' },
            // Citation absente du passage :
            accepted_tubes: { values: ['tube héparine de lithium'], quote: 'tube héparine de lithium accepté' },
            // Citation réelle mais valeur inventée :
            stability: { value: '2 heures à température ambiante', quote: 'L’analyse doit être réalisée dans les 30 minutes' },
            // Valeur sans citation :
            volume: { value: '2 mL', quote: null },
          }),
          // Fiche sans nom vérifiable : rejetée en entier.
          sheet({ name: { value: 'Lactate', quote: 'Lactate sur tube gris' }, transport: { value: 'dans la glace', quote: 'dans la glace' } }),
          // Passage inconnu : rejetée.
          sheet({ passage: 'P9', name: { value: 'Ammoniémie', quote: 'Ammoniémie' } }),
        ],
      }),
    );
    const result = await extractWithLlm(llm, [passage], tubes);
    expect(result.analyses).toHaveLength(1);
    const [analysis] = result.analyses;
    expect(analysis!.accepted_tubes).toEqual([]);
    expect(analysis!.stability).toBeNull();
    expect(analysis!.volume).toBeNull();
    expect(Object.keys(analysis!.field_sources)).toEqual(['name']);
    expect(result.rejections.map((rejection) => `${rejection.field}:${rejection.reason}`).sort()).toEqual([
      'accepted_tubes:quote_not_found',
      'name:quote_not_found',
      'stability:value_not_in_quote',
      'volume:missing_quote',
    ]);
    expect(result.rejectedAnalyses).toBe(2);
  });

  it('JSON invalide : une relance, puis lot signalé inexploitable', async () => {
    const llm = new ScriptedLlm(() => 'Voici les fiches : {analyses: [');
    const result = await extractWithLlm(llm, [passage], tubes);
    expect(llm.requests).toHaveLength(2);
    expect(llm.requests[1]!.messages.at(-1)!.content).toMatch(/Réponse invalide/);
    expect(result).toMatchObject({ analyses: [], invalidResponse: true });
  });

  it('JSON invalide puis valide (balises de code tolérées)', async () => {
    const valid = JSON.stringify({ analyses: [sheet({ name: { value: 'Ammoniémie', quote: 'Ammoniémie' } })] });
    const llm = new ScriptedLlm((_request, index) => (index === 0 ? '{"analyses": "oops"}' : `\`\`\`json\n${valid}\n\`\`\``));
    const result = await extractWithLlm(llm, [passage], tubes);
    expect(result.invalidResponse).toBe(false);
    expect(result.analyses.map((analysis) => analysis.name)).toEqual(['Ammoniémie']);
    expect(result.usage.calls).toBe(2);
  });

  it('propage les erreurs du fournisseur', async () => {
    const llm = new ScriptedLlm(() => new LlmError('quota', { code: 'rate_limit', provider: 'fake' }));
    await expect(extractWithLlm(llm, [passage], tubes)).rejects.toBeInstanceOf(LlmError);
  });
});
