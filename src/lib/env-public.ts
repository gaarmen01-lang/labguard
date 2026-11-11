/**
 * Variables d'environnement PUBLIQUES (exposées au navigateur).
 *
 * Next.js n'injecte une variable NEXT_PUBLIC_* dans le bundle client que si
 * elle est lue littéralement (`process.env.NEXT_PUBLIC_X`) : ne pas
 * factoriser ces accès. Validation paresseuse : rien n'est lu au build.
 */
import { z } from 'zod';

export class EnvError extends Error {
  readonly missing: string[];

  constructor(message: string, missing: string[] = []) {
    super(message);
    this.name = 'EnvError';
    this.missing = missing;
  }
}

const publicEnvSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.url(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: z.string().min(20),
  NEXT_PUBLIC_APP_URL: z.url().optional(),
});
export type PublicEnv = z.infer<typeof publicEnvSchema>;

/** Transforme une erreur zod en message clair listant les variables fautives. */
export function envErrorFrom(error: z.ZodError, scope: string): EnvError {
  const names = [...new Set(error.issues.map((issue) => String(issue.path[0] ?? '?')))];
  return new EnvError(
    `Configuration ${scope} invalide ou incomplète : ${names.join(', ')}. ` +
      'Renseignez ces variables (voir .env.example) puis redémarrez le serveur.',
    names,
  );
}

function emptyToUndefined(value: string | undefined): string | undefined {
  return value === undefined || value.trim() === '' ? undefined : value.trim();
}

export function getPublicEnv(): PublicEnv {
  const parsed = publicEnvSchema.safeParse({
    NEXT_PUBLIC_SUPABASE_URL: emptyToUndefined(process.env.NEXT_PUBLIC_SUPABASE_URL),
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: emptyToUndefined(
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
    ),
    NEXT_PUBLIC_APP_URL: emptyToUndefined(process.env.NEXT_PUBLIC_APP_URL),
  });
  if (!parsed.success) throw envErrorFrom(parsed.error, 'publique');
  return parsed.data;
}
