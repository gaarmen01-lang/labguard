'use client';

import { useState, type FormEvent } from 'react';

type Status = { kind: 'idle' } | { kind: 'sending' } | { kind: 'sent'; message: string } | { kind: 'error'; message: string };

export function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState<Status>({ kind: 'idle' });

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus({ kind: 'sending' });
    try {
      const response = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, next }),
      });
      const body: unknown = await response.json().catch(() => null);
      if (response.ok && body && typeof body === 'object' && 'message' in body) {
        setStatus({ kind: 'sent', message: String(body.message) });
        return;
      }
      const message =
        body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error
          ? String(body.error.message)
          : 'La demande a échoué. Réessayez.';
      setStatus({ kind: 'error', message });
    } catch {
      setStatus({ kind: 'error', message: 'Connexion au serveur impossible. Réessayez.' });
    }
  }

  if (status.kind === 'sent') {
    return (
      <p className="notice" role="status">
        {status.message}
      </p>
    );
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <div>
        <label htmlFor="email">Adresse email professionnelle</label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
        />
      </div>
      {status.kind === 'error' ? (
        <p className="notice error" role="alert">
          {status.message}
        </p>
      ) : null}
      <button type="submit" disabled={status.kind === 'sending' || email.trim() === ''}>
        {status.kind === 'sending' ? 'Envoi…' : 'Recevoir un lien de connexion'}
      </button>
      <p className="muted">Un lien de connexion à usage unique vous sera envoyé par email si votre adresse est autorisée.</p>
    </form>
  );
}
