/**
 * Erreurs HTTP des routes API et leur sérialisation (ApiErrorBody).
 * Les messages sont en français et ne révèlent aucun détail interne.
 */
import type { z } from 'zod';

import type { ApiErrorBody, ApiErrorCode } from '@/lib/contracts/api';
import { EnvError } from '@/lib/env-public';

const STATUS_BY_CODE: Record<ApiErrorCode, number> = {
  bad_request: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal: 500,
  unavailable: 503,
};

const DEFAULT_MESSAGES: Record<ApiErrorCode, string> = {
  bad_request: 'Requête invalide.',
  unauthenticated: 'Vous devez être connecté.',
  forbidden: 'Accès refusé.',
  not_found: 'Ressource introuvable.',
  conflict: 'Conflit avec l’état actuel.',
  payload_too_large: 'Contenu trop volumineux.',
  rate_limited: 'Trop de requêtes, réessayez dans un instant.',
  internal: 'Erreur interne. Réessayez plus tard.',
  unavailable: 'Service temporairement indisponible.',
};

export class HttpError extends Error {
  readonly code: ApiErrorCode;
  readonly status: number;
  readonly issues: ApiErrorBody['error']['issues'];

  constructor(code: ApiErrorCode, message?: string, issues?: ApiErrorBody['error']['issues']) {
    super(message ?? DEFAULT_MESSAGES[code]);
    this.name = 'HttpError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    this.issues = issues;
  }
}

export function zodIssues(error: z.ZodError): NonNullable<ApiErrorBody['error']['issues']> {
  return error.issues.map((issue) => ({
    path: issue.path.map(String).join('.'),
    message: issue.message,
  }));
}

/** Valide `data` ou lève HttpError(400) avec le détail des champs. */
export function parseOrThrow<T extends z.ZodType>(schema: T, data: unknown): z.output<T> {
  const parsed = schema.safeParse(data);
  if (!parsed.success) {
    throw new HttpError('bad_request', 'Requête invalide.', zodIssues(parsed.error));
  }
  return parsed.data;
}

/** Lit le corps JSON d'une requête ou lève HttpError(400). */
export async function readJson(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    throw new HttpError('bad_request', 'Le corps de la requête doit être du JSON valide.');
  }
}

export function errorBody(code: ApiErrorCode, message?: string, issues?: ApiErrorBody['error']['issues']): ApiErrorBody {
  return { error: { code, message: message ?? DEFAULT_MESSAGES[code], ...(issues ? { issues } : {}) } };
}

/** Convertit n'importe quelle erreur en réponse JSON sûre. */
export function errorResponse(error: unknown): Response {
  if (error instanceof HttpError) {
    return Response.json(errorBody(error.code, error.message, error.issues), { status: error.status });
  }
  if (error instanceof EnvError) {
    console.error('[labguard] configuration :', error.message);
    return Response.json(errorBody('unavailable', 'Service non configuré. Contactez un administrateur.'), {
      status: 503,
    });
  }
  console.error('[labguard] erreur non gérée :', error);
  return Response.json(errorBody('internal'), { status: 500 });
}
