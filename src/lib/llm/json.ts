/** Utilitaires JSON tolérants partagés par les adaptateurs. */
import type { LlmToolCall } from '@/lib/contracts/llm';

/**
 * Normalise les arguments d'un appel d'outil : chaîne JSON (OpenAI, Mistral
 * habituellement) ou objet déjà décodé (Anthropic, certains compatibles).
 * JSON invalide -> `arguments: undefined` + `rawArguments` (cf. contrat).
 */
export function parseToolArguments(raw: unknown): Pick<LlmToolCall, 'arguments' | 'rawArguments'> {
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return { arguments: {}, rawArguments: raw };
    try {
      return { arguments: JSON.parse(trimmed) as unknown, rawArguments: raw };
    } catch {
      return { arguments: undefined, rawArguments: raw };
    }
  }
  if (raw === undefined || raw === null) return { arguments: {}, rawArguments: '' };
  if (typeof raw === 'object') return { arguments: raw, rawArguments: JSON.stringify(raw) };
  return { arguments: undefined, rawArguments: String(raw) };
}

/**
 * Isole le JSON d'une réponse texte : retire un éventuel bloc ```json … ```
 * ou du texte autour du premier objet. Renvoie la chaîne telle quelle sinon.
 */
export function extractJsonText(content: string): string {
  const trimmed = content.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  if (fenced?.[1] !== undefined) return fenced[1].trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start >= 0 && end > start) return trimmed.slice(start, end + 1);
  return trimmed;
}

/** Contenu texte d'un message : chaîne, ou tableau de parties { type:'text', text }. */
export function contentToText(content: unknown): string | null {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && typeof (part as { text?: unknown }).text === 'string') {
          return (part as { text: string }).text;
        }
        return '';
      })
      .filter((part) => part.length > 0);
    return parts.length > 0 ? parts.join('') : null;
  }
  return null;
}

export function toNonNegativeInt(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}
