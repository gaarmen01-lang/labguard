import Link from 'next/link';
import type { ReactNode } from 'react';

import { requirePageUser } from '@/lib/auth/session';

/** Zone protégée : tout ce qui est sous (app) exige un utilisateur autorisé. */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const { email, isAdmin } = await requirePageUser();
  return (
    <>
      <header className="app-header">
        <Link href="/" className="brand">
          LabGuard
        </Link>
        <nav aria-label="Navigation principale">
          <Link href="/">Questions</Link>
          {isAdmin ? <Link href="/admin">Administration</Link> : null}
          <span className="muted">{email}</span>
          <form action="/auth/signout" method="post">
            <button type="submit" className="link-button">
              Se déconnecter
            </button>
          </form>
        </nav>
      </header>
      {children}
    </>
  );
}
