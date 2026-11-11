/**
 * Liste blanche des emails autorisés (table allowed_emails), lue AVANT la
 * connexion, donc avec le client service_role.
 *
 * Amorçage : les emails de LABGUARD_ADMIN_EMAILS sont (ré)inscrits comme
 * admin dans allowed_emails dès qu'ils demandent un lien. Cela permet de
 * créer le premier admin sans accès SQL.
 */
import 'server-only';

import { getServerEnv } from '@/lib/env';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

export async function isEmailAllowed(email: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  const env = getServerEnv();
  const admin = getSupabaseAdminClient();

  if (env.adminEmails.includes(normalized)) {
    const { error } = await admin
      .from('allowed_emails')
      .upsert({ email: normalized, role: 'admin', note: 'LABGUARD_ADMIN_EMAILS' }, { onConflict: 'email' });
    if (error) throw error;
    return true;
  }

  const { data, error } = await admin
    .from('allowed_emails')
    .select('email')
    .eq('email', normalized)
    .maybeSingle();
  if (error) throw error;
  return data !== null;
}
