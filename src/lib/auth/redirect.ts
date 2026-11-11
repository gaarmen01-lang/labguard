/**
 * Chemin de retour après connexion : uniquement un chemin relatif interne,
 * jamais une URL externe (« //evil.com », « /\evil.com », « https:… »).
 */
export function safeNextPath(next: string | null | undefined, fallback = '/'): string {
  if (!next || next.length > 200) return fallback;
  if (!next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) return fallback;
  // Caractères de contrôle et antislash refusés.
  if (/[\u0000-\u001f\\]/.test(next)) return fallback;
  try {
    const url = new URL(next, 'http://labguard.invalid');
    if (url.origin !== 'http://labguard.invalid') return fallback;
    if (url.pathname.startsWith('/auth/') || url.pathname === '/login') return fallback;
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return fallback;
  }
}
