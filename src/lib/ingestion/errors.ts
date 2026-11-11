/**
 * Erreurs d'ingestion : un code stable (journaux, tests) et un message en
 * français affichable tel quel à l'administrateur (stocké dans le job).
 */

export const INGESTION_ERROR_CODES = [
  'unsupported_type',
  'type_mismatch',
  'too_large',
  'too_many_pages',
  'scanned_pdf',
  'encrypted_pdf',
  'corrupt_file',
  'empty_document',
  'file_missing',
  'storage_unavailable',
  'llm_unavailable',
  'invalid_state',
  'internal',
] as const;
export type IngestionErrorCode = (typeof INGESTION_ERROR_CODES)[number];

export class IngestionError extends Error {
  readonly code: IngestionErrorCode;
  /** Vrai si relancer le traitement peut réussir sans changer le fichier. */
  readonly retryable: boolean;

  constructor(code: IngestionErrorCode, message: string, options: { retryable?: boolean; cause?: unknown } = {}) {
    super(message, { cause: options.cause });
    this.name = 'IngestionError';
    this.code = code;
    this.retryable =
      options.retryable ?? (code === 'storage_unavailable' || code === 'llm_unavailable' || code === 'internal');
  }
}

export function isIngestionError(error: unknown): error is IngestionError {
  return error instanceof IngestionError;
}
