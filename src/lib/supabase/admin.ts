/**
 * Client Supabase « service_role » : CONTOURNE LA RLS.
 *
 * Strictement serveur. Usages autorisés :
 *  - amorçage / lecture de la liste blanche avant connexion ;
 *  - ingestion (tâche 2) ;
 *  - écriture des messages et sources VÉRIFIÉS (tâche 4).
 * Toujours après requireUser()/requireAdmin(), jamais avec des identifiants
 * fournis par le client sans contrôle.
 */
import 'server-only';

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/contracts/database';
import { getServerEnv } from '@/lib/env';

export type AdminSupabaseClient = SupabaseClient<Database>;

let adminClient: AdminSupabaseClient | undefined;

export function getSupabaseAdminClient(): AdminSupabaseClient {
  if (adminClient) return adminClient;
  const env = getServerEnv();
  adminClient = createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return adminClient;
}
