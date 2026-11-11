import type { Metadata } from 'next';

import { requirePageAdmin } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Administration' };

/** Placeholder réservé aux admins : bibliothèque et utilisateurs (tâches 2 et 5). */
export default async function AdminPage() {
  await requirePageAdmin();
  return (
    <main className="main stack">
      <section className="card stack">
        <h1>Administration</h1>
        <p>Gestion de la bibliothèque documentaire et des utilisateurs autorisés.</p>
        <p className="muted">Les écrans d’import et de gestion arrivent dans une prochaine version.</p>
      </section>
    </main>
  );
}
