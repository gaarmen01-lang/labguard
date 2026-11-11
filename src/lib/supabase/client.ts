/**
 * Client Supabase pour le NAVIGATEUR (composants client).
 * Session dans des cookies partagés avec le serveur (@supabase/ssr).
 * N'utilise que la clé publiable : toute la sécurité repose sur la RLS.
 */
import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';

import type { Database } from '@/lib/contracts/database';
import { getPublicEnv } from '@/lib/env-public';

export type BrowserSupabaseClient = SupabaseClient<Database>;

let browserClient: BrowserSupabaseClient | undefined;

export function getSupabaseBrowserClient(): BrowserSupabaseClient {
  if (browserClient) return browserClient;
  const env = getPublicEnv();
  browserClient = createBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
  return browserClient;
}
