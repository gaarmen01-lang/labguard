/**
 * Correspondance « intitulé de colonne » -> champ de fiche d'analyse, pour
 * l'extraction déterministe des tableaux (catalogues XLSX/CSV, tableaux PDF ou
 * DOCX à en-têtes reconnus).
 */
import { normalizeTokens, type AnalysisField } from '@/lib/contracts';

const EXACT: Record<string, AnalysisField> = {};

function register(field: AnalysisField, labels: string[]): void {
  for (const label of labels) EXACT[normalizeTokens(label)] = field;
}

register('name', [
  'analyse', 'analyses', 'examen', 'examens', 'nom', "nom de l'analyse", "nom de l'examen", 'libellé',
  "libellé de l'analyse", "libellé de l'examen", 'paramètre', 'test', 'désignation', 'intitulé',
]);
register('codes', ['code', 'codes', 'code analyse', "code de l'analyse", 'code labo', 'mnémonique', 'code interne', 'code examen']);
register('synonyms', ['synonyme', 'synonymes', 'autres noms', 'autre nom', 'alias', 'appellations', 'abréviations']);
register('accepted_tubes', [
  'tube', 'tubes', 'tube(s)', 'tube(s) accepté(s)', 'tubes acceptés', 'tube accepté', 'récipient', 'contenant',
  'type de tube', 'tube à prélever', 'nature du tube', 'tube de prélèvement', 'échantillon', 'nature de l’échantillon',
  "nature de l'échantillon", 'matrice',
]);
register('rejected_tubes', [
  'tube refusé', 'tubes refusés', 'tube(s) refusé(s)', 'tube non accepté', 'tubes non acceptés', 'refusé', 'refusés',
  'non accepté', 'tubes interdits', 'tube interdit', 'non conforme', 'tubes non conformes',
]);
register('volume', ['volume', 'volume minimal', 'volume minimum', 'volume (ml)', 'volume minimal (ml)', 'quantité', 'volume requis']);
register('transport', [
  'transport', 'conservation / transport', 'conservation et transport', 'conditions de transport', 'acheminement',
  'température de transport', 'transport / conservation',
]);
register('storage', ['conservation', 'stockage', 'conservation avant analyse', 'conditions de conservation']);
register('stability', ['stabilité', 'délai de stabilité', 'stabilité échantillon', "stabilité de l'échantillon"]);
register('turnaround_time', ['délai', 'délai de rendu', 'délai de résultat', 'délai de réponse', "délai d'obtention", 'rendu', 'délai de rendu des résultats']);
register('remarks', [
  'remarque', 'remarques', 'commentaire', 'commentaires', 'observations', 'observation', 'notes', 'note', 'précautions',
  'conditions particulières', 'informations', 'consignes',
]);

/** Champ correspondant à un intitulé de colonne, ou null. */
export function matchHeaderField(label: string): AnalysisField | null {
  const key = normalizeTokens(label);
  if (!key) return null;
  const exact = EXACT[key];
  if (exact) return exact;
  const words = key.split(' ');
  const has = (prefix: string) => words.some((word) => word.startsWith(prefix));
  if (has('tube') || has('recipient')) {
    if (has('refus') || has('interdit') || key.includes('non accept')) return 'rejected_tubes';
    if (has('accept')) return 'accepted_tubes';
  }
  if (has('stabilit')) return 'stability';
  if (has('delai') && (has('rendu') || has('resultat') || has('reponse'))) return 'turnaround_time';
  if (has('transport')) return 'transport';
  if (has('volume')) return 'volume';
  if (has('remarque') || has('commentaire')) return 'remarks';
  if (has('synonyme')) return 'synonyms';
  return null;
}

export interface HeaderMapping {
  /** Colonne -> champ (null si non reconnue). Un champ n'est attribué qu'une fois. */
  columns: Array<AnalysisField | null>;
  /** Vrai si le tableau décrit des analyses (une ligne = une analyse). */
  isCatalog: boolean;
}

/** Un catalogue = une colonne « nom d'analyse » + au moins deux autres champs reconnus. */
export function mapHeader(header: string[]): HeaderMapping {
  const used = new Set<AnalysisField>();
  const columns = header.map((label) => {
    const field = matchHeaderField(label);
    if (!field || used.has(field)) return null;
    used.add(field);
    return field;
  });
  const isCatalog = used.has('name') && used.size >= 3;
  return { columns, isCatalog };
}

/** Intitulés d'en-tête reconnus (pour distinguer un en-tête d'une ligne de données). */
export function countKnownHeaders(cells: string[]): number {
  return cells.filter((cell) => matchHeaderField(cell) !== null).length;
}
