/**
 * Mini corpus FICTIF (aucune donnée patient, règles inventées pour les tests).
 * Réutilisable par les autres tâches : `const corpus = await seedCorpus(db)`.
 */
import type { TestDb } from './db';

export interface SeededCorpus {
  manualId: string;
  archivedManualId: string;
  draftId: string;
  catalogId: string;
  chunks: {
    cbcEdta: string;
    serology: string;
    ptCitrate: string;
    ammonia: string;
    archivedHeparin: string;
    draftGlucose: string;
    hba1cRow: string;
    archivedCatalogRow: string;
  };
  analyses: { hba1c: string; archivedPotassium: string };
}

export async function seedCorpus(db: TestDb): Promise<SeededCorpus> {
  const manual = await db.insertDocument({
    code: 'MP-PRE',
    title: 'Manuel de prélèvement',
    version: '2',
    docType: 'sampling_manual',
    status: 'active',
    pages: [
      {
        pageNumber: 1,
        chunks: [
          {
            heading: 'Hématologie',
            content: 'Hémogramme (NFS) : prélever sur EDTA K2, 4 mL. Stabilité 24 h à température ambiante.',
          },
          { heading: 'Sérologie', content: 'Sérologies virales : tube sec sans additif, 5 mL, centrifuger avant envoi.' },
        ],
      },
      {
        pageNumber: 2,
        chunks: [
          {
            kind: 'table_row',
            heading: 'Hémostase',
            content:
              "Analyse : TP / INR | Tube : citrate de sodium 3,2 % | Remarque : remplissage jusqu'au trait obligatoire",
          },
          {
            heading: 'Biochimie',
            content: 'Ammoniémie : transport dans la glace, analyse dans les 30 minutes suivant le prélèvement.',
          },
        ],
      },
    ],
  });

  const archivedManual = await db.insertDocument({
    code: 'MP-PRE',
    title: 'Manuel de prélèvement',
    version: '1',
    docType: 'sampling_manual',
    status: 'archived',
    pages: [{ pageNumber: 1, chunks: ['Hémogramme : tube héparine de lithium accepté (ancienne règle obsolète).'] }],
  });

  const draft = await db.insertDocument({
    code: 'PROC-GLY',
    title: 'Procédure glycémie (brouillon)',
    version: '0.1',
    status: 'draft',
    pages: [{ pageNumber: 1, chunks: ['Glycémie : tube gris au fluorure de sodium. Brouillon confidentiel.'] }],
  });

  const catalog = await db.insertDocument({
    code: 'CAT-ANA',
    title: "Catalogue d'analyses",
    version: '2025-01',
    docType: 'test_catalog',
    status: 'active',
    pages: [
      {
        pageNumber: 1,
        chunks: [
          {
            kind: 'table_row',
            heading: 'Catalogue',
            content:
              'Analyse : HbA1c (hémoglobine glyquée) | Code : HBA1C | Tube : EDTA | Refusé : citrate | Stabilité : 7 jours à 2-8 °C',
          },
        ],
      },
    ],
  });

  const archivedCatalog = await db.insertDocument({
    code: 'CAT-OLD',
    title: 'Ancien catalogue',
    version: '2019',
    docType: 'test_catalog',
    status: 'archived',
    pages: [
      {
        pageNumber: 1,
        chunks: [{ kind: 'table_row', content: 'Analyse : Potassium | Code : K | Tube : héparine de lithium' }],
      },
    ],
  });

  const hba1cRow = catalog.chunkIds[0]!;
  const hba1c = await db.insertAnalysis({
    documentId: catalog.documentId,
    sourceChunkId: hba1cRow,
    sourceQuote: 'HbA1c (hémoglobine glyquée)',
    name: 'HbA1c',
    synonyms: ['hémoglobine glyquée'],
    codes: ['HBA1C'],
    acceptedTubes: ['EDTA'],
    rejectedTubes: ['citrate'],
    stability: '7 jours à 2-8 °C',
    fieldSources: {
      name: { chunkId: hba1cRow, quote: 'HbA1c (hémoglobine glyquée)' },
      codes: { chunkId: hba1cRow, quote: 'Code : HBA1C' },
      accepted_tubes: { chunkId: hba1cRow, quote: 'Tube : EDTA' },
      rejected_tubes: { chunkId: hba1cRow, quote: 'Refusé : citrate' },
      stability: { chunkId: hba1cRow, quote: 'Stabilité : 7 jours à 2-8 °C' },
    },
  });

  const archivedRow = archivedCatalog.chunkIds[0]!;
  const archivedPotassium = await db.insertAnalysis({
    documentId: archivedCatalog.documentId,
    sourceChunkId: archivedRow,
    sourceQuote: 'Analyse : Potassium',
    name: 'Potassium',
    codes: ['K'],
    acceptedTubes: ['héparine de lithium'],
  });

  return {
    manualId: manual.documentId,
    archivedManualId: archivedManual.documentId,
    draftId: draft.documentId,
    catalogId: catalog.documentId,
    chunks: {
      cbcEdta: manual.chunkIds[0]!,
      serology: manual.chunkIds[1]!,
      ptCitrate: manual.chunkIds[2]!,
      ammonia: manual.chunkIds[3]!,
      archivedHeparin: archivedManual.chunkIds[0]!,
      draftGlucose: draft.chunkIds[0]!,
      hba1cRow,
      archivedCatalogRow: archivedRow,
    },
    analyses: { hba1c, archivedPotassium },
  };
}
