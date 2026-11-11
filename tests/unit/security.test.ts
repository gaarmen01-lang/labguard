import { describe, expect, it } from 'vitest';

import { safeNextPath } from '@/lib/auth/redirect';
import { buildCsp, generateNonce } from '@/lib/security/csp';

describe('safeNextPath', () => {
  it.each([
    ['/admin', '/admin'],
    ['/conversations/1?x=2', '/conversations/1?x=2'],
    [undefined, '/'],
    ['', '/'],
    ['admin', '/'],
    ['//evil.example', '/'],
    ['/\\evil.example', '/'],
    ['https://evil.example', '/'],
    ['/%0d%0aSet-Cookie:x', '/%0d%0aSet-Cookie:x'],
    ['/a\nb', '/'],
    ['/login', '/'],
    ['/auth/confirm', '/'],
  ])('%j -> %j', (input, expected) => {
    expect(safeNextPath(input)).toBe(expected);
  });
});

describe('buildCsp', () => {
  it('production : nonce, strict-dynamic, pas de unsafe-*, frame-ancestors none', () => {
    const csp = buildCsp({ nonce: 'abc', isDev: false, supabaseOrigin: 'https://x.supabase.co' });
    expect(csp).toContain("script-src 'self' 'nonce-abc' 'strict-dynamic'");
    expect(csp).toContain("style-src 'self' 'nonce-abc'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain('connect-src \'self\' https://x.supabase.co wss://x.supabase.co');
    expect(csp).not.toContain('unsafe');
  });
  it('dev : unsafe-eval autorisé pour le débogage React', () => {
    expect(buildCsp({ nonce: 'abc', isDev: true })).toContain("'unsafe-eval'");
  });
  it('génère des nonces distincts', () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});
