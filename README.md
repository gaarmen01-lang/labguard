# LabGuard — export et déploiement Vercel

## Ce qui a réellement été récupéré

Le dépôt source complet de la version publiée a été exporté depuis ChatGPT Sites au commit `23bd6eec2323bfcd2c2bb70bc5d299fea74c158f`.
Le dépôt canonique contient directement les fichiers statiques de `dist/`. Il ne contient pas un projet React/Vite caché, ni un backend RAG. Aucun code n'a été reconstruit pour remplir les trous.

Contenu principal :

- `dist/index.html` : interface ;
- `dist/style.css` : styles ;
- `dist/app.js` : logique navigateur ;
- `dist/vendor/` : copie locale de PDF.js et sa licence ;
- `scripts/build.mjs` : restaure le worker PDF depuis sa copie gzip versionnée ;
- `.openai/hosting.json` : ancienne configuration Sites, conservée comme trace ;
- `vercel.json` : configuration indépendante pour Vercel.

## Fonctionnement et dépendances

LabGuard est actuellement un prototype 100 % navigateur :

- les PDF/DOCX/TXT sont lus localement ;
- les documents ajoutés sont enregistrés dans IndexedDB, dans le navigateur de l'utilisateur ;
- PDF.js est déjà inclus dans `dist/vendor/` ;
- aucune base distante, API, variable d'environnement ou clé secrète n'est utilisée ;
- le tchat ne fait encore aucune recherche RAG et ne contacte ni Supabase ni OpenAI.

Les documents déjà ajoutés dans un navigateur ne se trouvent donc pas dans ChatGPT Sites et ne peuvent pas être exportés depuis le serveur. Ils restent dans le profil local de ce navigateur. Oui, le bouton ressemble à une vraie bibliothèque documentaire ; non, les petits lutins de Supabase ne travaillent pas encore derrière.

## Tester localement

Depuis ce dossier, restaurez d'abord le worker PDF puis lancez le serveur statique :

```bash
npm run build
python3 -m http.server 8080 --directory dist
```

Puis ouvrir `http://localhost:8080`.

Aucune dépendance npm externe n'est nécessaire. La courte étape de build ne compile pas l'application : elle décompresse à l'identique le worker PDF.js, conservé en gzip pour permettre son transfert fiable vers GitHub.

## Déployer sur Vercel

> **Protection d'accès :** le projet Sites actuel est limité à votre compte. Un déploiement Vercel statique est public par défaut. Activez la protection de déploiement Vercel (ou ajoutez une authentification applicative) avant de publier des procédures réelles ou des informations internes.

### Avec Git

1. Créer un dépôt Git avec ce dossier.
2. L'importer dans Vercel.
3. Choisir **Other** comme framework si Vercel le demande.
4. Laisser Vercel utiliser la commande `npm run build` définie dans `vercel.json`.
5. Le dossier de sortie est fixé à `dist` par `vercel.json`.
6. Déployer.

### Avec la CLI

```bash
vercel
vercel --prod
```

## Ce qui reste à créer pour le vrai LabGuard

Le backend documentaire décrit dans l'interface n'existe pas encore. Il faudra construire séparément : authentification et rôles, stockage des fichiers, ingestion/chunking, embeddings, recherche vectorielle, génération sourcée, historique, journal d'audit et administration documentaire. Cet export préserve fidèlement le prototype ; il ne maquille pas une façade en logiciel hospitalier opérationnel.
