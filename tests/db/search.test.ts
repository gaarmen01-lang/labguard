import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analysisSearchResultSchema,
  chunkSearchResultSchema,
  pageReadResultSchema,
  type ChunkSearchResult,
} from '@/lib/contracts/domain';

import { seedCorpus, type SeededCorpus } from '../helpers/corpus';
import { createTestDb, type TestDb, type TestUser } from '../helpers/db';

let db: TestDb;
let corpus: SeededCorpus;
let member: TestUser;
let admin: TestUser;

async function searchChunks(q: string, as: TestUser = member, max = 8): Promise<ChunkSearchResult[]> {
  return db.asUser(as.id, async (tx) => {
    const { rows } = await tx.query('select * from public.search_chunks($1, $2)', [q, max]);
    return rows.map((row) => chunkSearchResultSchema.parse(row));
  });
}

beforeAll(async () => {
  db = await createTestDb();
  corpus = await seedCorpus(db);
  member = await db.createUser('membre@lab.test');
  admin = await db.createUser('admin@lab.test', { role: 'admin' });
});

afterAll(async () => {
  await db.close();
});

describe('search_chunks', () => {
  it('« tube mauve » retrouve un passage qui ne mentionne que « EDTA » (glossaire)', async () => {
    const results = await searchChunks('tube mauve');
    const hit = results.find((r) => r.chunk_id === corpus.chunks.cbcEdta);
    expect(hit).toBeDefined();
    expect(hit?.content).not.toMatch(/mauve|violet|lavande|tube/i);
    expect(hit?.matched_synonyms).toContain('tube_edta');
    expect(hit?.synonym_score).toBeGreaterThan(0);
    expect(hit?.document_code).toBe('MP-PRE');
    expect(hit?.document_version).toBe('2');
    expect(hit?.page_number).toBe(1);
    // Seuls des passages EDTA arrivent en tête (pas le « tube sec »).
    expect(results.slice(0, 2).every((r) => /EDTA/.test(r.content))).toBe(true);
    expect(results.map((r) => r.chunk_id)).not.toContain(corpus.chunks.serology);
  });

  it('reconnaît les variantes du glossaire dans une phrase', async () => {
    const results = await searchChunks("j'ai reçu un tube à bouchon violet pour l'hémogramme");
    // EDTA (glossaire) + hémogramme (mot) : ce passage combine les deux.
    expect(results[0]?.chunk_id).toBe(corpus.chunks.cbcEdta);
  });

  it("question type : « Pour l'hémogramme je n'ai reçu qu'un tube mauve… »", async () => {
    const results = await searchChunks(
      "Pour l'hémogramme je n'ai reçu qu'un tube mauve, puis-je faire l'analyse ou le résultat risque d'être faux ?",
    );
    expect(results[0]?.chunk_id).toBe(corpus.chunks.cbcEdta);
    expect(results[0]?.matched_synonyms).toEqual(expect.arrayContaining(['test_cbc', 'tube_edta']));
  });

  it('tube bleu -> citrate', async () => {
    const results = await searchChunks('tube bleu');
    expect(results.map((r) => r.chunk_id)).toContain(corpus.chunks.ptCitrate);
    expect(results.every((r) => /citrate/i.test(r.content))).toBe(true);
  });

  it('tolère les fautes de frappe', async () => {
    const ammonia = await searchChunks('amoniemie');
    expect(ammonia.map((r) => r.chunk_id)).toContain(corpus.chunks.ammonia);
    expect(ammonia[0]?.chunk_id).toBe(corpus.chunks.ammonia);

    const serology = await searchChunks('serolgies virales');
    expect(serology[0]?.chunk_id).toBe(corpus.chunks.serology);
  });

  it('ignore accents et casse', async () => {
    const results = await searchChunks('AMMONIEMIE TRANSPORT GLACE');
    expect(results[0]?.chunk_id).toBe(corpus.chunks.ammonia);
  });

  it("n'interroge que les documents actifs, même pour un admin", async () => {
    for (const user of [member, admin]) {
      const heparin = await searchChunks('héparine de lithium hémogramme', user, 50);
      const ids = heparin.map((r) => r.chunk_id);
      expect(ids).not.toContain(corpus.chunks.archivedHeparin);

      const draft = await searchChunks('brouillon confidentiel glycémie fluorure', user, 50);
      expect(draft.map((r) => r.chunk_id)).not.toContain(corpus.chunks.draftGlucose);
    }
  });

  it('renvoie des scores décroissants et respecte max_results', async () => {
    const results = await searchChunks('prélèvement tube analyse', member, 2);
    expect(results.length).toBeLessThanOrEqual(2);
    const scores = results.map((r) => r.score);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);
  });

  it('une requête vide ou faite de mots vides ne renvoie rien', async () => {
    expect(await searchChunks('')).toEqual([]);
    expect(await searchChunks('   ')).toEqual([]);
    expect(await searchChunks('?! …')).toEqual([]);
    expect(await searchChunks('de la du')).toEqual([]);
  });

  it("un utilisateur hors liste blanche n'obtient rien", async () => {
    const outsider = await db.createUser('intrus@ailleurs.test', { allowed: false });
    expect(await searchChunks('tube mauve', outsider)).toEqual([]);
  });
});

