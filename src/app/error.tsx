'use client';

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main className="main">
      <div className="card stack" role="alert">
        <h1>Une erreur est survenue</h1>
        <p>La page n’a pas pu être affichée. Si le problème persiste, contactez un administrateur.</p>
        <button type="button" onClick={reset}>
          Réessayer
        </button>
      </div>
    </main>
  );
}
