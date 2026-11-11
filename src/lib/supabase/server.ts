/**
 * Client Supabase côté serveur (Server Components, Route Handlers, Server
 * Actions) agissant AU NOM de l'utilisateur connecté : la RLS s'applique.
 * Un client par requête (ne jamais le partager entre requêtes).
 */
import 'server-only';

import { createServerClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import type { Database } from '@/lib/contracts/database';
import { getPublicEnv } from '@/lib/env';

export type ServerSupabaseClient = SupabaseClient<Database>;

export async function createSupabaseServerClient(): Promise<ServerSupabaseClient> {
  const env = getPublicEnv();
  const cookieStore = await cookies();
  return createServerClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet) {
          try {
            for (const { name, value, options } of cookiesToSet) {
              cookieStore.set(name, value, options);
            }
          } catch {
            // Appelé depuis un Server Component (cookies en lecture seule) :
            // le proxy (src/proxy.ts) rafraîchit déjà la session.
          }
        },
      },
    },
  );
}
