# Corpus de test FICTIF

**Tout est inventé** (laboratoire « Laboratoire FICTIF des Tilleuls », règles, délais, numéros de poste). Ces fichiers servent à tester l'ingestion (tâche 2) et l'évaluation (tâche 6) : ils ne décrivent pas une pratique réelle et ne contiennent aucune donnée patient. Chaque fichier porte la mention « DOCUMENT FICTIF DE TEST ».

Régénération (déterministe) : `node scripts/make-fixtures.ts`, puis mettre à jour ce README et les tests si le contenu change.

| Fichier | Code / version conseillés | Type | Contenu |
| --- | --- | --- | --- |
| `manuel-prelevement-v3.pdf` | `MP-PRE-001` v`3` (application 01/03/2026) | PDF texte, 9 pages | Manuel de prélèvement : prose, listes, 7 tableaux dont le catalogue de 28 analyses (p. 4-5, en-tête répété p. 5, cellules sur plusieurs lignes) |
| `manuel-prelevement-v2.pdf` | `MP-PRE-001` v`2` (application 15/01/2025) | PDF texte, 9 pages | Version précédente du même manuel (différences ci-dessous) |
| `catalogue-analyses.xlsx` | `CAT-ANA` v`2026-03` | XLSX, 3 feuilles | Catalogue : feuilles « Biochimie » (12 analyses), « Hématologie » (3), « Légende » (pas un catalogue). Titre au-dessus de l'en-tête, volumes numériques en mL |
| `analyses-specialisees.csv` | `CAT-SPEC` v`1` | CSV `;`, UTF-8 avec BOM | 6 analyses transmises ; une ligne de commentaire `#` ; un champ entre guillemets contenant `;` et un saut de ligne (PTH) |
| `procedure-non-conformites.docx` | `PROC-NC-001` v`1.2` | DOCX | Procédure de gestion des non-conformités : titres, listes, tableau de 6 critères (conduite à tenir, dérogation) |
| `consignes-transport.md` | `CONS-TR-001` v`1` | Markdown | Consignes de transport, tableau Markdown (analyse / température / délai maximal) |
| `scan-sans-texte.pdf` | — | PDF sans texte | Simule un PDF scanné : doit être refusé (OCR hors périmètre v1) |

## Faits clés (référence pour l'évaluation)

Sauf mention contraire : manuel **v3** (`MP-PRE-001`, version active attendue).

### Tubes (manuel § 3)
Mauve = EDTA K2 ; bleu clair = citrate de sodium 3,2 % ; noir = citrate 3,8 % (VS) ; vert = héparine de lithium ; jaune = tube sec avec gel ; gris = fluorure de sodium + oxalate. Le tube à **l'héparine d'ammonium n'est pas référencé** et ne doit pas être confondu avec l'héparine de lithium.

### Catalogue du manuel (§ 4, p. 4-5) — extraits
| Analyse (code) | Accepté | Refusé (explicitement) | Volume | Stabilité | Délai |
| --- | --- | --- | --- | --- | --- |
| NFS (hémogramme) (NFS) | EDTA K2 (bouchon mauve) | Citrate, héparine de lithium | 2 mL | 24 h à température ambiante | 2 h |
| VS (VS) | Citrate 3,8 % (bouchon noir) ; EDTA K2 si analyse dans les 4 h | Tube sec | 2 mL | 4 h | 4 h |
| Groupe sanguin ABO-RhD (GRP) | EDTA K2 | Tube sec, tube avec gel | 4 mL | 7 jours à 2-8 °C | 24 h |
| TP / INR (TP) | Citrate de sodium 3,2 % (bleu clair) | EDTA, héparine de lithium, tube sec | Remplir jusqu'au trait | 24 h (non centrifugé) | 2 h |
| TCA (TCA) | Citrate 3,2 % | EDTA, héparine de lithium | trait | 4 h | 2 h |
| Ionogramme (IONO) | Héparine de lithium ; tube sec avec gel | EDTA | 4 mL | 4 h avant centrifugation | 2 h |
| Potassium (K) | Héparine de lithium | EDTA, tube hémolysé | 2 mL | 4 h avant centrifugation | 2 h |
| Glycémie à jeun (GLY) | Fluorure (bouchon gris) | Tube sec non centrifugé | 2 mL | 24 h sur fluorure | 2 h |
| HbA1c (HBA1C) | EDTA K2 | Citrate | 2 mL | 7 jours à 2-8 °C | 24 h |
| Calcium (CA) | Héparine de lithium ; tube sec avec gel | EDTA, citrate | 2 mL | 24 h | 4 h |
| Calcium ionisé (CAI) | Seringue héparinée pour gaz du sang | Tube sec, tube avec gel | 1 mL | 30 minutes (sur glace) | 1 h |
| Troponine T hypersensible (TROP) | Héparine de lithium | **EDTA** | 2 mL | 8 h | 1 h (urgence) |
| Lactate (LACT) | Fluorure | Tube sec, héparine de lithium | 2 mL | 15 minutes avant centrifugation (dans la glace) | 1 h |
| Ammoniémie (NH3) | EDTA K2 | **Héparine d'ammonium** | 2 mL | 30 minutes (dans la glace, tube plein et bouché) | 1 h |
| CRP (CRP) | Héparine de lithium ; tube sec avec gel | *(case vide)* | 2 mL | 72 h à 2-8 °C | 2 h |
| Ferritine (FERRI) / Fer sérique (FE) | Tube sec avec gel | — / EDTA, citrate | 2 mL | 7 jours à 2-8 °C | 24 h |
| Bilirubine totale (BILT) / conjuguée (BILC) | Héparine de lithium | — | 2 mL | 24 h / 8 h à l'abri de la lumière | 4 h |

