/**
 * Vérification de l'utilisateur côté serveur. Ne jamais faire confiance au
 * client : chaque route / page protégée appelle l'un de ces helpers.
 *
 *   Route Handlers : requireUser() / requireAdmin() -> lèvent HttpError 401/403
 *                    (à convertir avec errorResponse()).
 *   Pages / layouts : requirePageUser() / requirePageAdmin() -> redirigent.
 *
 * L'utilisateur est validé auprès du serveur Auth (getUser), puis son profil
 * est relu en base (allowed / role) : une révocation prend effet immédiatement.
 */
import 'server-only';

import { redirect } from 'next/navigation';
import { cache } from 'react';

import type { Profile } from '@/lib/contracts/domain';
import { createSupabaseServerClient, type ServerSupabaseClient } from '@/lib/supabase/server';

import { HttpError } from './errors';

export interface AuthContext {
  userId: string;
  email: string;
  profile: Profile;
  isAdmin: boolean;
  /** Client agissant au nom de l'utilisateur (RLS appliquée). */
  supabase: ServerSupabaseClient;
}

export type AuthState =
  | { status: 'anonymous' }
  | { status: 'not_allowed'; userId: string; email: string }
  | { status: 'ok'; context: AuthContext };

async function resolveAuthStateUncached(): Promise<AuthState> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return { status: 'anonymous' };

  const user = data.user;
  const email = (user.email ?? '').toLowerCase();
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('*')
    .eq('id', user.id)
    .maybeSingle();
  if (profileError) throw profileError;
  if (!profile || !profile.allowed) return { status: 'not_allowed', userId: user.id, email };

  return {
    status: 'ok',
    context: {
      userId: user.id,
      email,
      profile,
      isAdmin: profile.role === 'admin',
      supabase,
    },
  };
}

/** Mémorisé pour la durée d'un rendu serveur. */
export const getAuthState = cache(resolveAuthStateUncached);

export async function requireUser(): Promise<AuthContext> {
  const state = await getAuthState();
  if (state.status === 'anonymous') throw new HttpError('unauthenticated');
  if (state.status === 'not_allowed') {
    throw new HttpError('forbidden', "Votre adresse n'est pas autorisée à utiliser LabGuard.");
  }
  return state.context;
}

export async function requireAdmin(): Promise<AuthContext> {
  const context = await requireUser();
  if (!context.isAdmin) throw new HttpError('forbidden', 'Accès réservé aux administrateurs.');
  return context;
}

export async function requirePageUser(nextPath = '/'): Promise<AuthContext> {
  const state = await getAuthState();
  if (state.status === 'anonymous') redirect(`/login?next=${encodeURIComponent(nextPath)}`);
  if (state.status === 'not_allowed') redirect('/login?error=not_allowed');
  return state.context;
}

export async function requirePageAdmin(): Promise<AuthContext> {
  const context = await requirePageUser('/admin');
  if (!context.isAdmin) redirect('/?error=forbidden');
  return context;
}
