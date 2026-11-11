import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { normalizeText, normalizeTokens } from '@/lib/contracts/text';

import { createTestDb, type TestDb } from '../helpers/db';

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

const SAMPLES = [
  'Tube mauve (EDTA K2)',
  'Prélèvement à jeun — 2-8 °C',
  'Hémoglobine glyquée : HbA1c',
  "Remplissage jusqu'au trait obligatoire !",
  'Cœur, œdème, Æther, straße',
  'Ça, là, où, naïve, Noël, Ångström',
  '  espaces   multiples\tet\nretours  ',
  'TP/INR ; D-dimères ; β-HCG',
  '« Guillemets » “anglais” l’apostrophe… — tiret – court',
  'ﬁbrinogène, ĳ, ŀ, ı, © ® ½ ¼ ¾ × ±',
  '5 µmol/L ≤ x ≥ 2 ‰ ²',
  '',
];

describe('parité TypeScript / SQL de la normalisation', () => {
  it.each(SAMPLES)('lg_tokens(%j) = normalizeTokens', async (sample) => {
    const [row] = await db.query<{ tokens: string; norm: string }>(
      'select public.lg_tokens($1) as tokens, public.lg_normalize($1) as norm',
      [sample],
    );
    expect(normalizeTokens(sample)).toBe(row?.tokens);
    expect(normalizeText(sample)).toBe(row?.norm);
  });
});
