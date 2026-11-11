/**
 * Normalisation de texte partagée.
 *
 * `normalizeTokens` est le miroir exact de la fonction SQL `public.lg_tokens`
 * (minuscules, sans accents, tout ce qui n'est pas [a-z0-9] devient une
 * espace). Un test vérifie la parité avec Postgres (tests/db/text-parity.test.ts).
 * Elle sert de base à la vérification des citations (tâche 3) : une citation
 * est valide si normalizeTokens(quote) est contenu dans normalizeTokens(chunk).
 */

// Caractères que la décomposition Unicode (NFD) ne traite pas comme le
// dictionnaire `unaccent` de Postgres (ligatures, lettres barrées, ponctuation
// typographique, symboles courants). Liste vérifiée par le test de parité.
const SPECIAL_CHARS: Record<string, string> = {
  œ: 'oe', Œ: 'OE', æ: 'ae', Æ: 'AE', ß: 'ss', ø: 'o', Ø: 'O', ł: 'l', Ł: 'L',
  đ: 'd', Đ: 'D', ı: 'i', ŀ: 'l', Ŀ: 'L', ĳ: 'ij', Ĳ: 'IJ',
  ﬀ: 'ff', ﬁ: 'fi', ﬂ: 'fl', ﬃ: 'ffi', ﬄ: 'ffl',
  'µ': 'μ', '©': '(C)', '®': '(R)', '½': ' 1/2', '¼': ' 1/4', '¾': ' 3/4', '×': '*', '±': '+/-',
  '—': '-', '–': '-', '…': '...', '’': "'", '‘': "'", '“': '"', '”': '"', '«': '<<', '»': '>>',
};

const SPECIAL_RE = new RegExp(`[${Object.keys(SPECIAL_CHARS).join('')}]`, 'gu');

/** Minuscules sans accents (miroir de `public.lg_normalize`). */
export function normalizeText(input: string): string {
  return input
    .replace(SPECIAL_RE, (char) => SPECIAL_CHARS[char] ?? char)
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase();
}

/** Miroir de `public.lg_tokens`. */
export function normalizeTokens(input: string): string {
  return normalizeText(input)
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Vrai si `quote` apparaît textuellement dans `source` après normalisation.
 * Une citation vide (ou réduite à de la ponctuation) n'est jamais valide.
 */
export function quoteAppearsIn(quote: string, source: string): boolean {
  const needle = normalizeTokens(quote);
  if (needle.length === 0) return false;
  return ` ${normalizeTokens(source)} `.includes(` ${needle} `);
}
