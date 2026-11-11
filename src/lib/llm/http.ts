/**
 * POST JSON avec délai, nouvelles tentatives bornées (backoff exponentiel
 * + Retry-After) sur 429 / 5xx / erreur réseau, et annulation via `signal`.
 * `fetch` natif uniquement (injectable pour les tests).
 */
import { type LlmProviderName } from '@/lib/contracts/llm';

import {
  codeFromStatus,
  extractProviderError,
  isRetryableStatus,
  llmError,
  type ProviderErrorDetail,
} from './errors';

export const DEFAULT_TIMEOUT_MS = 60_000;
export const DEFAULT_MAX_RETRIES = 2;

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

/** Options communes à tous les adaptateurs HTTP. */
export interface LlmHttpOptions {
  /** `fetch` à utiliser (tests). Défaut : `globalThis.fetch`. */
  fetch?: FetchLike;
  /** Nouvelles tentatives après le premier essai (défaut 2). */
  maxRetries?: number;
  /** Premier délai d'attente avant nouvelle tentative (défaut 500 ms). */
  baseDelayMs?: number;
  /** Plafond d'un délai d'attente (défaut 10 s, Retry-After compris). */
  maxDelayMs?: number;
  /** Attente injectable (tests). */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface PostJsonParams {
  provider: LlmProviderName;
  url: string;
  headers: Record<string, string>;
  body: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
  http?: LlmHttpOptions;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function retryAfterMs(headers: Headers): number | undefined {
  const raw = headers.get('retry-after');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Renvoie le corps JSON d'une réponse 2xx ; lève une LlmError sinon. */
export async function postJson(params: PostJsonParams): Promise<unknown> {
  const { provider, url, headers, body, signal } = params;
  const http = params.http ?? {};
  const fetchImpl: FetchLike = http.fetch ?? ((input, init) => globalThis.fetch(input, init));
  const maxRetries = Math.max(0, http.maxRetries ?? DEFAULT_MAX_RETRIES);
  const baseDelay = http.baseDelayMs ?? 500;
  const maxDelay = http.maxDelayMs ?? 10_000;
  const sleep = http.sleep ?? abortableSleep;
  const timeoutMs = params.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const payload = JSON.stringify(body);

  for (let attempt = 0; ; attempt += 1) {
    if (signal?.aborted) throw llmError('aborted', provider, { cause: signal.reason });

    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort(new Error('timeout'));
    }, timeoutMs);
    const onAbort = () => controller.abort(signal?.reason);
    signal?.addEventListener('abort', onAbort, { once: true });

    let retryDelay: number | undefined;
    let lastError: unknown;
    try {
      let response: Response;
      let text: string;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json', ...headers },
          body: payload,
          signal: controller.signal,
        });
        text = await response.text();
      } catch (cause) {
        if (signal?.aborted) throw llmError('aborted', provider, { cause });
        if (timedOut) throw llmError('timeout', provider, { cause, retryable: false });
        // Erreur réseau (DNS, connexion coupée…) : nouvelle tentative possible.
        lastError = llmError('unavailable', provider, { cause });
        retryDelay = baseDelay * 2 ** attempt;
        if (attempt >= maxRetries) throw lastError;
        throw new RetrySignal();
      }

      const json = parseJson(text);
      if (response.ok) {
        if (json === undefined) {
          throw llmError('invalid_response', provider, {
            status: response.status,
            cause: { status: response.status, providerMessage: text.slice(0, 300) } satisfies ProviderErrorDetail,
          });
        }
        return json;
      }

      const extracted = extractProviderError(json ?? text);
      const detail: ProviderErrorDetail = {
        status: response.status,
        ...(extracted.message ? { providerMessage: extracted.message } : {}),
        ...(extracted.type ? { providerType: extracted.type } : {}),
      };
      const error = llmError(codeFromStatus(response.status), provider, {
        status: response.status,
        cause: detail,
        retryable: isRetryableStatus(response.status),
      });
      if (!isRetryableStatus(response.status) || attempt >= maxRetries) throw error;
      lastError = error;
      retryDelay = retryAfterMs(response.headers) ?? baseDelay * 2 ** attempt;
      throw new RetrySignal();
    } catch (error) {
      if (!(error instanceof RetrySignal)) throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    }

    // Backoff exponentiel avec un peu d'aléa (évite les rafales synchronisées).
    const jitter = Math.floor(Math.random() * Math.min(250, baseDelay));
    const delay = Math.min(maxDelay, (retryDelay ?? baseDelay) + jitter);
    try {
      await sleep(delay, signal);
    } catch (cause) {
      throw llmError('aborted', provider, { cause: cause ?? lastError });
    }
  }
}

class RetrySignal extends Error {}
