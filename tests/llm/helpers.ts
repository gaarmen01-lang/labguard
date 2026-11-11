/** fetch mocké pour les tests d'adaptateurs (aucun réseau). */
import type { FetchLike, LlmHttpOptions } from '@/lib/llm/http';

export interface RecordedRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

type Reply =
  | { status?: number; json?: unknown; text?: string; headers?: Record<string, string> }
  | { networkError: true }
  | { hang: true };

export function jsonReply(json: unknown, status = 200, headers: Record<string, string> = {}): Reply {
  return { status, json, headers };
}

export function mockFetch(replies: Reply[]) {
  const requests: RecordedRequest[] = [];
  let index = 0;
  const fetch: FetchLike = async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    requests.push({ url, headers, body: JSON.parse(String(init.body)) as Record<string, unknown> });
    const reply = replies[index] ?? replies.at(-1);
    index += 1;
    if (!reply) throw new Error('aucune réponse prévue');
    if ('networkError' in reply) throw new TypeError('fetch failed');
    if ('hang' in reply) {
      return new Promise<Response>((_, reject) => {
        init.signal?.addEventListener('abort', () => reject(init.signal?.reason ?? new Error('aborted')), {
          once: true,
        });
      });
    }
    const body = reply.text ?? JSON.stringify(reply.json ?? {});
    return new Response(body, {
      status: reply.status ?? 200,
      headers: { 'content-type': 'application/json', ...reply.headers },
    });
  };
  const sleeps: number[] = [];
  const http: LlmHttpOptions = {
    fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  };
  return { fetch, http, requests, sleeps };
}
