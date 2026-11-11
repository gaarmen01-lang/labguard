/**
 * Vérification serveur des citations d'extraction : une valeur n'est retenue
 * que si sa citation figure mot pour mot dans le chunk source
 * (`quoteAppearsIn`, même règle que la vérification des réponses) ET si la
 * valeur est bien portée par la citation (ses mots y figurent).
 */
import { normalizeTokens, quoteAppearsIn } from '@/lib/contracts';

const STOP_WORDS = new Set(['de', 'du', 'des', 'la', 'le', 'les', 'l', 'd', 'a', 'au', 'aux', 'et', 'en', 'un', 'une', 'sur', 'pour']);

function significantTokens(value: string): string[] {
  return normalizeTokens(value)
    .split(' ')
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
}

/** La citation figure-t-elle dans le texte source ? */
export function isVerbatimQuote(quote: string | null | undefined, source: string): quote is string {
  return typeof quote === 'string' && quote.trim().length > 0 && quoteAppearsIn(quote, source);
}

/**
 * La valeur est-elle portée par la citation ? Tous ses mots significatifs
 * doivent figurer dans la citation (tolérance : 1 mot sur 6, pour une
 * reformulation minime comme un accord).
 */
export function isSupportedBy(value: string, quote: string): boolean {
  const valueTokens = significantTokens(value);
  if (valueTokens.length === 0) return false;
  const quoteTokens = new Set(significantTokens(quote));
  const missing = valueTokens.filter((token) => !quoteTokens.has(token)).length;
  return missing <= Math.floor(valueTokens.length / 6);
}
