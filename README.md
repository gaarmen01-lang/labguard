# LabGuard

Assistant en français pour le personnel de laboratoire d'analyses médicales : il répond **uniquement** à partir des documents du laboratoire (manuel de prélèvement, catalogue d'analyses, procédures), avec des citations vérifiables (document, version, page, extrait). Si les documents ne permettent pas de répondre, il le dit.

Next.js 16 · TypeScript strict · Supabase (Postgres, Auth, Storage) · recherche plein texte + glossaire de synonymes (sans vecteurs) · fournisseur LLM interchangeable.

## Démarrer

```sh
pnpm install
cp .env.example .env.local   # puis renseigner les valeurs
pnpm dev
```

Le schéma de base se trouve dans `supabase/migrations/` (à appliquer dans l'ordre sur le projet Supabase).

## Vérifier

```sh
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Les tests SQL tournent sur PGlite (Postgres en mémoire) : ni Docker ni réseau.

## Documentation

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) : architecture, schéma, contrats, sécurité, répartition des tâches.

Ne jamais saisir de données de patients dans les documents de test. Aucun secret ne doit être versionné.
