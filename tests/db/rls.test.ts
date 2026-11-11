import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { seedCorpus, type SeededCorpus } from '../helpers/corpus';
import { createTestDb, type TestDb, type TestUser } from '../helpers/db';

let db: TestDb;
let corpus: SeededCorpus;
let alice: TestUser;
let bob: TestUser;
let admin: TestUser;
let outsider: TestUser;

beforeAll(async () => {
  db = await createTestDb();
  corpus = await seedCorpus(db);
  alice = await db.createUser('alice@lab.test');
  bob = await db.createUser('bob@lab.test');
  admin = await db.createUser('admin@lab.test', { role: 'admin' });
  outsider = await db.createUser('intrus@ailleurs.test', { allowed: false });
});

afterAll(async () => {
  await db.close();
});

async function count(user: TestUser, table: string): Promise<number> {
  return db.asUser(user.id, async (tx) => {
    const { rows } = await tx.query<{ n: number }>(`select count(*)::int as n from ${table}`);
    return rows[0]?.n ?? -1;
  });
}

describe('profils et liste blanche', () => {
  it('le trigger crée le profil avec rôle et autorisation issus de allowed_emails', async () => {
    const rows = await db.query<{ email: string; role: string; allowed: boolean }>(
      'select email, role, allowed from public.profiles order by email',
    );
    expect(rows).toEqual([
      { email: 'admin@lab.test', role: 'admin', allowed: true },
      { email: 'alice@lab.test', role: 'member', allowed: true },
      { email: 'bob@lab.test', role: 'member', allowed: true },
      { email: 'intrus@ailleurs.test', role: 'member', allowed: false },
    ]);
  });

  it('ajout / révocation dans allowed_emails répercutés sur le profil existant', async () => {
    const late = await db.createUser('tardif@lab.test', { allowed: false });
    const allowedOf = async () =>
      (await db.query<{ allowed: boolean; role: string }>('select allowed, role from public.profiles where id = $1', [late.id]))[0];
    expect(await allowedOf()).toEqual({ allowed: false, role: 'member' });

    await db.query(`insert into public.allowed_emails (email, role) values ('tardif@lab.test', 'admin')`);
    expect(await allowedOf()).toEqual({ allowed: true, role: 'admin' });

    await db.query(`delete from public.allowed_emails where email = 'tardif@lab.test'`);
    expect(await allowedOf()).toEqual({ allowed: false, role: 'member' });
  });

  it('allowed_emails refuse une adresse non normalisée', async () => {
    await expect(db.query(`insert into public.allowed_emails (email) values ('Majuscule@Lab.test')`)).rejects.toThrow();
  });

  it('un membre ne voit que son profil et ne peut pas le modifier', async () => {
    expect(await count(alice, 'public.profiles')).toBe(1);
    await expect(
      db.asUser(alice.id, (tx) => tx.query(`update public.profiles set role = 'admin' where id = $1`, [alice.id])),
    ).rejects.toThrow(/permission denied/);
  });

  it("un membre ne lit ni n'écrit la liste blanche ; l'admin oui", async () => {
    expect(await count(alice, 'public.allowed_emails')).toBe(0);
    await expect(
      db.asUser(alice.id, (tx) =>
        tx.query(`insert into public.allowed_emails (email, role) values ('pirate@x.test', 'admin')`),
      ),
    ).rejects.toThrow(/row-level security/);
    expect(await count(admin, 'public.allowed_emails')).toBeGreaterThanOrEqual(3);
    expect(await count(admin, 'public.profiles')).toBeGreaterThanOrEqual(4);
  });
});

