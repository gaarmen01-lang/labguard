/**
 * Câblage serveur de l'ingestion : dépôt et stockage Supabase (service_role),
 * fournisseur LLM éventuel. Point unique remplacé (vi.mock) dans les tests de
 * routes.
 */
import 'server-only';

import { HttpError, errorResponse } from '@/lib/auth/errors';
import type { LlmProvider } from '@/lib/contracts';
import { EnvError } from '@/lib/env';
import { getLlmProvider } from '@/lib/llm';
import { getSupabaseAdminClient } from '@/lib/supabase/admin';

import type { AdminDeps } from './admin';
import { IngestionError } from './errors';
import type { PipelineDeps } from './pipeline';
import { createSupabaseRepository, createSupabaseStorage } from './supabase';

/** Fournisseur LLM configuré, ou null (l'ingestion fonctionne alors sans LLM). */
export function resolveIngestionLlm(): LlmProvider | null {
  try {
    return getLlmProvider();
  } catch (error) {
    if (error instanceof EnvError) return null;
    throw error;
  }
}

export function getAdminDeps(): AdminDeps {
  const client = getSupabaseAdminClient();
  return { repo: createSupabaseRepository(client), storage: createSupabaseStorage(client) };
}

export function getPipelineDeps(): PipelineDeps {
  return { ...getAdminDeps(), llm: resolveIngestionLlm() };
}

/** errorResponse + traduction des IngestionError en erreurs HTTP lisibles. */
export function ingestionErrorResponse(error: unknown): Response {
  if (error instanceof IngestionError) {
    const code = error.code === 'storage_unavailable' || error.code === 'llm_unavailable' ? 'unavailable' : error.code === 'internal' ? 'internal' : 'bad_request';
    if (code === 'internal') return errorResponse(error);
    return errorResponse(new HttpError(code, error.message));
  }
  return errorResponse(error);
}
