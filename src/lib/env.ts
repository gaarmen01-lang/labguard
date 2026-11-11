/**
 * Gestion centralisée des variables d'environnement côté SERVEUR.
 *
 * - Validation paresseuse (au premier appel, jamais à l'import ni au build).
 * - Une variable manquante lève EnvError avec la liste des noms fautifs.
 * - Les secrets (service_role, clé LLM) ne sont lisibles que via ce module,
 *   marqué `server-only` : l'importer depuis un composant client casse le build.
 */
import 'server-only';

import { z } from 'zod';

import { llmProviderNameSchema, type LlmConfig } from '@/lib/contracts/llm';

import { envErrorFrom, EnvError, getPublicEnv, type PublicEnv } from './env-public';

export { EnvError, getPublicEnv, type PublicEnv };

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

/** Liste d'emails séparés par virgules / espaces / points-virgules, normalisés. */
export function parseEmailList(raw: string | undefined): string[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(/[,;\s]+/)
        .map((email) => email.trim().toLowerCase())
        .filter((email) => email.includes('@')),
    ),
  ];
}

// --- Supabase (serveur) --------------------------------------------------------

const serverEnvSchema = z.object({
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(20),
  LABGUARD_ADMIN_EMAILS: z.string().optional(),
});

export interface ServerEnv extends PublicEnv {
  SUPABASE_SERVICE_ROLE_KEY: string;
  /** Emails amorçant le rôle admin (ajoutés à allowed_emails à la connexion). */
  adminEmails: string[];
  /** URL absolue de l'application (liens magiques). */
  appUrl: string | undefined;
}

let cachedServerEnv: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  if (cachedServerEnv) return cachedServerEnv;
  const publicEnv = getPublicEnv();
  const parsed = serverEnvSchema.safeParse({
    SUPABASE_SERVICE_ROLE_KEY: emptyToUndefined(process.env.SUPABASE_SERVICE_ROLE_KEY),
    LABGUARD_ADMIN_EMAILS: emptyToUndefined(process.env.LABGUARD_ADMIN_EMAILS),
  });
  if (!parsed.success) throw envErrorFrom(parsed.error, 'serveur');
  cachedServerEnv = {
    ...publicEnv,
    SUPABASE_SERVICE_ROLE_KEY: parsed.data.SUPABASE_SERVICE_ROLE_KEY,
    adminEmails: parseEmailList(parsed.data.LABGUARD_ADMIN_EMAILS),
    appUrl: publicEnv.NEXT_PUBLIC_APP_URL,
  };
  return cachedServerEnv;
}

// --- LLM ---------------------------------------------------------------------

const llmEnvSchema = z
  .object({
    LLM_PROVIDER: llmProviderNameSchema,
    LLM_MODEL: z.string().min(1),
    LLM_API_KEY: z.string().optional(),
    LLM_BASE_URL: z.url().optional(),
    LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(300_000).optional(),
  })
  .superRefine((env, ctx) => {
    if (env.LLM_PROVIDER !== 'fake' && !env.LLM_API_KEY) {
      ctx.addIssue({ code: 'custom', path: ['LLM_API_KEY'], message: 'requis' });
    }
    if (env.LLM_PROVIDER === 'openai_compatible' && !env.LLM_BASE_URL) {
      ctx.addIssue({ code: 'custom', path: ['LLM_BASE_URL'], message: 'requis' });
    }
  });

/**
 * Configuration du fournisseur LLM. Aucune valeur par défaut n'est inventée
 * pour le modèle : LLM_PROVIDER et LLM_MODEL doivent être définis.
 */
export function getLlmConfig(): LlmConfig {
  const parsed = llmEnvSchema.safeParse({
    LLM_PROVIDER: emptyToUndefined(process.env.LLM_PROVIDER),
    LLM_MODEL: emptyToUndefined(process.env.LLM_MODEL),
    LLM_API_KEY: emptyToUndefined(process.env.LLM_API_KEY),
    LLM_BASE_URL: emptyToUndefined(process.env.LLM_BASE_URL),
    LLM_TIMEOUT_MS: emptyToUndefined(process.env.LLM_TIMEOUT_MS),
  });
  if (!parsed.success) throw envErrorFrom(parsed.error, 'LLM');
  const env = parsed.data;
  return {
    provider: env.LLM_PROVIDER,
    model: env.LLM_MODEL,
    apiKey: env.LLM_API_KEY ?? '',
    ...(env.LLM_BASE_URL ? { baseUrl: env.LLM_BASE_URL } : {}),
    ...(env.LLM_TIMEOUT_MS ? { timeoutMs: env.LLM_TIMEOUT_MS } : {}),
  };
}

/** Réservé aux tests : oublie les valeurs mises en cache. */
export function resetEnvCacheForTests(): void {
  cachedServerEnv = undefined;
}
