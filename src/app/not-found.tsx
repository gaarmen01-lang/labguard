import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="main">
      <div className="card stack">
        <h1>Page introuvable</h1>
        <p>
          <Link href="/">Retour à l’accueil</Link>
        </p>
      </div>
    </main>
  );
}
