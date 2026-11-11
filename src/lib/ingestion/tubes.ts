/**
 * Normalisation des libellés de tubes à partir du glossaire `synonyms`.
 *
 * Le libellé original est TOUJOURS conservé. Si le glossaire reconnaît le tube
 * et que le libellé ne contient pas déjà la forme canonique, l'entrée devient
 * « Canonique (« libellé original ») », ex. « EDTA (« Tube violet ») » : la
 * recherche (FTS + glossaire) retrouve la fiche par le nom canonique comme par
 * la couleur, et l'affichage reste fidèle au document.
 */
import { normalizeTokens } from '@/lib/contracts';

export interface GlossaryEntry {
  group_key: string;
  term: string;
}

/** Libellés canoniques des groupes de tubes du glossaire initial. */
export const CANONICAL_TUBE_LABELS: Record<string, string> = {
  tube_edta: 'EDTA',
  tube_citrate: 'Citrate',
  tube_heparin: 'Héparine',
  tube_heparin_gel: 'Héparine avec gel',
  tube_serum_plain: 'Tube sec',
  tube_serum_gel: 'Tube sec avec gel',
  tube_fluoride: 'Fluorure',
  tube_esr: 'Tube VS',
  tube_trace_elements: 'Tube oligo-éléments',
  tube_acd: 'ACD',
  blood_culture: 'Hémoculture',
};

export function isTubeGroup(groupKey: string): boolean {
  return groupKey.startsWith('tube_') || groupKey === 'blood_culture';
}

export interface TubeMatcher {
  /** Groupe du glossaire reconnu dans le libellé (terme le plus long), ou null. */
  match(label: string): { groupKey: string; canonical: string } | null;
  /** Entrée à stocker dans accepted_tubes / rejected_tubes. */
  format(label: string): string;
  /** Termes de tubes connus (normalisés), pour repérer un passage qui parle de tubes. */
  readonly terms: string[];
}

export function createTubeMatcher(glossary: GlossaryEntry[]): TubeMatcher {
  const terms = glossary
    .filter((entry) => isTubeGroup(entry.group_key))
    .map((entry) => ({ groupKey: entry.group_key, norm: normalizeTokens(entry.term) }))
    .filter((entry) => entry.norm.length > 0)
    .sort((a, b) => b.norm.length - a.norm.length);
  const firstTermByGroup = new Map<string, string>();
  for (const entry of glossary) {
    if (isTubeGroup(entry.group_key) && !firstTermByGroup.has(entry.group_key)) {
      firstTermByGroup.set(entry.group_key, entry.term);
    }
  }
  const canonicalOf = (groupKey: string) =>
    CANONICAL_TUBE_LABELS[groupKey] ?? firstTermByGroup.get(groupKey) ?? groupKey;

  const match = (label: string) => {
    const padded = ` ${normalizeTokens(label)} `;
    const hit = terms.find((entry) => padded.includes(` ${entry.norm} `));
    return hit ? { groupKey: hit.groupKey, canonical: canonicalOf(hit.groupKey) } : null;
  };

  return {
    match,
    format(label) {
      const original = label.replace(/\s+/g, ' ').trim();
      const hit = match(original);
      if (!hit) return original;
      const canonicalNorm = normalizeTokens(hit.canonical);
      if (` ${normalizeTokens(original)} `.includes(` ${canonicalNorm} `)) return original;
      return `${hit.canonical} (« ${original} »)`;
    },
    terms: terms.map((entry) => entry.norm),
  };
}

/**
 * Découpe une cellule « tubes » en libellés : « ; », « ou », « / » entourés
 * d'espaces, et virgule suivie d'une lettre (« 3,2 % » n'est pas coupé), hors
 * parenthèses.
 */
export function splitTubeList(value: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]!;
    if (char === '(') depth += 1;
    if (char === ')') depth = Math.max(0, depth - 1);
    if (depth === 0) {
      const rest = value.slice(i);
      const separator =
        /^\s*;\s*/.exec(rest) ??
        /^\s+ou\s+/i.exec(rest) ??
        /^\s+\/\s+/.exec(rest) ??
        (char === ',' ? /^,\s+(?=\p{L})/u.exec(rest) : null);
      if (separator) {
        parts.push(current);
        current = '';
        i += separator[0].length - 1;
        continue;
      }
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}