describe('bibliothèque documentaire', () => {
  it('un membre ne voit que les documents actifs et leurs dérivés', async () => {
    const codes = await db.asUser(alice.id, async (tx) =>
      (await tx.query<{ code: string; version: string }>('select code, version from public.documents order by code')).rows,
    );
    expect(codes).toEqual([
      { code: 'CAT-ANA', version: '2025-01' },
      { code: 'MP-PRE', version: '2' },
    ]);
    const chunkIds = await db.asUser(alice.id, async (tx) =>
      (await tx.query<{ id: string }>('select id from public.chunks')).rows.map((r) => r.id),
    );
    expect(chunkIds).not.toContain(corpus.chunks.archivedHeparin);
    expect(chunkIds).not.toContain(corpus.chunks.draftGlucose);
    expect(chunkIds).toContain(corpus.chunks.cbcEdta);
    expect(await count(alice, `public.document_pages where document_id = '${corpus.draftId}'`)).toBe(0);
    expect(await count(alice, 'public.analyses')).toBe(1);
    expect(await count(alice, 'public.analysis_field_sources')).toBe(5);
  });

  it("l'admin voit tout (brouillons et archives compris)", async () => {
    expect(await count(admin, 'public.documents')).toBe(5);
  });

  it('un utilisateur hors liste blanche ne voit rien', async () => {
    for (const table of ['public.documents', 'public.chunks', 'public.analyses', 'public.synonyms']) {
      expect(await count(outsider, table)).toBe(0);
    }
  });

  it("anon n'a aucun accès aux tables", async () => {
    await expect(db.asAnon((tx) => tx.query('select * from public.documents'))).rejects.toThrow(/permission denied/);
    await expect(db.asAnon((tx) => tx.query(`select * from public.search_chunks('edta')`))).rejects.toThrow(
      /permission denied/,
    );
  });

  it('un membre ne peut pas écrire dans la bibliothèque', async () => {
    await expect(
      db.asUser(alice.id, (tx) =>
        tx.query(`insert into public.documents (code, title, version) values ('X', 'Faux', '1')`),
      ),
    ).rejects.toThrow(/row-level security/);

    const updated = await db.asUser(alice.id, async (tx) =>
      (await tx.query(`update public.documents set title = 'piraté' where id = $1 returning id`, [corpus.manualId])).rows,
    );
    expect(updated).toEqual([]);

    await expect(
      db.asUser(alice.id, (tx) =>
        tx.query(`insert into public.chunks (document_id, page_number, chunk_index, content) values ($1, 1, 99, 'faux')`, [
          corpus.manualId,
        ]),
      ),
    ).rejects.toThrow(/row-level security/);

    await expect(
      db.asUser(alice.id, (tx) => tx.query(`insert into public.synonyms (group_key, term) values ('x', 'y')`)),
    ).rejects.toThrow(/row-level security/);

    const deleted = await db.asUser(alice.id, async (tx) =>
      (await tx.query('delete from public.chunks returning id')).rows,
    );
    expect(deleted).toEqual([]);
  });

  it("activate_document : l'admin active une nouvelle version et archive l'ancienne", async () => {
    const v3 = await db.insertDocument({
      code: 'MP-PRE',
      title: 'Manuel de prélèvement',
      version: '3',
      status: 'draft',
      pages: [{ pageNumber: 1, chunks: ['Hémogramme : EDTA K2 ou K3, 2 mL minimum.'] }],
    });

    // Un membre ne peut pas activer (la RLS bloque la mise à jour).
    await expect(
      db.asUser(alice.id, (tx) => tx.query('select public.activate_document($1)', [v3.documentId])),
    ).rejects.toThrow();

    await db.asUser(admin.id, (tx) => tx.query('select public.activate_document($1)', [v3.documentId]));
    const rows = await db.query<{ version: string; status: string }>(
      `select version, status::text from public.documents where code = 'MP-PRE' order by version`,
    );
    expect(rows).toEqual([
      { version: '1', status: 'archived' },
      { version: '2', status: 'archived' },
      { version: '3', status: 'active' },
    ]);
    const search = await db.asUser(alice.id, async (tx) =>
      (await tx.query<{ chunk_id: string }>(`select chunk_id from public.search_chunks('tube mauve', 20)`)).rows,
    );
    expect(search.map((r) => r.chunk_id)).toContain(v3.chunkIds[0]);
    expect(search.map((r) => r.chunk_id)).not.toContain(corpus.chunks.cbcEdta);

    // Restaure l'état pour les autres tests.
    await db.asUser(admin.id, (tx) => tx.query('select public.activate_document($1)', [corpus.manualId]));
  });

  it("activate_document refuse un document dont l'ingestion n'est pas terminée", async () => {
    const pending = await db.insertDocument({
      code: 'PROC-NEW',
      status: 'draft',
      ingestionStatus: 'processing',
      pages: [{ pageNumber: 1, chunks: ['Texte'] }],
    });
    await expect(
      db.asUser(admin.id, (tx) => tx.query('select public.activate_document($1)', [pending.documentId])),
    ).rejects.toThrow(/pas prêt/);
  });

  it('une seule version active par code (contrainte)', async () => {
    await expect(
      db.insertDocument({ code: 'MP-PRE', version: '99', status: 'active', pages: [] }),
    ).rejects.toThrow(/documents_one_active_per_code/);
  });
});

