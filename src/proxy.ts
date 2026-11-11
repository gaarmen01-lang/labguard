/**
 * Proxy Next.js (ex-middleware) exécuté avant chaque requête :
 *  1. génère un nonce et pose la CSP stricte ;
 *  2. rafraîchit la session Supabase (cookies) ;
 *  3. redirige vers /login (pages) ou répond 401 (API) sans session.
 *
 * Ce n'est qu'un premier filtre : pages et routes revérifient l'utilisateur
 * ET son autorisation en base (src/lib/auth/session.ts).
 */
import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { errorBody } from '@/lib/auth/errors';
import type { Database } from '@/lib/contracts/database';
import { getPublicEnv, type PublicEnv } from '@/lib/env-public';
import { buildCsp, generateNonce } from '@/lib/security/csp';

const PUBLIC_PATHS = new Set(['/login', '/auth/confirm', '/auth/signout', '/api/auth/magic-link']);

function isPublicPath(pathname: string): boolean {
  return PUBLIC_PATHS.has(pathname);
}

function tryPublicEnv(): PublicEnv | null {
  try {
    return getPublicEnv();
  } catch {
    return null;
  }
}

export async function proxy(request: NextRequest) {
  const env = tryPublicEnv();
  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    isDev: process.env.NODE_ENV === 'development',
    supabaseOrigin: env ? new URL(env.NEXT_PUBLIC_SUPABASE_URL).origin : undefined,
  });

  const cookiesToSet: Array<{ name: string; value: string; options: Parameters<NextResponse['cookies']['set']>[2] }> = [];
  const extraHeaders: Record<string, string> = {};
  let userId: string | null = null;

  if (env) {
    const supabase = createServerClient<Database>(
      env.NEXT_PUBLIC_SUPABASE_URL,
      env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll();
          },
          setAll(cookies, headers) {
            for (const { name, value, options } of cookies) {
              // Met aussi à jour les cookies de la requête transmise au rendu.
              request.cookies.set(name, value);
              cookiesToSet.push({ name, value, options });
            }
            Object.assign(extraHeaders, headers);
          },
        },
      },
    );
    // getClaims() valide le JWT (et le rafraîchit si besoin). Ne rien mettre
    // entre la création du client et cet appel.
    const { data } = await supabase.auth.getClaims();
    userId = typeof data?.claims?.sub === 'string' ? data.claims.sub : null;
  }

  const finalize = (response: NextResponse): NextResponse => {
    for (const { name, value, options } of cookiesToSet) response.cookies.set(name, value, options);
    for (const [key, value] of Object.entries(extraHeaders)) response.headers.set(key, value);
    response.headers.set('Content-Security-Policy', csp);
    return response;
  };

  const { pathname, search } = request.nextUrl;
  // Sans configuration Supabase, on laisse passer : pages et routes lèveront
  // une erreur de configuration explicite (EnvError) au lieu de boucler.
  if (env && !userId && !isPublicPath(pathname)) {
    if (pathname.startsWith('/api/')) {
      return finalize(NextResponse.json(errorBody('unauthenticated'), { status: 401 }));
    }
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = '/login';
    loginUrl.search = '';
    if (pathname !== '/') loginUrl.searchParams.set('next', `${pathname}${search}`);
    return finalize(NextResponse.redirect(loginUrl));
  }

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);
  requestHeaders.set('Content-Security-Policy', csp);
  return finalize(NextResponse.next({ request: { headers: requestHeaders } }));
}

export const config = {
  matcher: [
    {
      source: '/((?!_next/static|_next/image|favicon.ico|robots.txt|.*\\.(?:svg|png|jpg|jpeg|gif|webp|ico)$).*)',
      missing: [
        { type: 'header', key: 'next-router-prefetch' },
        { type: 'header', key: 'purpose', value: 'prefetch' },
      ],
    },
  ],
};
