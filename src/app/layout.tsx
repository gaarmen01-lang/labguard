import type { Metadata, Viewport } from 'next';
import { connection } from 'next/server';
import type { ReactNode } from 'react';

import './globals.css';

export const metadata: Metadata = {
  title: { default: 'LabGuard', template: '%s · LabGuard' },
  description: 'Assistant documentaire du laboratoire : réponses citées à partir des documents internes.',
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Rendu dynamique obligatoire : la CSP utilise un nonce par requête.
  await connection();
  return (
    <html lang="fr">
      <body>{children}</body>
    </html>
  );
}
