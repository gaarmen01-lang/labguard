import { describe, expect, it } from 'vitest';

import { applyMigrations, createBareDb, listMigrationFiles } from '../helpers/db';

describe('migrations', () => {
  it('sont ordonnées et rejouables sans erreur ni doublon', async () => {
    const files = listMigrationFiles().map((file) => file.split('/').pop());
    expect(files).toEqual([
      '0001_init.sql',
      '0002_rls.sql',
      '0003_search.sql',
      '0004_storage.sql',
      '0005_seed_synonyms.sql',
    ]);

    const pg = await createBareDb();
    try {
      await applyMigrations(pg);
      const before = await pg.query<{ n: number }>('select count(*)::int as n from public.synonyms');
      await applyMigrations(pg);
      const after = await pg.query<{ n: number }>('select count(*)::int as n from public.synonyms');
      expect(after.rows[0]?.n).toBe(before.rows[0]?.n);
      expect(before.rows[0]?.n).toBeGreaterThan(100);
    } finally {
      await pg.close();
    }
  });

  it('active la RLS sur toutes les tables du schéma public', async () => {
    const pg = await createBareDb();
    try {
      await applyMigrations(pg);
      const { rows } = await pg.query<{ relname: string }>(
        `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity`,
      );
      expect(rows).toEqual([]);
    } finally {
      await pg.close();
    }
  });
});
