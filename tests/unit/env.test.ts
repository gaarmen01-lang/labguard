import { afterEach, describe, expect, it, vi } from 'vitest';

import { EnvError, getLlmConfig, getServerEnv, parseEmailList, resetEnvCacheForTests } from '@/lib/env';

afterEach(() => {
  vi.unstubAllEnvs();
  resetEnvCacheForTests();
});

describe('env', () => {
  it('liste clairement les variables Supabase manquantes', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', '');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', '');
    expect(() => getServerEnv()).toThrow(EnvError);
    try {
      getServerEnv();
    } catch (error) {
      expect((error as EnvError).missing).toEqual([
        'NEXT_PUBLIC_SUPABASE_URL',
        'NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY',
      ]);
      expect((error as Error).message).toMatch(/NEXT_PUBLIC_SUPABASE_URL/);
    }
  });

  it('lit la configuration serveur et normalise les emails admin', () => {
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://exemple.supabase.co');
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY', 'sb_publishable_xxxxxxxxxxxxxxxxxxxx');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-xxxxxxxxxxxxxxxxxxxx');
    vi.stubEnv('LABGUARD_ADMIN_EMAILS', ' Chef@Lab.test ; bio@lab.test,,');
    expect(getServerEnv().adminEmails).toEqual(['chef@lab.test', 'bio@lab.test']);
  });

  it('LLM : exige fournisseur, modèle et clé (sauf fake), sans valeur par défaut', () => {
    vi.stubEnv('LLM_PROVIDER', '');
    vi.stubEnv('LLM_MODEL', '');
    expect(() => getLlmConfig()).toThrow(/LLM_PROVIDER, LLM_MODEL/);

    vi.stubEnv('LLM_PROVIDER', 'mistral');
    vi.stubEnv('LLM_MODEL', 'modele-test');
    vi.stubEnv('LLM_API_KEY', '');
    expect(() => getLlmConfig()).toThrow(/LLM_API_KEY/);

    vi.stubEnv('LLM_PROVIDER', 'fake');
    expect(getLlmConfig()).toEqual({ provider: 'fake', model: 'modele-test', apiKey: '' });

    vi.stubEnv('LLM_PROVIDER', 'openai_compatible');
    vi.stubEnv('LLM_API_KEY', 'cle');
    expect(() => getLlmConfig()).toThrow(/LLM_BASE_URL/);
  });

  it('parseEmailList ignore les entrées invalides', () => {
    expect(parseEmailList(undefined)).toEqual([]);
    expect(parseEmailList('a@b.c x d@e.f a@b.c')).toEqual(['a@b.c', 'd@e.f']);
  });
});
