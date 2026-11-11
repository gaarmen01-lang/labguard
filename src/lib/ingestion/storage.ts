/**
 * Stockage des fichiers originaux (bucket privé « documents »), derrière une
 * petite interface pour pouvoir le simuler dans les tests.
 */
export const DOCUMENTS_BUCKET = 'documents' as const;

export interface SignedUpload {
  path: string;
  signedUrl: string;
  token: string;
}

export interface DocumentStorage {
  createSignedUploadUrl(path: string): Promise<SignedUpload>;
  /** Contenu du fichier ; lève IngestionError('file_missing') s'il n'existe pas. */
  download(path: string): Promise<Uint8Array>;
  createSignedUrl(path: string, expiresInSeconds: number, downloadName?: string | null): Promise<string>;
  remove(paths: string[]): Promise<void>;
}

/** Nom de fichier sûr pour un chemin Storage (ASCII, sans séparateur). */
export function sanitizeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? 'document';
  const ascii = base
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-.]+|[-.]+$/g, '');
  const trimmed = ascii.slice(-120) || 'document';
  return trimmed;
}

export function storagePathFor(documentId: string, filename: string): string {
  return `${documentId}/${sanitizeFilename(filename)}`;
}
