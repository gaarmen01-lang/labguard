/**
 * POST /api/auth/magic-link — demande d'un lien de connexion.
 *
 * La réponse est IDENTIQUE (statut, corps, durée minimale) que l'adresse soit
 * autorisée ou non, pour ne pas révéler la liste blanche. Le lien n'est
 * envoyé (et le compte Auth créé) que pour une adresse autorisée.
 */
import { errorResponse, parseOrThrow, readJson } from '@/lib/auth/errors';
import { isEmailAllowed } from '@/lib/auth/allowlist';
import { safeNextPath } from '@/lib/auth/redirect';
import { magicLinkRequestSchema, type MagicLinkResponse } from '@/lib/contracts/api';
import { getServerEnv } from '@/lib/env';
import { createSupabaseServerClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const GENERIC_MESSAGE =
  'Si cette adresse est autorisée, un lien de connexion vient de lui être envoyé. Pensez à vérifier les courriers indésirables.';

/** Durée minimale de réponse : atténue la différence de temps entre les deux cas. */
const MIN_RESPONSE_MS = 900;

export async function POST(request: Request) {
  const startedAt = Date.now();
  try {
    const body = parseOrThrow(magicLinkRequestSchema, await readJson(request));
    const env = getServerEnv();
    const next = safeNextPath(body.next);

    if (await isEmailAllowed(body.email)) {
      const origin = env.appUrl ?? new URL(request.url).origin;
      const redirectTo = new URL('/auth/confirm', origin);
      redirectTo.searchParams.set('next', next);
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.signInWithOtp({
        email: body.email,
        options: { shouldCreateUser: true, emailRedirectTo: redirectTo.toString() },
      });
      if (error) {
        // Journalisé côté serveur seulement : la réponse reste générique.
        console.error('[labguard] envoi du lien magique impossible :', error.message);
      }
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_RESPONSE_MS) {
      await new Promise((resolve) => setTimeout(resolve, MIN_RESPONSE_MS - elapsed));
    }
    const response: MagicLinkResponse = { ok: true, message: GENERIC_MESSAGE };
    return Response.json(response, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return errorResponse(error);
  }
}
