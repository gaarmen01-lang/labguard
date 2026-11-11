/**
 * GET /auth/confirm — retour du lien magique.
 *
 * Accepte les deux formats Supabase :
 *  - `?token_hash=…&type=email` (recommandé : modèle d'email Supabase à
 *    adapter, fonctionne même si le lien est ouvert sur un autre appareil) ;
 *  - `?code=…` (PKCE par défaut : même navigateur que la demande).
 * Puis revérifie que l'adresse est autorisée avant d'ouvrir l'application.
 */
import type { EmailOtpType } from '@supabase/supabase-js';
import { NextResponse, type NextRequest } from 'next/server';

import { safeNextPath } from '@/lib/auth/redirect';
import { getAuthState } from '@/lib/auth/session';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const OTP_TYPES: readonly EmailOtpType[] = ['email', 'magiclink', 'signup', 'invite'];

function isOtpType(value: string | null): value is EmailOtpType {
  return value !== null && (OTP_TYPES as readonly string[]).includes(value);
}

export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const next = safeNextPath(url.searchParams.get('next'));
  const tokenHash = url.searchParams.get('token_hash');
  const type = url.searchParams.get('type');
  const code = url.searchParams.get('code');

  const toLogin = (error: string) => {
    const target = new URL('/login', url.origin);
    target.searchParams.set('error', error);
    return NextResponse.redirect(target, 303);
  };

  try {
    const supabase = await createSupabaseServerClient();
    let failed = true;
    if (tokenHash && isOtpType(type)) {
      const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
      failed = Boolean(error);
    } else if (code) {
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      failed = Boolean(error);
    }
    if (failed) return toLogin('link_invalid');

    const state = await getAuthState();
    if (state.status !== 'ok') {
      await supabase.auth.signOut();
      return toLogin('not_allowed');
    }
    return NextResponse.redirect(new URL(next, url.origin), 303);
  } catch (error) {
    console.error('[labguard] confirmation de connexion impossible :', error);
    return toLogin('link_invalid');
  }
}
