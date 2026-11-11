import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

import { LoginForm } from '@/components/login-form';
import { safeNextPath } from '@/lib/auth/redirect';
import { getAuthState } from '@/lib/auth/session';

export const metadata: Metadata = { title: 'Connexion' };

const ERROR_MESSAGES: Record<string, string> = {
  not_allowed: "Cette adresse n'est pas autorisée à utiliser LabGuard. Contactez un administrateur.",
  link_invalid: 'Le lien de connexion est invalide ou a expiré. Demandez-en un nouveau.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(typeof params.next === 'string' ? params.next : undefined);
  const errorKey = typeof params.error === 'string' ? params.error : undefined;

  const state = await getAuthState();
  if (state.status === 'ok') redirect(next);

  return (
    <main className="auth-wrapper">
      <div className="card auth-card stack">
        <div>
          <h1>LabGuard</h1>
          <p className="muted">Assistant documentaire du laboratoire</p>
        </div>
        {errorKey && ERROR_MESSAGES[errorKey] ? (
          <p className="notice error" role="alert">
            {ERROR_MESSAGES[errorKey]}
          </p>
        ) : null}
        <LoginForm next={next} />
      </div>
    </main>
  );
}
