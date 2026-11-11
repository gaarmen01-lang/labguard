/**
 * Petits utilitaires communs aux routes /api/admin/documents/**.
 */
import { z } from 'zod';

import { parseOrThrow, readJson } from '@/lib/auth/errors';

export interface IdRouteContext {
  params: Promise<{ id: string }>;
}

const idSchema = z.object({ id: z.uuid({ error: 'Identifiant de document invalide.' }) });

export async function documentIdFrom(context: IdRouteContext): Promise<string> {
  return parseOrThrow(idSchema, await context.params).id;
}

/** Corps JSON optionnel : vide -> {}. */
export async function readOptionalJson(request: Request): Promise<unknown> {
  const text = await request.clone().text();
  if (text.trim() === '') return {};
  return readJson(request);
}

export const NO_STORE = { 'Cache-Control': 'no-store' } as const;
