import { describe, expect, it } from 'vitest';

import {
  AGENT_TOOL_DEFINITIONS,
  chatEventSchema,
  chatRequestSchema,
  createDocumentRequestSchema,
  FINAL_ANSWER_JSON_SCHEMA,
  finalAnswerSchema,
  insufficientAnswer,
  magicLinkRequestSchema,
  quoteAppearsIn,
  readPageArgsSchema,
  toolArgsSchemas,
  TOOL_NAMES,
  verifiedAnswerSchema,
} from '@/lib/contracts';

const CHUNK = '3f1e7a52-6a0b-4b8e-9d0c-2a4f5e6b7c8d';

describe('finalAnswerSchema', () => {
  it('accepte une réponse suffisante citée, verdict absent -> null', () => {
    const parsed = finalAnswerSchema.parse({
      insufficient: false,
      paragraphs: [{ text: 'Le tube EDTA convient.', citations: [{ chunk_id: CHUNK, quote: 'EDTA K2' }] }],
    });
    expect(parsed.verdict).toBeNull();
  });

  it('refuse un paragraphe sans citation quand la réponse est suffisante', () => {
    const result = finalAnswerSchema.safeParse({
      insufficient: false,
      verdict: 'conforme',
      paragraphs: [{ text: 'Affirmation non sourcée.', citations: [] }],
    });
    expect(result.success).toBe(false);
  });

  it('refuse une réponse suffisante vide et un verdict sur réponse insuffisante', () => {
    expect(finalAnswerSchema.safeParse({ insufficient: false, verdict: null, paragraphs: [] }).success).toBe(false);
    expect(
      finalAnswerSchema.safeParse({ insufficient: true, verdict: 'conforme', paragraphs: [] }).success,
    ).toBe(false);
  });

  it('accepte une réponse insuffisante sans citation', () => {
    expect(
      finalAnswerSchema.safeParse({
        insufficient: true,
        verdict: null,
        paragraphs: [{ text: 'Le document ne traite pas ce cas.', citations: [] }],
      }).success,
    ).toBe(true);
  });

  it('le JSON Schema fournisseur exige tous les champs', () => {
    expect(FINAL_ANSWER_JSON_SCHEMA.required).toEqual(['insufficient', 'verdict', 'paragraphs']);
    expect(FINAL_ANSWER_JSON_SCHEMA.additionalProperties).toBe(false);
  });

  it('insufficientAnswer() est une VerifiedAnswer valide', () => {
    expect(verifiedAnswerSchema.parse(insufficientAnswer()).insufficient).toBe(true);
  });
});

describe('quoteAppearsIn', () => {
  const chunk = "Hémogramme (NFS) : prélever sur EDTA K2, 4 mL. Remplissage jusqu'au trait.";
  it('tolère casse, accents et ponctuation', () => {
    expect(quoteAppearsIn('hemogramme (nfs): prelever sur edta k2', chunk)).toBe(true);
    expect(quoteAppearsIn('Remplissage jusqu’au trait', chunk)).toBe(true);
  });
  it('refuse une reformulation, un mot tronqué ou une citation vide', () => {
    expect(quoteAppearsIn('prélever sur tube EDTA', chunk)).toBe(false);
    expect(quoteAppearsIn('EDT', chunk)).toBe(false);
    expect(quoteAppearsIn(' ... ', chunk)).toBe(false);
  });
});

describe('outils agent', () => {
  it('chaque outil a une définition et un schéma d’arguments', () => {
    expect(AGENT_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([...TOOL_NAMES]);
    for (const name of TOOL_NAMES) expect(toolArgsSchemas[name]).toBeDefined();
  });
  it('read_page exige un uuid et une page >= 1', () => {
    expect(readPageArgsSchema.safeParse({ document_id: CHUNK, page: 0 }).success).toBe(false);
    expect(readPageArgsSchema.safeParse({ document_id: 'abc', page: 1 }).success).toBe(false);
    expect(readPageArgsSchema.safeParse({ document_id: CHUNK, page: 2 }).success).toBe(true);
  });
});

describe('événements SSE', () => {
  it('valide la séquence nominale', () => {
    const events = [
      { type: 'conversation', conversation_id: CHUNK, user_message_id: CHUNK },
      { type: 'step', step: 'search_documents', label: 'Recherche : tube mauve', turn: 1 },
      { type: 'answer', message_id: CHUNK, status: 'insufficient', answer: insufficientAnswer() },
      { type: 'done' },
    ];
    for (const event of events) expect(chatEventSchema.safeParse(event).success).toBe(true);
  });
  it('refuse un type inconnu', () => {
    expect(chatEventSchema.safeParse({ type: 'token', text: 'x' }).success).toBe(false);
  });
});

describe('payloads API', () => {
  it('normalise l’email de connexion', () => {
    expect(magicLinkRequestSchema.parse({ email: '  Alice@Lab.TEST ' }).email).toBe('alice@lab.test');
    expect(magicLinkRequestSchema.safeParse({ email: 'pas-un-email' }).success).toBe(false);
  });
  it('borne la question du chat', () => {
    expect(chatRequestSchema.safeParse({ message: '   ' }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: 'x'.repeat(2001) }).success).toBe(false);
    expect(chatRequestSchema.safeParse({ message: 'Tube mauve pour HbA1c ?' }).success).toBe(true);
  });
  it("refuse un type de fichier non pris en charge à l'import", () => {
    const base = {
      code: 'MP-1',
      title: 'Manuel',
      version: '1',
      doc_type: 'sampling_manual',
      filename: 'manuel.pdf',
      mime_type: 'application/pdf',
      file_size: 1000,
    };
    expect(createDocumentRequestSchema.safeParse(base).success).toBe(true);
    expect(createDocumentRequestSchema.safeParse({ ...base, mime_type: 'image/png' }).success).toBe(false);
    expect(createDocumentRequestSchema.safeParse({ ...base, file_size: 60 * 1024 * 1024 }).success).toBe(false);
  });
});
