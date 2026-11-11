/**
 * Types Postgres pour les clients supabase-js (`createClient<Database>`).
 *
 * Écrit à la main au format de `supabase gen types typescript`, en miroir de
 * supabase/migrations. Une fois les migrations appliquées sur le projet, on
 * peut le régénérer :
 *   supabase gen types typescript --project-id <id> --schema public > src/lib/contracts/database.ts
 * (puis vérifier `pnpm typecheck`). Toute migration doit mettre ce fichier à jour.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

type Timestamp = string;

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: '13';
  };
  public: {
    Tables: {
      allowed_emails: {
        Row: {
          email: string;
          role: 'admin' | 'member';
          note: string | null;
          created_by: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          email: string;
          role?: 'admin' | 'member';
          note?: string | null;
          created_by?: string | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['allowed_emails']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'allowed_emails_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      profiles: {
        Row: {
          id: string;
          email: string;
          display_name: string | null;
          role: 'admin' | 'member';
          allowed: boolean;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id: string;
          email: string;
          display_name?: string | null;
          role?: 'admin' | 'member';
          allowed?: boolean;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['profiles']['Insert']>;
        Relationships: [];
      };
      documents: {
        Row: {
          id: string;
          code: string;
          title: string;
          version: string;
          doc_type: 'sampling_manual' | 'test_catalog' | 'procedure' | 'other';
          status: Database['public']['Enums']['document_status'];
          effective_date: string | null;
          storage_path: string | null;
          original_filename: string | null;
          mime_type: string | null;
          file_size: number | null;
          sha256: string | null;
          page_count: number | null;
          ingestion_status: 'pending' | 'processing' | 'ready' | 'failed';
          ingestion_error: string | null;
          activated_at: Timestamp | null;
          archived_at: Timestamp | null;
          created_by: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          code: string;
          title: string;
          version: string;
          doc_type?: 'sampling_manual' | 'test_catalog' | 'procedure' | 'other';
          status?: Database['public']['Enums']['document_status'];
          effective_date?: string | null;
          storage_path?: string | null;
          original_filename?: string | null;
          mime_type?: string | null;
          file_size?: number | null;
          sha256?: string | null;
          page_count?: number | null;
          ingestion_status?: 'pending' | 'processing' | 'ready' | 'failed';
          ingestion_error?: string | null;
          activated_at?: Timestamp | null;
          archived_at?: Timestamp | null;
          created_by?: string | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['documents']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'documents_created_by_fkey';
            columns: ['created_by'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      document_pages: {
        Row: {
          document_id: string;
          page_number: number;
          content: string;
          label: string | null;
        };
        Insert: {
          document_id: string;
          page_number: number;
          content: string;
          label?: string | null;
        };
        Update: Partial<Database['public']['Tables']['document_pages']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'document_pages_document_id_fkey';
            columns: ['document_id'];
            isOneToOne: false;
            referencedRelation: 'documents';
            referencedColumns: ['id'];
          },
        ];
      };
      chunks: {
        Row: {
          id: string;
          document_id: string;
          page_number: number;
          chunk_index: number;
          kind: 'text' | 'table_row' | 'table';
          heading: string | null;
          content: string;
          char_start: number | null;
          char_end: number | null;
          metadata: Json;
          created_at: Timestamp;
          /** Colonne générée (tsvector) : lecture seule. */
          fts: unknown;
          /** Colonne générée : lecture seule. */
          search_norm: string;
        };
        Insert: {
          id?: string;
          document_id: string;
          page_number: number;
          chunk_index: number;
          kind?: 'text' | 'table_row' | 'table';
          heading?: string | null;
          content: string;
          char_start?: number | null;
          char_end?: number | null;
          metadata?: Json;
          created_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['chunks']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'chunks_document_id_fkey';
            columns: ['document_id'];
            isOneToOne: false;
            referencedRelation: 'documents';
            referencedColumns: ['id'];
          },
        ];
      };
      analyses: {
        Row: {
          id: string;
          document_id: string;
          name: string;
          synonyms: string[];
          codes: string[];
          accepted_tubes: string[];
          rejected_tubes: string[];
          volume: string | null;
          transport: string | null;
          storage: string | null;
          stability: string | null;
          turnaround_time: string | null;
          remarks: string | null;
          source_chunk_id: string;
          source_quote: string;
          created_at: Timestamp;
          updated_at: Timestamp;
          search_norm: string;
          fts: unknown;
        };
        Insert: {
          id?: string;
          document_id: string;
          name: string;
          synonyms?: string[];
          codes?: string[];
          accepted_tubes?: string[];
          rejected_tubes?: string[];
          volume?: string | null;
          transport?: string | null;
          storage?: string | null;
          stability?: string | null;
          turnaround_time?: string | null;
          remarks?: string | null;
          source_chunk_id: string;
          source_quote: string;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['analyses']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'analyses_document_id_fkey';
            columns: ['document_id'];
            isOneToOne: false;
            referencedRelation: 'documents';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'analyses_source_chunk_id_fkey';
            columns: ['source_chunk_id'];
            isOneToOne: false;
            referencedRelation: 'chunks';
            referencedColumns: ['id'];
          },
        ];
      };
      analysis_field_sources: {
        Row: {
          analysis_id: string;
          field:
            | 'name'
            | 'synonyms'
            | 'codes'
            | 'accepted_tubes'
            | 'rejected_tubes'
            | 'volume'
            | 'transport'
            | 'storage'
            | 'stability'
            | 'turnaround_time'
            | 'remarks';
          chunk_id: string;
          quote: string;
        };
        Insert: Database['public']['Tables']['analysis_field_sources']['Row'];
        Update: Partial<Database['public']['Tables']['analysis_field_sources']['Row']>;
        Relationships: [
          {
            foreignKeyName: 'analysis_field_sources_analysis_id_fkey';
            columns: ['analysis_id'];
            isOneToOne: false;
            referencedRelation: 'analyses';
            referencedColumns: ['id'];
          },
          {
            foreignKeyName: 'analysis_field_sources_chunk_id_fkey';
            columns: ['chunk_id'];
            isOneToOne: false;
            referencedRelation: 'chunks';
            referencedColumns: ['id'];
          },
        ];
      };
      synonyms: {
        Row: {
          id: number;
          group_key: string;
          term: string;
          term_norm: string;
          note: string | null;
          created_at: Timestamp;
        };
        Insert: {
          group_key: string;
          term: string;
          note?: string | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['synonyms']['Insert']>;
        Relationships: [];
      };
      ingestion_jobs: {
        Row: {
          id: string;
          document_id: string;
          status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
          stage: 'parse' | 'chunk' | 'extract_analyses' | 'finalize';
          cursor: Json;
          progress: number;
          total: number | null;
          attempts: number;
          last_error: string | null;
          locked_at: Timestamp | null;
          locked_by: string | null;
          created_by: string | null;
          created_at: Timestamp;
          updated_at: Timestamp;
          finished_at: Timestamp | null;
        };
        Insert: {
          id?: string;
          document_id: string;
          status?: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
          stage?: 'parse' | 'chunk' | 'extract_analyses' | 'finalize';
          cursor?: Json;
          progress?: number;
          total?: number | null;
          attempts?: number;
          last_error?: string | null;
          locked_at?: Timestamp | null;
          locked_by?: string | null;
          created_by?: string | null;
          created_at?: Timestamp;
          updated_at?: Timestamp;
          finished_at?: Timestamp | null;
        };
        Update: Partial<Database['public']['Tables']['ingestion_jobs']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'ingestion_jobs_document_id_fkey';
            columns: ['document_id'];
            isOneToOne: false;
            referencedRelation: 'documents';
            referencedColumns: ['id'];
          },
        ];
      };
      conversations: {
        Row: {
          id: string;
          user_id: string;
          title: string;
          created_at: Timestamp;
          updated_at: Timestamp;
        };
        Insert: {
          id?: string;
          user_id?: string;
          title?: string;
          created_at?: Timestamp;
          updated_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['conversations']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'conversations_user_id_fkey';
            columns: ['user_id'];
            isOneToOne: false;
            referencedRelation: 'profiles';
            referencedColumns: ['id'];
          },
        ];
      };
      messages: {
        Row: {
          id: string;
          conversation_id: string;
          user_id: string;
          role: 'user' | 'assistant';
          content: string;
          answer: Json | null;
          status: 'complete' | 'insufficient' | 'error';
          verdict: 'conforme' | 'non_conforme' | 'a_verifier' | null;
          llm_provider: string | null;
          llm_model: string | null;
          usage: Json | null;
          latency_ms: number | null;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          conversation_id: string;
          user_id: string;
          role: 'user' | 'assistant';
          content: string;
          answer?: Json | null;
          status?: 'complete' | 'insufficient' | 'error';
          verdict?: 'conforme' | 'non_conforme' | 'a_verifier' | null;
          llm_provider?: string | null;
          llm_model?: string | null;
          usage?: Json | null;
          latency_ms?: number | null;
          created_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['messages']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'messages_conversation_id_fkey';
            columns: ['conversation_id'];
            isOneToOne: false;
            referencedRelation: 'conversations';
            referencedColumns: ['id'];
          },
        ];
      };
      message_sources: {
        Row: {
          id: string;
          message_id: string;
          paragraph_index: number;
          citation_index: number;
          chunk_id: string | null;
          document_id: string | null;
          document_code: string;
          document_title: string;
          document_version: string;
          page_number: number;
          quote: string;
          excerpt: string;
          created_at: Timestamp;
        };
        Insert: {
          id?: string;
          message_id: string;
          paragraph_index: number;
          citation_index: number;
          chunk_id?: string | null;
          document_id?: string | null;
          document_code: string;
          document_title: string;
          document_version: string;
          page_number: number;
          quote: string;
          excerpt: string;
          created_at?: Timestamp;
        };
        Update: Partial<Database['public']['Tables']['message_sources']['Insert']>;
        Relationships: [
          {
            foreignKeyName: 'message_sources_message_id_fkey';
            columns: ['message_id'];
            isOneToOne: false;
            referencedRelation: 'messages';
            referencedColumns: ['id'];
          },
        ];
      };
    };
    Views: { [_ in never]: never };
    Functions: {
      search_chunks: {
        Args: { q: string; max_results?: number };
        Returns: {
          chunk_id: string;
          document_id: string;
          document_code: string;
          document_title: string;
          document_version: string;
          doc_type: string;
          page_number: number;
          chunk_index: number;
          kind: string;
          heading: string | null;
          content: string;
          score: number;
          fts_score: number;
          synonym_score: number;
          trigram_score: number;
          matched_synonyms: string[];
        }[];
      };
      search_analyses: {
        Args: { q: string; max_results?: number };
        Returns: {
          analysis_id: string;
          document_id: string;
          document_code: string;
          document_title: string;
          document_version: string;
          name: string;
          synonyms: string[];
          codes: string[];
          accepted_tubes: string[];
          rejected_tubes: string[];
          volume: string | null;
          transport: string | null;
          storage: string | null;
          stability: string | null;
          turnaround_time: string | null;
          remarks: string | null;
          source_chunk_id: string;
          source_quote: string;
          source_page_number: number;
          field_sources: Json;
          score: number;
          matched_synonyms: string[];
        }[];
      };
      read_document_page: {
        Args: { p_document_id: string; p_page: number; p_context?: number };
        Returns: {
          document_id: string;
          document_code: string;
          document_title: string;
          document_version: string;
          page_count: number | null;
          page_number: number;
          label: string | null;
          content: string;
        }[];
      };
      prepare_search_query: {
        Args: { q: string };
        Returns: {
          normalized: string;
          residual: string;
          tokens: string[];
          fts_query: unknown;
          synonym_query: unknown;
          synonym_groups: string[];
          synonym_terms: string[];
        }[];
      };
      activate_document: {
        Args: { p_document_id: string };
        Returns: Database['public']['Tables']['documents']['Row'];
      };
      archive_document: {
        Args: { p_document_id: string };
        Returns: Database['public']['Tables']['documents']['Row'];
      };
      is_admin: { Args: Record<PropertyKey, never>; Returns: boolean };
      is_allowed: { Args: Record<PropertyKey, never>; Returns: boolean };
      lg_tokens: { Args: { input: string }; Returns: string };
      lg_normalize: { Args: { input: string }; Returns: string };
    };
    Enums: {
      document_status: 'draft' | 'active' | 'archived';
    };
    CompositeTypes: { [_ in never]: never };
  };
};

type PublicSchema = Database['public'];
export type Tables<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Row'];
export type TablesInsert<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Insert'];
export type TablesUpdate<T extends keyof PublicSchema['Tables']> = PublicSchema['Tables'][T]['Update'];
export type Enums<T extends keyof PublicSchema['Enums']> = PublicSchema['Enums'][T];
