/**
 * Content-Security-Policy stricte à base de nonce (appliquée par src/proxy.ts).
 *
 * Conséquences pour l'UI :
 *  - pas de <script> inline sans nonce (Next.js ajoute le nonce à ses scripts) ;
 *  - pas d'attribut `style="…"` rendu côté serveur en production : utiliser
 *    des classes CSS ;
 *  - le navigateur ne peut appeler que l'origine de l'app et Supabase.
 */
export interface CspOptions {
  nonce: string;
  isDev: boolean;
  /** Origine Supabase (https://xxx.supabase.co) pour connect-src. */
  supabaseOrigin?: string | undefined;
}

export function buildCsp({ nonce, isDev, supabaseOrigin }: CspOptions): string {
  const connect = ["'self'"];
  if (supabaseOrigin) {
    connect.push(supabaseOrigin);
    connect.push(supabaseOrigin.replace(/^http/, 'ws'));
  }
  const directives: Array<[string, string[]]> = [
    ['default-src', ["'self'"]],
    ['script-src', ["'self'", `'nonce-${nonce}'`, "'strict-dynamic'", ...(isDev ? ["'unsafe-eval'"] : [])]],
    // En dev, l'injection CSS à chaud de Next n'a pas de nonce.
    ['style-src', ["'self'", isDev ? "'unsafe-inline'" : `'nonce-${nonce}'`]],
    ['img-src', ["'self'", 'blob:', 'data:']],
    ['font-src', ["'self'"]],
    ['connect-src', connect],
    ['object-src', ["'none'"]],
    ['base-uri', ["'self'"]],
    ['form-action', ["'self'"]],
    ['frame-ancestors', ["'none'"]],
    ['worker-src', ["'self'", 'blob:']],
    ['manifest-src', ["'self'"]],
  ];
  const policy = directives.map(([name, values]) => `${name} ${values.join(' ')}`);
  if (!isDev) policy.push('upgrade-insecure-requests');
  return policy.join('; ');
}

export function generateNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return btoa(String.fromCharCode(...bytes));
}