Autres lignes : Réticulocytes, RAI, Fibrinogène, D-dimères, Anti-Xa, Créatinine, TSH, Vitamine B12, Folates (28 au total).

### Règles en prose (§ 5-6)
- **Glycémie** : sans tube fluoré, un tube hépariné (vert) est accepté s'il est centrifugé dans les 30 minutes ; au-delà, non conforme.
- **NFS** : aucun autre tube que l'EDTA ; un tube citrate reçu seul pour une NFS est refusé, nouveau prélèvement demandé.
- **Troponine** : depuis la v3, EDTA refusé ; seul l'héparine de lithium est accepté.
- **Ammoniémie** : EDTA K2 dans la glace, analyse dans les 30 minutes ; héparine d'ammonium strictement refusée.
- **Hémostase** : tubes citratés remplis jusqu'au trait (tolérance 90 %) ; sous-rempli = non conforme (TP, TCA, fibrinogène, D-dimères) ; tube de purge avec aiguille épicrânienne.
- **Potassium** : ne jamais réfrigérer avant centrifugation (fausse hyperkaliémie) ; tube hémolysé non conforme.
- **HbA1c** : le tube EDTA de la NFS peut servir si les deux sont prescrites ensemble ; citrate non accepté.
- **Non-conformités** (§ 6) : identification, tube inadapté, citrate mal rempli, hémolyse, délai dépassé, transport non respecté ; conduite à tenir par cas.
- **Annexe A** : hémocultures prélevées en premier, 8 à 10 mL par flacon, jamais réfrigérées, acheminées sous 2 h ; ECBU : milieu de jet, flacon stérile, 2 h à température ambiante ou 12 h à 2-8 °C.

### Pièges volontaires
- **Noms proches** : Calcium / Calcium ionisé ; Fer sérique / Ferritine ; Bilirubine totale / conjuguée ; Phosphore / Phosphatases alcalines (XLSX) ; NFS / « Numération plaquettaire sur citrate » (XLSX, code PLQC, accepte le citrate mais « ne remplace pas la NFS »).
- **Tube explicitement refusé** : EDTA pour la troponine (v3), héparine d'ammonium pour l'ammoniémie, citrate pour la NFS.
- **Le document ne dit rien** : CRP sur tube citrate ou EDTA (case « refusé » vide, aucune règle) → la bonne réponse est « information insuffisante / contacter le laboratoire » (le manuel le dit lui-même en tête du § 4).
- **Deux versions** du manuel : en v2, la troponine accepte l'EDTA K2, l'ammoniémie est stable 1 h, le potassium ne mentionne pas le tube hémolysé, le calcium ionisé est absent. Après activation de la v3, la v2 est archivée et ne doit plus être citée.
- **Faute de frappe** à tolérer : « ammoniemie », « hemoglobine glyqee », « hémogrome ».

### Catalogue XLSX (`CAT-ANA`)
Biochimie : Magnésium (MG, refusé EDTA), Acide urique (URIC), Cholestérol total (CHOL, à jeun 12 h recommandé), Triglycérides (TG, à jeun 12 h obligatoire), ASAT (TGO), ALAT (TGP), Gamma GT (GGT), Phosphatases alcalines (PAL, refusé EDTA/citrate), Phosphore (PHOS, refusé EDTA), Procalcitonine (PCT, 0,5 mL), Cortisol (8 h) (CORT, prélèvement 7 h-9 h), Bêta-HCG (HCG). Hématologie : PLQC (citrate, complément de NFS), Frottis sanguin (FROT, EDTA), Électrophorèse de l'hémoglobine (EHB, refusé héparine de lithium).

### CSV (`CAT-SPEC`)
Vitamine D (25-OH) (tube sec avec gel, 5 jours), ACTH (EDTA, dans la glace, centrifuger sous 30 min, 7 h-10 h), Homocystéine (EDTA, glace, centrifuger dans l'heure), Électrophorèse des protéines sériques, Anticorps anti-TPO, Parathormone (EDTA, réfrigéré, centrifuger sous 2 h, **tube sec refusé**).

### Procédure DOCX (`PROC-NC-001`)
Tube inadapté (ex. NFS sur citrate) : refus, nouveau prélèvement, **pas de dérogation**. Citrate mal rempli (< 90 %) : refus hémostase, pas de dérogation. Hémolyse : refus du potassium, autres analyses avec commentaire. Délai dépassé : refus, dérogation possible par un biologiste pour un échantillon précieux. Identification absente : ne pas analyser ; dérogation seulement pour un échantillon précieux après identification par le préleveur. Transport non conforme (ammoniémie à température ambiante) : refus. Commentaire de dérogation : « Résultat obtenu sur un échantillon non conforme, à interpréter avec prudence ».

### Consignes de transport (`CONS-TR-001`)
Ammoniémie : glace, 30 minutes ; Lactate : glace, 15 minutes ; Calcium ionisé : sur glace, 30 minutes ; Bilirubine : température ambiante à l'abri de la lumière, 4 h ; Potassium : température ambiante, ne pas réfrigérer, 4 h.
