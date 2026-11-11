import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Questions' };

/** Placeholder : l'interface de chat est livrée en tâche 5. */
export default async function ChatHomePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  return (
    <main className="main stack">
      {params.error === 'forbidden' ? (
        <p className="notice error" role="alert">
          Accès réservé aux administrateurs.
        </p>
      ) : null}
      <section className="card stack">
        <h1>Poser une question</h1>
        <p>
          LabGuard répondra uniquement à partir des documents actifs du laboratoire (manuel de prélèvement,
          catalogue d’analyses, procédures), avec des citations vérifiables.
        </p>
        <p className="muted">L’interface de conversation sera disponible prochainement.</p>
      </section>
    </main>
  );
}
