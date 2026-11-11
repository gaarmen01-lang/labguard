/**
 * Outils de la recherche agentique (contrat entre la boucle agent, tâche 3,
 * et leur implémentation sur Supabase, tâche 4).
 *
 *   search_analyses(query)      -> RPC public.search_analyses
 *   search_documents(query)     -> RPC public.search_chunks
 *   read_page(document_id, page)-> RPC public.read_document_page
 *
 * Les implémentations s'exécutent avec le client Supabase DE L'UTILISATEUR
 * (RLS appliquée), jamais avec la clé service_role.
 */
import { z } from 'zod';

import type { LlmToolDefinition } from './llm';
import type { AnalysisSearchResult, ChunkSearchResult, PageReadResult } from './domain';

export const AGENT_MAX_TURNS = 4;

export const TOOL_NAMES = ['search_analyses', 'search_documents', 'read_page'] as const;
export const toolNameSchema = z.enum(TOOL_NAMES);
export type ToolName = z.infer<typeof toolNameSchema>;

export const searchAnalysesArgsSchema = z.object({
  query: z.string().trim().min(1).max(300),
});
export type SearchAnalysesArgs = z.infer<typeof searchAnalysesArgsSchema>;

export const searchDocumentsArgsSchema = z.object({
  query: z.string().trim().min(1).max(300),
});
export type SearchDocumentsArgs = z.infer<typeof searchDocumentsArgsSchema>;

export const readPageArgsSchema = z.object({
  document_id: z.uuid(),
  page: z.number().int().min(1),
});
export type ReadPageArgs = z.infer<typeof readPageArgsSchema>;

export const toolArgsSchemas = {
  search_analyses: searchAnalysesArgsSchema,
  search_documents: searchDocumentsArgsSchema,
  read_page: readPageArgsSchema,
} as const satisfies Record<ToolName, z.ZodType>;

export type ToolArgs = {
  search_analyses: SearchAnalysesArgs;
  search_documents: SearchDocumentsArgs;
  read_page: ReadPageArgs;
};

export type ToolResults = {
  search_analyses: AnalysisSearchResult[];
  search_documents: ChunkSearchResult[];
  read_page: PageReadResult[];
};

/** Implémentation des outils (tâche 4). */
export interface AgentToolExecutor {
  searchAnalyses(args: SearchAnalysesArgs): Promise<AnalysisSearchResult[]>;
  searchDocuments(args: SearchDocumentsArgs): Promise<ChunkSearchResult[]>;
  readPage(args: ReadPageArgs): Promise<PageReadResult[]>;
}

/** Définitions transmises au LLM (descriptions destinées au modèle). */
export const AGENT_TOOL_DEFINITIONS: readonly LlmToolDefinition[] = [
  {
    name: 'search_analyses',
    description:
      "Cherche les fiches d'analyses structurées (nom, synonymes, codes, tubes acceptés/refusés, volume, transport, conservation, stabilité, délai, remarques) extraites des documents actifs. À utiliser en premier pour toute question sur une analyse précise. Chaque champ renvoyé a sa citation source (field_sources).",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: "Nom, abréviation ou code de l'analyse (ex. « HbA1c », « TP INR »).",
        },
      },
    },
  },
  {
    name: 'search_documents',
    description:
      'Recherche plein texte dans les passages des documents actifs du laboratoire (tolère les fautes de frappe et utilise le glossaire : tube mauve = EDTA, etc.). Renvoie des passages avec chunk_id, document, version et page.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['query'],
      properties: {
        query: {
          type: 'string',
          description: 'Mots-clés courts (ex. « tube mauve hémostase », « transport glace ammoniémie »).',
        },
      },
    },
  },
  {
    name: 'read_page',
    description:
      "Lit le texte intégral d'une page d'un document actif (et ses voisines si utile) pour vérifier le contexte d'un passage.",
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['document_id', 'page'],
      properties: {
        document_id: { type: 'string', description: 'document_id renvoyé par une recherche.' },
        page: { type: 'integer', minimum: 1, description: 'Numéro de page (1 = première).' },
      },
    },
  },
];
