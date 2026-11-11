/**
 * Construction des LlmError : message destiné à l'utilisateur (français, sans
 * détail technique) ; le détail du fournisseur part dans `cause` (journaux).
 */
import { LlmError, type LlmErrorCode, type LlmProviderName } from '@/lib/contracts/llm';

export const LLM_ERROR_MESSAGES: Record<LlmErrorCode, string> = {
  auth: "Le service d'IA a refusé l'authentification (clé API invalide, expirée ou sans droits).",
  rate_limit: "Le service d'IA est momentanément saturé. Réessayez dans quelques instants.",
  timeout: "Le service d'IA n'a pas répondu à temps. Réessayez dans quelques instants.",
  bad_request: "La requête envoyée au service d'IA a été refusée (configuration ou modèle incorrect).",
  unavailable: "Le service d'IA est momentanément indisponible. Réessayez dans quelques instants.",
  invalid_response: "Le service d'IA a renvoyé une réponse inexploitable.",
  aborted: 'La demande a été annulée.',
  unknown: "Erreur inattendue lors de l'appel au service d'IA.",
};

export interface ProviderErrorDetail {
  status?: number;
  /** Message brut du fournisseur (jamais montré à l'utilisateur). */
  providerMessage?: string;
  providerType?: string;
}

export function llmError(
  code: LlmErrorCode,
  provider: LlmProviderName,
  options: { status?: number; cause?: unknown; retryable?: boolean } = {},
): LlmError {
  return new LlmError(LLM_ERROR_MESSAGES[code], {
    code,
    provider,
    ...(options.status !== undefined ? { status: options.status } : {}),
    ...(options.retryable !== undefined ? { retryable: options.retryable } : {}),
    cause: options.cause,
  });
}

/** Code d'erreur stable à partir d'un statut HTTP. */
export function codeFromStatus(status: number): LlmErrorCode {
  if (status === 401 || status === 403) return 'auth';
  if (status === 408) return 'timeout';
  if (status === 429) return 'rate_limit';
  if (status >= 500) return 'unavailable';
  if (status >= 400) return 'bad_request';
  return 'unknown';
}

/** Statuts pour lesquels une nouvelle tentative a un sens. */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

/**
 * Extrait un message d'erreur des formats usuels :
 *  - OpenAI / compatibles : { error: { message, type, code } }
 *  - Anthropic : { type: 'error', error: { type, message } }
 *  - Mistral : { message, type, code } ou { detail: [...] } (validation)
 */
export function extractProviderError(body: unknown): { message?: string; type?: string } {
  if (!body || typeof body !== 'object') return typeof body === 'string' ? { message: body.slice(0, 500) } : {};
  const record = body as Record<string, unknown>;
  const nested = record.error;
  if (nested && typeof nested === 'object') {
    const err = nested as Record<string, unknown>;
    return {
      ...(typeof err.message === 'string' ? { message: err.message } : {}),
      ...(typeof err.type === 'string' ? { type: err.type } : {}),
    };
  }
  if (typeof nested === 'string') return { message: nested };
  if (typeof record.message === 'string') {
    return { message: record.message, ...(typeof record.type === 'string' ? { type: record.type } : {}) };
  }
  if (record.detail !== undefined) {
    return { message: typeof record.detail === 'string' ? record.detail : JSON.stringify(record.detail).slice(0, 500) };
  }
  return {};
}

export function isLlmError(error: unknown): error is LlmError {
  return error instanceof LlmError;
}