describe('prepare_search_query', () => {
  it('expose les groupes de synonymes et le résidu', async () => {
    const [plan] = await db.query<{ residual: string; synonym_groups: string[]; tokens: string[] }>(
      'select * from public.prepare_search_query($1)',
      ['Tube mauve pour HbA1c ?'],
    );
    expect(plan?.synonym_groups).toEqual(['test_hba1c', 'tube_edta']);
    expect(plan?.residual).toBe('pour');
    // « pour » est un mot vide : aucun token restant.
    expect(plan?.tokens).toEqual([]);
  });

  it('rapproche une faute de frappe sur un terme du glossaire', async () => {
    const [plan] = await db.query<{ synonym_groups: string[] }>(
      'select * from public.prepare_search_query($1)',
      ['lavende'],
    );
    expect(plan?.synonym_groups).toContain('tube_edta');
  });
});

describe('search_analyses', () => {
  async function searchAnalyses(q: string, as: TestUser = member) {
    return db.asUser(as.id, async (tx) => {
      const { rows } = await tx.query('select * from public.search_analyses($1, 5)', [q]);
      return rows.map((row) => analysisSearchResultSchema.parse(row));
    });
  }

  it('trouve une fiche par synonyme, avec ses citations par champ', async () => {
    const [first] = await searchAnalyses('hémoglobine glyquée');
    expect(first?.analysis_id).toBe(corpus.analyses.hba1c);
    expect(first?.accepted_tubes).toEqual(['EDTA']);
    expect(first?.field_sources.accepted_tubes).toEqual({
      chunk_id: corpus.chunks.hba1cRow,
      quote: 'Tube : EDTA',
    });
    expect(first?.source_page_number).toBe(1);
    expect(first?.document_code).toBe('CAT-ANA');
  });

  it('trouve une fiche par code et malgré une faute de frappe', async () => {
    expect((await searchAnalyses('HBA1C'))[0]?.analysis_id).toBe(corpus.analyses.hba1c);
    expect((await searchAnalyses('hemoglobine gliquee'))[0]?.analysis_id).toBe(corpus.analyses.hba1c);
  });

  it('« HbA1c tube mauve » : la fiche HbA1c arrive en tête', async () => {
    expect((await searchAnalyses('HbA1c tube mauve'))[0]?.analysis_id).toBe(corpus.analyses.hba1c);
  });

  it('exclut les fiches des documents non actifs', async () => {
    const results = await searchAnalyses('potassium', admin);
    expect(results.map((r) => r.analysis_id)).not.toContain(corpus.analyses.archivedPotassium);
  });
});

describe('read_document_page', () => {
  it('lit une page (et ses voisines) d’un document actif', async () => {
    const rows = await db.asUser(member.id, async (tx) => {
      const { rows } = await tx.query('select * from public.read_document_page($1, $2, $3)', [
        corpus.manualId,
        1,
        1,
      ]);
      return rows.map((row) => pageReadResultSchema.parse(row));
    });
    expect(rows.map((r) => r.page_number)).toEqual([1, 2]);
    expect(rows[0]?.content).toContain('EDTA K2');
  });

  it('ne lit pas un brouillon ni une archive', async () => {
    for (const id of [corpus.draftId, corpus.archivedManualId]) {
      const rows = await db.asUser(admin.id, async (tx) =>
        (await tx.query('select * from public.read_document_page($1, 1)', [id])).rows,
      );
      expect(rows).toEqual([]);
    }
  });
});
