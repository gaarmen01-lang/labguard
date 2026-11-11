/** Erreurs de la boucle agent et correspondance avec les erreurs SSE du chat. */
import { LlmError, type ChatErrorCode } from '@/lib/contracts';

export type AgentErrorCode = 'aborted' | 'tools_unavailable';

const AGENT_ERROR_MESSAGES: Record<AgentErrorCode, string> = {
  aborted: 'La demande a été annulée.',
  tools_unavailable: 'La recherche dans les documents a échoué. Réessayez dans quelques instants.',
};

export class AgentError extends Error {
  readonly code: AgentErrorCode;

  constructor(code: AgentErrorCode, options: { cause?: unknown } = {}) {
    super(AGENT_ERROR_MESSAGES[code], { cause: options.cause });
    this.name = 'AgentError';
    this.code = code;
  }
}

export function isAbortError(error: unknown): boolean {
  if (error instanceof AgentError) return error.code === 'aborted';
  if (error instanceof LlmError) return error.code === 'aborted';
  return error instanceof Error && error.name === 'AbortError';
}

/** Erreur affichable (événement SSE `error`) pour une exception de runAgent. */
export function toChatError(error: unknown): { code: ChatErrorCode; message: string } {
  if (error instanceof LlmError) {
    if (error.code === 'rate_limit') return { code: 'rate_limited', message: error.message };
    if (error.code === 'aborted') return { code: 'internal', message: error.message };
    return { code: 'llm_unavailable', message: error.message };
  }
  if (error instanceof AgentError) return { code: 'internal', message: error.message };
  if (error instanceof Error && error.name === 'EnvError') {
    return { code: 'llm_unavailable', message: "Service d'IA non configuré." };
  }
  return { code: 'internal', message: 'Erreur interne. Réessayez dans quelques instants.' };
}
