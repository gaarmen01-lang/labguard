/**
 * Ingestion des documents (tâche 2) : API publique sans dépendance serveur.
 * Le câblage Supabase est dans './server' et './supabase' (server-only).
 */
export * from './admin';
export * from './analysis-fields';
export * from './chunker';
export * from './deterministic';
export * from './detect';
export * from './errors';
export * from './extraction';
export * from './llm-extract';
export * from './parsers';
export * from './pipeline';
export type * from './repository';
export * from './storage';
export * from './text-layout';
export * from './tubes';
export type * from './types';
export * from './verify';