describe('conversations et messages', () => {
  let aliceConversation: string;

  it('un membre crée sa conversation (user_id par défaut = auth.uid())', async () => {
    aliceConversation = await db.asUser(alice.id, async (tx) => {
      const { rows } = await tx.query<{ id: string; user_id: string }>(
        `insert into public.conversations (title) values ('Tube mauve') returning id, user_id`,
      );
      expect(rows[0]?.user_id).toBe(alice.id);
      return rows[0]!.id;
    });
  });

  it("un membre ne lit pas les conversations d'un autre", async () => {
    expect(await count(bob, 'public.conversations')).toBe(0);
    expect(await count(admin, 'public.conversations')).toBe(0);
    expect(await count(alice, 'public.conversations')).toBe(1);
    const updated = await db.asUser(bob.id, async (tx) =>
      (await tx.query(`update public.conversations set title = 'x' where id = $1 returning id`, [aliceConversation])).rows,
    );
    expect(updated).toEqual([]);
  });

  it("un membre ne peut pas créer une conversation au nom d'un autre", async () => {
    await expect(
      db.asUser(bob.id, (tx) => tx.query('insert into public.conversations (user_id, title) values ($1, $2)', [alice.id, 'x'])),
    ).rejects.toThrow(/row-level security/);
  });

  it('les messages sont écrits par le serveur (service_role) et lus par leur seul propriétaire', async () => {
    await expect(
      db.asUser(alice.id, (tx) =>
        tx.query(`insert into public.messages (conversation_id, user_id, role, content) values ($1, $2, 'assistant', 'faux')`, [
          aliceConversation,
          alice.id,
        ]),
      ),
    ).rejects.toThrow(/permission denied/);

    const messageId = await db.asServiceRole(async (tx) => {
      const { rows } = await tx.query<{ id: string }>(
        `insert into public.messages (conversation_id, user_id, role, content, status, verdict)
         values ($1, $2, 'assistant', 'Le tube EDTA convient.', 'complete', 'conforme') returning id`,
        [aliceConversation, alice.id],
      );
      const id = rows[0]!.id;
      await tx.query(
        `insert into public.message_sources
           (message_id, paragraph_index, citation_index, chunk_id, document_id, document_code,
            document_title, document_version, page_number, quote, excerpt)
         values ($1, 0, 0, $2, $3, 'MP-PRE', 'Manuel de prélèvement', '2', 1, 'EDTA K2', 'Hémogramme (NFS) : prélever sur EDTA K2')`,
        [id, corpus.chunks.cbcEdta, corpus.manualId],
      );
      return id;
    });

    expect(await count(alice, 'public.messages')).toBe(1);
    expect(await count(alice, 'public.message_sources')).toBe(1);
    expect(await count(bob, 'public.messages')).toBe(0);
    expect(await count(bob, 'public.message_sources')).toBe(0);
    expect(messageId).toBeTruthy();
  });

  it("refuse un message dont user_id n'est pas le propriétaire de la conversation", async () => {
    await expect(
      db.asServiceRole((tx) =>
        tx.query(`insert into public.messages (conversation_id, user_id, role, content) values ($1, $2, 'user', 'x')`, [
          aliceConversation,
          bob.id,
        ]),
      ),
    ).rejects.toThrow(/propriétaire/);
  });

  it('les sources restent lisibles (snapshot) après archivage du document', async () => {
    await db.query(`update public.documents set status = 'archived' where id = $1`, [corpus.manualId]);
    const rows = await db.asUser(alice.id, async (tx) =>
      (await tx.query<{ excerpt: string }>('select excerpt from public.message_sources')).rows,
    );
    expect(rows[0]?.excerpt).toContain('EDTA K2');
    await db.query(`update public.documents set status = 'active' where id = $1`, [corpus.manualId]);
  });

  it('supprimer sa conversation supprime ses messages', async () => {
    await db.asUser(alice.id, (tx) => tx.query('delete from public.conversations where id = $1', [aliceConversation]));
    expect(await db.query('select 1 from public.messages where conversation_id = $1', [aliceConversation])).toEqual([]);
  });
});

describe('stockage (bucket privé « documents »)', () => {
  beforeAll(async () => {
    await db.query(`update public.documents set storage_path = $2 where id = $1`, [
      corpus.manualId,
      `${corpus.manualId}/manuel.pdf`,
    ]);
    await db.query(`update public.documents set storage_path = $2 where id = $1`, [
      corpus.draftId,
      `${corpus.draftId}/brouillon.pdf`,
    ]);
    await db.query(`insert into storage.objects (bucket_id, name) values ('documents', $1), ('documents', $2)`, [
      `${corpus.manualId}/manuel.pdf`,
      `${corpus.draftId}/brouillon.pdf`,
    ]);
  });

  it('le bucket existe et est privé', async () => {
    const rows = await db.query<{ public: boolean }>(`select public from storage.buckets where id = 'documents'`);
    expect(rows).toEqual([{ public: false }]);
  });

  it("un membre lit l'original d'un document actif, pas celui d'un brouillon", async () => {
    const names = await db.asUser(alice.id, async (tx) =>
      (await tx.query<{ name: string }>(`select name from storage.objects where bucket_id = 'documents'`)).rows.map(
        (r) => r.name,
      ),
    );
    expect(names).toEqual([`${corpus.manualId}/manuel.pdf`]);
  });

  it("seul l'admin dépose des fichiers", async () => {
    await expect(
      db.asUser(alice.id, (tx) => tx.query(`insert into storage.objects (bucket_id, name) values ('documents', 'x/y.pdf')`)),
    ).rejects.toThrow(/row-level security/);
    await db.asUser(admin.id, (tx) =>
      tx.query(`insert into storage.objects (bucket_id, name) values ('documents', 'x/y.pdf')`),
    );
    expect(await count(admin, `storage.objects where bucket_id = 'documents'`)).toBe(3);
  });
});
