# LabGuard — assistant documentaire

Un chat en français, centré sur les procédures : discussions, sélection des documents, réponses avec références et consultation des passages cités. Interface claire et sombre, navigation au clavier et disposition mobile.

## État livré

- Bibliothèque personnelle PDF texte, DOCX et TXT avec extraction locale et fichier original conservé dans IndexedDB.
- Activation explicite après vérification du texte ; les brouillons, archives et documents futurs sont exclus de la recherche.
- Une nouvelle version active archive les versions actives précédentes du même code, dans une transaction.
- Discussions et citations conservées dans le navigateur. Les extraits historiques restent consultables si un document est archivé ou supprimé.
- Recherche lexicale avec classement de type BM25, découpage par page et recouvrement des extraits. Les relances peuvent reprendre le sujet de la question précédente.
- Mode **lecture documentaire** utilisable sans connexion : il reproduit les extraits retrouvés, sans génération IA. Les exemples intégrés sont fictifs et explicitement identifiés.
- Route serveur `/api/chat` utilisant l’API Responses d’OpenAI et un format JSON strict. Chaque paragraphe doit être accompagné de références et de citations présentes dans les extraits. Toute référence invalide entraîne une réponse d’information insuffisante.
- Authentification Supabase vérifiée côté serveur et liste explicite des adresses autorisées. Aucun appel OpenAI sans cette authentification et sans configuration complète.

**Le code de la génération IA est implémenté ; son activation et sa validation avec les services réels nécessitent les variables serveur et un projet Supabase actif.** Aucun secret n’est inclus dans ce dépôt. Les tests du fournisseur et de l’authentification utilisent des réponses simulées.

## Démarrer et vérifier

Node.js 22, sans dépendances npm supplémentaires :

```sh
npm test
npm run build
python3 -m http.server 8080 --directory dist
```

Le serveur Python sert l’interface et la lecture documentaire. Il ne lance pas les routes `api/`. Le build restaure le worker PDF.js à partir de son archive gzip versionnée.

Pour exécuter les routes serveur localement, utiliser `vercel dev` avec la configuration du projet et les variables dans un fichier `.env.local` ignoré par Git. Le déploiement existant utilise `vercel.json`, le dossier `dist` et les fonctions du dossier `api`.

## Activer le pilote IA sur Vercel

Configurer **uniquement côté serveur** :

| Variable | Rôle |
| --- | --- |
| `OPENAI_API_KEY` | Clé du projet OpenAI autorisé |
| `OPENAI_MODEL` | Modèle, `gpt-4.1-mini` par défaut |
| `SUPABASE_URL` | URL HTTPS du projet Supabase |
| `SUPABASE_PUBLISHABLE_KEY` | Clé publiable du projet ; ancienne clé anon également reconnue via `SUPABASE_ANON_KEY` |
| `LABGUARD_ALLOWED_EMAILS` | Liste d’adresses du pilote, séparées par des virgules |

Dans Supabase, réactiver le projet si nécessaire, créer ou inviter les comptes du pilote et autoriser l’URL exacte du site dans la configuration des redirections Auth. Le formulaire utilise un lien de connexion par e-mail avec `create_user: false` : il ne crée pas librement de comptes. Le serveur vérifie l’utilisateur, la confirmation de son adresse et son appartenance à la liste avant chaque question IA.

Redéployer après modification des variables. `/api/config` annonce l’état et expose uniquement l’URL et la clé **publiable** nécessaires à la connexion. Il n’expose ni clé OpenAI, ni secret Supabase, ni liste d’adresses autorisées.

L’accès n’est pas prêt tant que le parcours connexion → question → réponse citée n’a pas été testé avec un compte autorisé et refusé avec un autre compte. Les tests automatisés couvrent ces décisions avec des réponses de service simulées.

## Parcours des données

1. L’import extrait le texte dans le navigateur. Documents et discussions restent dans ce navigateur.
2. En lecture documentaire, toute la recherche reste locale ; aucune génération IA n’est appelée.
3. En mode IA connecté, le navigateur transmet au serveur la question, jusqu’à huit messages précédents et les documents actifs sélectionnés. Le serveur valide les limites et retrouve au maximum cinq passages.
4. Seuls ces passages, la question et l’historique limité sont transmis à OpenAI, avec `store: false`. Ce paramètre ne constitue pas une garantie d’absence de rétention par le fournisseur.
5. Le serveur vérifie les identifiants et les citations textuelles. Les pages et versions proviennent des documents, jamais du modèle. La réponse et ses extraits sont enregistrés localement.

Ne pas saisir de données réelles de patients. Les exemples et les vérifications de développement utilisent exclusivement des documents fictifs.

## Limites du pilote

- Bibliothèque personnelle : pas de synchronisation des documents ou discussions entre appareils, pas de bibliothèque hospitalière partagée ni d’index pgvector connecté.
- Recherche lexicale, sans embeddings : les synonymes et formulations très éloignées peuvent nécessiter une reformulation. Une absence de résultat n’établit pas que le document ne contient pas la réponse.
- Les PDF scannés ne sont pas reconnus automatiquement. Les tableaux et unités doivent être vérifiés après extraction. DOCX et TXT ne reçoivent pas de faux numéros de page.
- La validation locale d’un document n’est pas un workflow institutionnel de validation avec rôles et audit. L’authentification protège l’accès au service IA ; chaque utilisateur fournit son propre corpus dans la requête.
- La présence d’une citation textuelle est contrôlée ; elle ne garantit pas à elle seule que toutes les interprétations de l’IA sont justes. Le professionnel doit vérifier la réponse dans son contexte.
- La limite de huit questions par minute est appliquée par utilisateur et instance serveur. Ce n’est ni une limite globale durable ni un plafond de dépense. Un pilote élargi nécessite un quota partagé et un budget fournisseur.
- Les fonctions de non-conformités, l’administration multi-tenant et la certification/conformité clinique ne font pas partie de cette livraison.

## Fichiers

- `dist/` : interface, extraction, recherche locale, PDF.js et licence.
- `api/` : points d’entrée Vercel.
- `server/` : génération, contrôle des citations, authentification et validation.
- `tests/` : recherche, versions/pages, refus de sources inventées, contrats fournisseur, configuration fermée par défaut et contrôle d’accès.
- `.env.example` : noms des variables, sans valeurs secrètes.
- `SOURCE-METADATA.md` et `.openai/hosting.json` : origine historique de l’export Sites, préservée. Le présent développement vise le dépôt GitHub et son hébergement Vercel existant.
