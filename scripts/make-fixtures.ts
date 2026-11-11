/**
 * Génère le corpus de test FICTIF de LabGuard dans tests/fixtures/corpus/.
 *
 *   node scripts/make-fixtures.ts
 *
 * Tout le contenu est inventé (laboratoire, règles, valeurs) : il sert à tester
 * l'ingestion et l'évaluation, PAS à guider une pratique réelle. Aucune donnée
 * patient. Les fichiers produits sont déterministes (dates figées) et commités ;
 * relancer le script après toute modification et mettre à jour README.md.
 *
 * Script autonome (exécuté par Node avec suppression des types) : pas d'import
 * relatif ni d'alias `@/`.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  AlignmentType,
  BorderStyle,
  Document as DocxDocument,
  HeadingLevel,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  TextRun,
  WidthType,
} from 'docx';
import { strToU8, zipSync } from 'fflate';
import PDFDocument from 'pdfkit';

const OUT_DIR = resolve(import.meta.dirname, '..', 'tests', 'fixtures', 'corpus');
const FIXED_DATE = new Date('2026-01-15T08:00:00Z');
const LAB = 'Laboratoire FICTIF des Tilleuls';
const FICTIF_NOTICE =
  'DOCUMENT FICTIF DE TEST — contenu inventé pour LabGuard, ne pas utiliser pour une pratique réelle. Aucune donnée patient.';

// =============================================================================
// Données du manuel de prélèvement (MP-PRE-001)
// =============================================================================

interface CatalogRow {
  name: string;
  code: string;
  accepted: string;
  refused: string;
  volume: string;
  transport: string;
  stability: string;
  delay: string;
}

type Version = 2 | 3;

function catalogRows(version: Version): Array<{ section: string; rows: CatalogRow[] }> {
  const v3 = version === 3;
  return [
    {
      section: '4.1 Hématologie',
      rows: [
        { name: 'NFS (hémogramme)', code: 'NFS', accepted: 'EDTA K2 (bouchon mauve)', refused: 'Citrate, héparine de lithium', volume: '2 mL', transport: 'Température ambiante', stability: '24 h à température ambiante', delay: '2 h' },
        { name: 'Réticulocytes', code: 'RETIC', accepted: 'EDTA K2 (bouchon mauve)', refused: '', volume: '2 mL', transport: 'Température ambiante', stability: '48 h à 2-8 °C', delay: '4 h' },
        { name: 'Vitesse de sédimentation (VS)', code: 'VS', accepted: 'Citrate 3,8 % (bouchon noir) ; EDTA K2 si analyse dans les 4 h', refused: 'Tube sec', volume: '2 mL', transport: 'Température ambiante', stability: '4 h', delay: '4 h' },
        { name: 'Groupe sanguin ABO-RhD (groupage)', code: 'GRP', accepted: 'EDTA K2 (bouchon mauve)', refused: 'Tube sec, tube avec gel', volume: '4 mL', transport: 'Température ambiante', stability: '7 jours à 2-8 °C', delay: '24 h' },
        { name: "Recherche d'agglutinines irrégulières (RAI)", code: 'RAI', accepted: 'EDTA K2 (bouchon mauve)', refused: '', volume: '4 mL', transport: 'Température ambiante', stability: '72 h à 2-8 °C', delay: '24 h' },
      ],
    },
    {
      section: '4.2 Hémostase',
      rows: [
        { name: 'TP / INR (taux de prothrombine)', code: 'TP', accepted: 'Citrate de sodium 3,2 % (bouchon bleu clair)', refused: 'EDTA, héparine de lithium, tube sec', volume: "Remplir jusqu'au trait", transport: 'Température ambiante, ne pas réfrigérer', stability: '24 h (tube non centrifugé)', delay: '2 h' },
        { name: 'TCA (temps de céphaline activée)', code: 'TCA', accepted: 'Citrate de sodium 3,2 % (bouchon bleu clair)', refused: 'EDTA, héparine de lithium', volume: "Remplir jusqu'au trait", transport: 'Température ambiante', stability: '4 h', delay: '2 h' },
        { name: 'Fibrinogène', code: 'FIB', accepted: 'Citrate de sodium 3,2 % (bouchon bleu clair)', refused: 'EDTA', volume: "Remplir jusqu'au trait", transport: 'Température ambiante', stability: '8 h', delay: '2 h' },
        { name: 'D-dimères', code: 'DDI', accepted: 'Citrate de sodium 3,2 % (bouchon bleu clair)', refused: 'EDTA', volume: "Remplir jusqu'au trait", transport: 'Température ambiante', stability: '8 h', delay: '2 h' },
        { name: 'Activité anti-Xa (héparinémie)', code: 'AXA', accepted: 'Citrate de sodium 3,2 % (bouchon bleu clair)', refused: 'EDTA, héparine de lithium', volume: "Remplir jusqu'au trait", transport: "Centrifuger dans l'heure", stability: '2 h', delay: '4 h' },
      ],
    },
    {
      section: '4.3 Biochimie',
      rows: [
        { name: 'Ionogramme (Na, K, Cl)', code: 'IONO', accepted: 'Héparine de lithium (bouchon vert) ; tube sec avec gel (bouchon jaune)', refused: 'EDTA', volume: '4 mL', transport: 'Température ambiante, ne pas réfrigérer', stability: '4 h avant centrifugation', delay: '2 h' },
        { name: 'Potassium', code: 'K', accepted: 'Héparine de lithium (bouchon vert)', refused: v3 ? 'EDTA, tube hémolysé' : 'EDTA', volume: '2 mL', transport: 'Température ambiante, ne pas réfrigérer', stability: '4 h avant centrifugation', delay: '2 h' },
        { name: 'Glycémie à jeun', code: 'GLY', accepted: 'Fluorure de sodium (bouchon gris)', refused: 'Tube sec non centrifugé', volume: '2 mL', transport: 'Température ambiante', stability: '24 h sur fluorure', delay: '2 h' },
        { name: 'Hémoglobine glyquée (HbA1c)', code: 'HBA1C', accepted: 'EDTA K2 (bouchon mauve)', refused: 'Citrate', volume: '2 mL', transport: 'Température ambiante', stability: '7 jours à 2-8 °C', delay: '24 h' },
        { name: 'Créatinine', code: 'CREA', accepted: 'Héparine de lithium (bouchon vert) ; tube sec avec gel (bouchon jaune)', refused: '', volume: '2 mL', transport: 'Température ambiante', stability: '24 h', delay: '2 h' },
        { name: 'Calcium', code: 'CA', accepted: 'Héparine de lithium (bouchon vert) ; tube sec avec gel (bouchon jaune)', refused: 'EDTA, citrate', volume: '2 mL', transport: 'Température ambiante', stability: '24 h', delay: '4 h' },
        ...(v3
          ? [{ name: 'Calcium ionisé', code: 'CAI', accepted: 'Seringue héparinée pour gaz du sang', refused: 'Tube sec, tube avec gel', volume: '1 mL', transport: "Sur glace, sans bulle d'air", stability: '30 minutes', delay: '1 h' }]
          : []),
        { name: 'Troponine T hypersensible', code: 'TROP', accepted: v3 ? 'Héparine de lithium (bouchon vert)' : 'Héparine de lithium (bouchon vert) ; EDTA K2 (bouchon mauve)', refused: v3 ? 'EDTA' : '', volume: '2 mL', transport: 'Température ambiante', stability: '8 h', delay: '1 h (urgence)' },
        { name: 'Lactate', code: 'LACT', accepted: 'Fluorure de sodium (bouchon gris)', refused: 'Tube sec, héparine de lithium', volume: '2 mL', transport: 'Dans la glace', stability: '15 minutes avant centrifugation', delay: '1 h' },
        { name: 'Ammoniémie', code: 'NH3', accepted: 'EDTA K2 (bouchon mauve)', refused: "Héparine d'ammonium", volume: '2 mL', transport: 'Dans la glace, tube plein et bouché', stability: v3 ? '30 minutes' : '1 h', delay: '1 h' },
        { name: 'CRP (protéine C réactive)', code: 'CRP', accepted: 'Héparine de lithium (bouchon vert) ; tube sec avec gel (bouchon jaune)', refused: '', volume: '2 mL', transport: 'Température ambiante', stability: '72 h à 2-8 °C', delay: '2 h' },
        { name: 'Ferritine', code: 'FERRI', accepted: 'Tube sec avec gel (bouchon jaune)', refused: '', volume: '2 mL', transport: 'Température ambiante', stability: '7 jours à 2-8 °C', delay: '24 h' },
        { name: 'Fer sérique', code: 'FE', accepted: 'Tube sec avec gel (bouchon jaune)', refused: 'EDTA, citrate', volume: '2 mL', transport: 'Prélèvement le matin', stability: '7 jours à 2-8 °C', delay: '24 h' },
        { name: 'TSH', code: 'TSH', accepted: 'Tube sec avec gel (bouchon jaune)', refused: '', volume: '2 mL', transport: 'Température ambiante', stability: '7 jours à 2-8 °C', delay: '24 h' },
        { name: 'Bilirubine totale', code: 'BILT', accepted: 'Héparine de lithium (bouchon vert)', refused: '', volume: '2 mL', transport: "À l'abri de la lumière", stability: "24 h à l'abri de la lumière", delay: '4 h' },
        { name: 'Bilirubine conjuguée', code: 'BILC', accepted: 'Héparine de lithium (bouchon vert)', refused: '', volume: '2 mL', transport: "À l'abri de la lumière", stability: "8 h à l'abri de la lumière", delay: '4 h' },
        { name: 'Vitamine B12', code: 'B12', accepted: 'Tube sec avec gel (bouchon jaune)', refused: '', volume: '2 mL', transport: "À l'abri de la lumière", stability: '48 h à 2-8 °C', delay: '48 h' },
        { name: 'Folates (vitamine B9)', code: 'B9', accepted: 'Tube sec avec gel (bouchon jaune)', refused: '', volume: '2 mL', transport: "À l'abri de la lumière", stability: '24 h à 2-8 °C', delay: '48 h' },
      ],
    },
  ];
}

type Block =
  | { type: 'title'; text: string }
  | { type: 'h1'; text: string }
  | { type: 'h2'; text: string }
  | { type: 'p'; text: string }
  | { type: 'bullets'; items: string[] }
  | { type: 'table'; columns: Array<{ title: string; width: number }>; rows: string[][]; fontSize?: number }
  | { type: 'pagebreak' };

const CATALOG_COLUMNS = [
  { title: 'Analyse', width: 82 },
  { title: 'Code', width: 38 },
  { title: 'Tube(s) accepté(s)', width: 86 },
  { title: 'Tube(s) refusé(s)', width: 70 },
  { title: 'Volume', width: 44 },
  { title: 'Conservation / transport', width: 78 },
  { title: 'Stabilité', width: 64 },
  { title: 'Délai de rendu', width: 53 },
];

function manualBlocks(version: Version): Block[] {
  const v3 = version === 3;
  const effective = v3 ? '01/03/2026' : '15/01/2025';
  const blocks: Block[] = [
    { type: 'title', text: 'Manuel de prélèvement' },
    { type: 'p', text: `${LAB} — ${FICTIF_NOTICE}` },
    {
      type: 'table',
      columns: [
        { title: 'Rubrique', width: 160 },
        { title: 'Valeur', width: 355 },
      ],
      rows: [
        ['Code du document', 'MP-PRE-001'],
        ['Version', String(version)],
        ["Date d'application", effective],
        ['Rédaction', 'Cellule qualité (fictive)'],
        ['Approbation', 'Biologiste responsable (fictif)'],
      ],
    },
    { type: 'h1', text: 'Sommaire' },
    {
      type: 'bullets',
      items: [
        '1. Objet et domaine d’application',
        '2. Règles générales de prélèvement',
        '3. Tubes utilisés',
        '4. Catalogue des analyses',
        '5. Cas particuliers et tubes alternatifs',
        '6. Critères de non-conformité',
        '7. Historique des versions',
      ],
    },
    { type: 'pagebreak' },
    { type: 'h1', text: '1. Objet et domaine d’application' },
    {
      type: 'p',
      text:
        'Ce manuel décrit les conditions de prélèvement, de conservation et de transport des échantillons biologiques confiés au laboratoire fictif. Il s’applique aux préleveurs internes, aux infirmiers des services de soins et aux coursiers. Toute analyse dont les conditions pré-analytiques ne sont pas respectées peut être refusée.',
    },
    {
      type: 'p',
      text:
        'Les informations de ce manuel priment sur les habitudes de service. En cas de doute sur le tube à utiliser, contacter le secrétariat du laboratoire avant le prélèvement plutôt qu’après.',
    },
    { type: 'h1', text: '2. Règles générales de prélèvement' },
    { type: 'h2', text: '2.1 Identification' },
    {
      type: 'p',
      text:
        'Chaque tube est étiqueté au lit du patient, immédiatement après le prélèvement, avec le nom de naissance, le prénom, la date de naissance et le sexe. Le bon de demande précise la date et l’heure du prélèvement ainsi que l’identité du préleveur. Un tube non identifié n’est jamais analysé.',
    },
    { type: 'h2', text: '2.2 Ordre de prélèvement' },
    {
      type: 'p',
      text:
        'Respecter l’ordre suivant pour éviter la contamination croisée des additifs. Retourner chaque tube doucement, sans agiter, le nombre de fois indiqué.',
    },
    {
      type: 'table',
      columns: [
        { title: 'Ordre', width: 40 },
        { title: 'Tube', width: 150 },
        { title: 'Couleur du bouchon', width: 110 },
        { title: 'Additif', width: 140 },
        { title: 'Retournements', width: 75 },
      ],
      rows: [
        ['1', 'Flacons d’hémoculture', '—', 'Milieu de culture', '—'],
        ['2', 'Tube citrate', 'Bleu clair', 'Citrate de sodium 3,2 %', '3 à 4'],
        ['3', 'Tube sec avec ou sans gel', 'Rouge ou jaune', 'Activateur de coagulation', '5'],
        ['4', 'Tube hépariné', 'Vert', 'Héparine de lithium', '8 à 10'],
        ['5', 'Tube EDTA', 'Mauve', 'EDTA K2', '8 à 10'],
        ['6', 'Tube fluoré', 'Gris', 'Fluorure de sodium et oxalate de potassium', '8 à 10'],
      ],
    },
    { type: 'pagebreak' },
    { type: 'h1', text: '3. Tubes utilisés' },
    {
      type: 'p',
      text:
        'Le tableau suivant récapitule les tubes référencés au laboratoire fictif. Les couleurs de bouchon sont celles du fournisseur actuel du laboratoire ; elles peuvent différer chez d’autres fournisseurs.',
    },
    {
      type: 'table',
      columns: [
        { title: 'Couleur du bouchon', width: 95 },
        { title: 'Type de tube', width: 120 },
        { title: 'Additif', width: 130 },
        { title: 'Principales analyses', width: 170 },
      ],
      rows: [
        ['Mauve', 'Tube EDTA', 'EDTA K2', 'NFS, réticulocytes, groupage, RAI, HbA1c, ammoniémie'],
        ['Bleu clair', 'Tube citrate', 'Citrate de sodium 3,2 %', 'TP / INR, TCA, fibrinogène, D-dimères, anti-Xa'],
        ['Noir', 'Tube VS', 'Citrate de sodium 3,8 %', 'Vitesse de sédimentation'],
        ['Vert', 'Tube hépariné', 'Héparine de lithium', 'Ionogramme, potassium, créatinine, troponine, CRP, bilirubine'],
        ['Jaune', 'Tube sec avec gel', 'Activateur de coagulation et gel séparateur', 'Sérologies, TSH, ferritine, fer sérique, vitamines'],
        ['Gris', 'Tube fluoré', 'Fluorure de sodium et oxalate de potassium', 'Glycémie, lactate'],
      ],
    },
    {
      type: 'p',
      text:
        'Le tube à l’héparine d’ammonium n’est pas référencé au laboratoire fictif ; il ne doit pas être confondu avec le tube à l’héparine de lithium.',
    },
    { type: 'pagebreak' },
    { type: 'h1', text: '4. Catalogue des analyses' },
    {
      type: 'p',
      text:
        'Une ligne correspond à une analyse. Une case « Tube(s) refusé(s) » vide signifie que le manuel ne se prononce pas sur les autres tubes : contacter le laboratoire.',
    },
  ];
  for (const group of catalogRows(version)) {
    blocks.push({ type: 'h2', text: group.section });
    blocks.push({
      type: 'table',
      columns: CATALOG_COLUMNS,
      fontSize: 7.5,
      rows: group.rows.map((row) => [
        row.name,
        row.code,
        row.accepted,
        row.refused,
        row.volume,
        row.transport,
        row.stability,
        row.delay,
      ]),
    });
  }
  blocks.push(
    { type: 'pagebreak' },
    { type: 'h1', text: '5. Cas particuliers et tubes alternatifs' },
    { type: 'h2', text: '5.1 Glycémie' },
    {
      type: 'p',
      text:
        'En l’absence de tube fluoré, un tube hépariné (bouchon vert) est accepté pour la glycémie à condition d’être centrifugé dans les 30 minutes suivant le prélèvement. Au-delà de ce délai, l’échantillon est non conforme pour la glycémie.',
    },
    { type: 'h2', text: '5.2 NFS' },
    {
      type: 'p',
      text:
        'Pour la NFS, aucun tube autre que le tube EDTA n’est accepté. Un tube citrate (bouchon bleu clair) reçu seul pour une NFS est refusé et un nouveau prélèvement est demandé. Exception : la numération plaquettaire de contrôle sur citrate, prescrite en cas de suspicion de pseudo-thrombopénie, suit sa propre fiche du catalogue informatisé.',
    },
    { type: 'h2', text: '5.3 Troponine' },
    {
      type: 'p',
      text: v3
        ? 'Depuis la version 3 de ce manuel, le tube EDTA est refusé pour la troponine T hypersensible (interférence constatée sur l’automate du laboratoire fictif). Seul le tube à l’héparine de lithium est accepté.'
        : 'La troponine T hypersensible peut être dosée sur tube à l’héparine de lithium ou sur tube EDTA.',
    },
    { type: 'h2', text: '5.4 Ammoniémie' },
    {
      type: 'p',
      text: v3
        ? 'Prélever sans garrot prolongé, sur tube EDTA K2 placé immédiatement dans la glace. L’analyse doit être réalisée dans les 30 minutes suivant le prélèvement. Le tube à l’héparine d’ammonium est strictement refusé.'
        : 'Prélever sur tube EDTA K2 placé dans la glace. L’analyse doit être réalisée dans l’heure suivant le prélèvement. Le tube à l’héparine d’ammonium est refusé.',
    },
    { type: 'h2', text: '5.5 Hémostase' },
    {
      type: 'p',
      text:
        'Les tubes citratés doivent être remplis jusqu’au trait (tolérance : 90 % du volume nominal). Un tube citrate sous-rempli est non conforme pour le TP, le TCA, le fibrinogène et les D-dimères. Lorsque le prélèvement est réalisé avec une aiguille épicrânienne, prélever d’abord un tube de purge.',
    },
    { type: 'h2', text: '5.6 Potassium et ionogramme' },
    {
      type: 'p',
      text:
        'Ne jamais réfrigérer un tube destiné au potassium avant centrifugation : la réfrigération provoque une fausse hyperkaliémie. Un tube hémolysé est non conforme pour le potassium.',
    },
    { type: 'h2', text: '5.7 HbA1c' },
    {
      type: 'p',
      text:
        'Le tube EDTA prélevé pour la NFS peut être utilisé pour l’HbA1c lorsque les deux analyses sont prescrites ensemble. Un tube citrate n’est pas accepté pour l’HbA1c.',
    },
    { type: 'pagebreak' },
    { type: 'h1', text: '6. Critères de non-conformité' },
    {
      type: 'p',
      text:
        'Un échantillon non conforme n’est pas analysé, sauf dérogation tracée par un biologiste. Le service prescripteur est prévenu et un nouveau prélèvement est demandé. Les principales causes de non-conformité sont les suivantes.',
    },
    {
      type: 'bullets',
      items: [
        'Identification absente, incomplète ou discordante entre le tube et le bon de demande.',
        'Tube inadapté à l’analyse demandée (exemple : NFS reçue sur tube citrate).',
        'Tube citrate sous-rempli ou trop rempli.',
        'Échantillon hémolysé, coagulé ou lactescent selon l’analyse.',
        'Délai de stabilité dépassé à réception.',
        'Conditions de transport non respectées (glace, abri de la lumière, température).',
      ],
    },
    {
      type: 'table',
      columns: [
        { title: 'Non-conformité', width: 150 },
        { title: 'Conduite à tenir', width: 365 },
      ],
      rows: [
        ['Tube inadapté', 'Refuser l’analyse concernée, demander un nouveau prélèvement sur le tube indiqué au catalogue.'],
        ['Tube citrate mal rempli', 'Refuser les analyses d’hémostase ; les autres tubes du même patient restent analysables.'],
        ['Hémolyse', 'Refuser le potassium et le LDH ; réaliser les autres analyses avec un commentaire.'],
        ['Délai dépassé', 'Refuser l’analyse ; tracer l’heure de réception.'],
        ['Ammoniémie non transportée dans la glace', 'Refuser l’analyse et demander un nouveau prélèvement.'],
      ],
    },
    { type: 'pagebreak' },
    { type: 'h1', text: '7. Historique des versions' },
    {
      type: 'table',
      columns: [
        { title: 'Version', width: 60 },
        { title: 'Date', width: 80 },
        { title: 'Modifications', width: 375 },
      ],
      rows: v3
        ? [
            ['1', '01/06/2023', 'Création du document.'],
            ['2', '15/01/2025', 'Ajout de l’ammoniémie et du lactate.'],
            ['3', '01/03/2026', 'Troponine : tube EDTA désormais refusé. Ammoniémie : délai ramené à 30 minutes. Ajout du calcium ionisé.'],
          ]
        : [
            ['1', '01/06/2023', 'Création du document.'],
            ['2', '15/01/2025', 'Ajout de l’ammoniémie et du lactate.'],
          ],
    },
    { type: 'pagebreak' },
    { type: 'h1', text: 'Annexe A. Hémocultures et prélèvements urinaires' },
    { type: 'h2', text: 'A.1 Hémocultures' },
    {
      type: 'p',
      text:
        'Les flacons d’hémoculture sont prélevés en premier, après désinfection cutanée. Remplir chaque flacon avec 8 à 10 mL de sang. Les flacons sont conservés à température ambiante et acheminés au laboratoire dans les 2 heures ; ils ne doivent jamais être réfrigérés.',
    },
    { type: 'h2', text: 'A.2 ECBU' },
    {
      type: 'p',
      text:
        'L’examen cytobactériologique des urines (ECBU) est réalisé sur les urines du milieu de jet, recueillies dans un flacon stérile après toilette. Le flacon est acheminé dans les 2 heures à température ambiante, ou conservé au maximum 12 heures à 2-8 °C. Un flacon non stérile est refusé.',
    },
    { type: 'h1', text: 'Annexe B. Abréviations' },
    {
      type: 'table',
      columns: [
        { title: 'Abréviation', width: 110 },
        { title: 'Signification', width: 405 },
      ],
      rows: [
        ['EDTA', 'Acide éthylène diamine tétra-acétique (anticoagulant du tube mauve)'],
        ['NFS', 'Numération formule sanguine'],
        ['TP', 'Taux de prothrombine'],
        ['TCA', 'Temps de céphaline activée'],
        ['RAI', 'Recherche d’agglutinines irrégulières'],
        ['HbA1c', 'Hémoglobine glyquée'],
        ['CRP', 'Protéine C réactive'],
      ],
    },
    { type: 'h2', text: 'Contacts' },
    {
      type: 'p',
      text:
        'Secrétariat du laboratoire fictif : poste 0000 (numéro fictif). Biologiste de garde : poste 0001 (numéro fictif).',
    },
  );
  return blocks;
}

// =============================================================================
// Rendu PDF (pdfkit) : prose, listes, tableaux bordés avec en-tête répété
// =============================================================================

const PAGE_MARGIN = 40;
const CONTENT_WIDTH = 595.28 - 2 * PAGE_MARGIN;
const CELL_PADDING = 4;

function renderPdf(blocks: Block[], footer: string): Promise<Buffer> {
  return new Promise((resolvePdf, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: PAGE_MARGIN, bottom: 20, left: PAGE_MARGIN, right: PAGE_MARGIN },
      bufferPages: true,
      autoFirstPage: true,
      info: { Title: 'Document FICTIF', Author: LAB, CreationDate: FIXED_DATE, ModDate: FIXED_DATE },
      compress: true,
    });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bottomLimit = doc.page.height - 60;
    let y = PAGE_MARGIN;
    const newPage = () => {
      doc.addPage();
      y = PAGE_MARGIN;
    };
    const ensure = (height: number) => {
      if (y + height > bottomLimit) newPage();
    };
    const text = (value: string, font: string, size: number, x: number, width: number, gapAfter: number) => {
      doc.font(font).fontSize(size);
      const height = doc.heightOfString(value, { width });
      ensure(height);
      doc.text(value, x, y, { width });
      y += height + gapAfter;
    };

    for (const block of blocks) {
      switch (block.type) {
        case 'pagebreak':
          newPage();
          break;
        case 'title':
          text(block.text, 'Helvetica-Bold', 20, PAGE_MARGIN, CONTENT_WIDTH, 10);
          break;
        case 'h1':
          y += 6;
          ensure(60);
          text(block.text, 'Helvetica-Bold', 14, PAGE_MARGIN, CONTENT_WIDTH, 8);
          break;
        case 'h2':
          y += 4;
          ensure(50);
          text(block.text, 'Helvetica-Bold', 11.5, PAGE_MARGIN, CONTENT_WIDTH, 6);
          break;
        case 'p':
          text(block.text, 'Helvetica', 10, PAGE_MARGIN, CONTENT_WIDTH, 8);
          break;
        case 'bullets':
          for (const item of block.items) {
            doc.font('Helvetica').fontSize(10);
            const height = doc.heightOfString(item, { width: CONTENT_WIDTH - 14 });
            ensure(height);
            doc.text('•', PAGE_MARGIN, y, { width: 10 });
            doc.text(item, PAGE_MARGIN + 14, y, { width: CONTENT_WIDTH - 14 });
            y += height + 3;
          }
          y += 6;
          break;
        case 'table': {
          const size = block.fontSize ?? 8.5;
          const drawRow = (cells: string[], header: boolean) => {
            doc.font(header ? 'Helvetica-Bold' : 'Helvetica').fontSize(size);
            const heights = cells.map((cell, i) =>
              doc.heightOfString(cell || ' ', { width: block.columns[i]!.width - 2 * CELL_PADDING }),
            );
            const rowHeight = Math.max(...heights) + 2 * CELL_PADDING;
            if (y + rowHeight > bottomLimit) return false;
            let x = PAGE_MARGIN;
            if (header) {
              doc.save().rect(x, y, CONTENT_WIDTH, rowHeight).fill('#e6e6e6').restore();
            }
            cells.forEach((cell, i) => {
              const width = block.columns[i]!.width;
              doc.save().lineWidth(0.5).rect(x, y, width, rowHeight).stroke('#555555').restore();
              if (cell) {
                doc.fillColor('#000000').text(cell, x + CELL_PADDING, y + CELL_PADDING, {
                  width: width - 2 * CELL_PADDING,
                });
              }
              x += width;
            });
            y += rowHeight;
            return true;
          };
          const headerCells = block.columns.map((column) => column.title);
          ensure(60);
          drawRow(headerCells, true);
          for (const row of block.rows) {
            if (!drawRow(row, false)) {
              newPage();
              drawRow(headerCells, true); // en-tête répété sur la nouvelle page
              drawRow(row, false);
            }
          }
          y += 12;
          break;
        }
      }
    }

    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i += 1) {
      doc.switchToPage(i);
      doc.font('Helvetica').fontSize(7.5).fillColor('#444444');
      doc.text(`${footer} — Page ${i + 1}/${range.count}`, PAGE_MARGIN, doc.page.height - 35, {
        width: CONTENT_WIDTH,
        lineBreak: false,
      });
    }
    doc.end();
  });
}

/** PDF « scanné » : uniquement des formes, aucun texte extractible. */
function renderScannedPdf(): Promise<Buffer> {
  return new Promise((resolvePdf, reject) => {
    const doc = new PDFDocument({ size: 'A4', info: { CreationDate: FIXED_DATE, ModDate: FIXED_DATE } });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolvePdf(Buffer.concat(chunks)));
    doc.on('error', reject);
    for (let page = 0; page < 2; page += 1) {
      if (page > 0) doc.addPage();
      for (let line = 0; line < 30; line += 1) {
        doc.rect(60, 80 + line * 22, 300 + ((line * 37) % 160), 9).fill('#333333');
      }
    }
    doc.end();
  });
}

// =============================================================================
// Catalogue XLSX (CAT-ANA) : écriture minimale OOXML avec fflate
// =============================================================================

type XlsxCell = string | number | null;
interface XlsxSheet {
  name: string;
  rows: XlsxCell[][];
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columnName(index: number): string {
  let name = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    name = String.fromCharCode(65 + rem) + name;
    n = Math.floor((n - 1) / 26);
  }
  return name;
}

function buildXlsx(sheets: XlsxSheet[]): Uint8Array {
  const shared: string[] = [];
  const sharedIndex = new Map<string, number>();
  const sst = (value: string) => {
    let index = sharedIndex.get(value);
    if (index === undefined) {
      index = shared.length;
      shared.push(value);
      sharedIndex.set(value, index);
    }
    return index;
  };
  const files: Record<string, Uint8Array> = {};
  sheets.forEach((sheet, sheetIndex) => {
    const rowsXml = sheet.rows
      .map((row, r) => {
        const cells = row
          .map((cell, c) => {
            if (cell === null || cell === '') return '';
            const ref = `${columnName(c)}${r + 1}`;
            if (typeof cell === 'number') return `<c r="${ref}"><v>${cell}</v></c>`;
            return `<c r="${ref}" t="s"><v>${sst(cell)}</v></c>`;
          })
          .join('');
        return `<row r="${r + 1}">${cells}</row>`;
      })
      .join('');
    files[`xl/worksheets/sheet${sheetIndex + 1}.xml`] = strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rowsXml}</sheetData></worksheet>`,
    );
  });
  files['xl/sharedStrings.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${shared.length}" uniqueCount="${shared.length}">${shared
      .map((value) => `<si><t xml:space="preserve">${xmlEscape(value)}</t></si>`)
      .join('')}</sst>`,
  );
  files['xl/workbook.xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${sheets
      .map((sheet, i) => `<sheet name="${xmlEscape(sheet.name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
      .join('')}</sheets></workbook>`,
  );
  files['xl/_rels/workbook.xml.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${sheets
      .map(
        (_sheet, i) =>
          `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`,
      )
      .join('')}<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`,
  );
  files['_rels/.rels'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
  );
  files['[Content_Types].xml'] = strToU8(
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${sheets
      .map(
        (_sheet, i) =>
          `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`,
      )
      .join('')}<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>`,
  );
  const mtime = FIXED_DATE;
  return zipSync(
    Object.fromEntries(Object.entries(files).map(([name, data]) => [name, [data, { mtime }]])),
    { level: 6 },
  );
}

const CATALOG_HEADER = [
  'Code',
  'Analyse',
  'Synonymes',
  'Tube',
  'Tube refusé',
  'Volume minimal (mL)',
  'Conservation',
  'Stabilité',
  'Délai de rendu',
  'Remarques',
];

function catalogXlsx(): Uint8Array {
  const title = ['Catalogue FICTIF des analyses — ' + LAB + ' — version 2026-03'];
  return buildXlsx([
    {
      name: 'Biochimie',
      rows: [
        title,
        [FICTIF_NOTICE],
        [],
        CATALOG_HEADER,
        ['MG', 'Magnésium', 'Mg', 'Héparine de lithium (bouchon vert)', 'EDTA', 2, 'Température ambiante', '7 jours à 2-8 °C', '24 h', null],
        ['URIC', 'Acide urique', 'Uricémie', 'Héparine de lithium (bouchon vert)', null, 2, 'Température ambiante', '3 jours à 2-8 °C', '4 h', null],
        ['CHOL', 'Cholestérol total', null, 'Tube sec avec gel (bouchon jaune)', null, 2, 'Température ambiante', '7 jours à 2-8 °C', '24 h', 'Patient à jeun de 12 h recommandé'],
        ['TG', 'Triglycérides', null, 'Tube sec avec gel (bouchon jaune)', null, 2, 'Température ambiante', '3 jours à 2-8 °C', '24 h', 'Patient à jeun de 12 h obligatoire'],
        ['ASAT', 'ASAT', 'TGO, aspartate aminotransférase', 'Héparine de lithium (bouchon vert)', null, 2, 'Température ambiante', '3 jours à 2-8 °C', '4 h', 'Hémolyse : résultat faussement augmenté'],
        ['ALAT', 'ALAT', 'TGP, alanine aminotransférase', 'Héparine de lithium (bouchon vert)', null, 2, 'Température ambiante', '3 jours à 2-8 °C', '4 h', null],
        ['GGT', 'Gamma GT', 'GGT', 'Héparine de lithium (bouchon vert)', null, 2, 'Température ambiante', '7 jours à 2-8 °C', '4 h', null],
        ['PAL', 'Phosphatases alcalines', 'PAL', 'Héparine de lithium (bouchon vert)', 'EDTA, citrate', 2, 'Température ambiante', '7 jours à 2-8 °C', '4 h', null],
        ['PHOS', 'Phosphore', 'Phosphates', 'Héparine de lithium (bouchon vert)', 'EDTA', 2, 'Température ambiante', '24 h', '4 h', 'Centrifuger dans les 2 h'],
        ['PCT', 'Procalcitonine', null, 'Héparine de lithium (bouchon vert)', null, 0.5, 'Température ambiante', '24 h à 2-8 °C', '2 h', null],
        ['CORT', 'Cortisol (8 h)', 'Cortisolémie', 'Tube sec avec gel (bouchon jaune)', null, 2, 'Température ambiante', '24 h', '24 h', 'Prélèvement entre 7 h et 9 h'],
        ['HCG', 'Bêta-HCG', 'bHCG, hormone chorionique gonadotrope', 'Tube sec avec gel (bouchon jaune)', null, 2, 'Température ambiante', '3 jours à 2-8 °C', '2 h', null],
      ],
    },
    {
      name: 'Hématologie',
      rows: [
        title,
        [],
        CATALOG_HEADER,
        ['PLQC', 'Numération plaquettaire sur citrate', 'Plaquettes sur citrate, contrôle de pseudo-thrombopénie', 'Citrate de sodium 3,2 % (bouchon bleu clair)', null, 2, 'Température ambiante', '4 h', '2 h', 'Uniquement en complément d’une NFS sur EDTA ; ne remplace pas la NFS'],
        ['FROT', 'Frottis sanguin', null, 'EDTA K2 (bouchon mauve)', null, 2, 'Température ambiante', '6 h', '24 h', null],
        ['EHB', "Électrophorèse de l'hémoglobine", null, 'EDTA K2 (bouchon mauve)', 'Héparine de lithium', 4, 'Température ambiante', '7 jours à 2-8 °C', '7 jours', 'Analyse transmise'],
      ],
    },
    {
      name: 'Légende',
      rows: [
        ['Légende du catalogue FICTIF'],
        [],
        ['Abréviation', 'Signification'],
        ['TA', 'Température ambiante (15-25 °C)'],
        ['2-8 °C', 'Réfrigérateur'],
        ['Délai de rendu', 'Délai entre réception au laboratoire et validation biologique'],
      ],
    },
  ]);
}

// =============================================================================
// CSV (CAT-SPEC) : analyses transmises, séparateur « ; », UTF-8 avec BOM
// =============================================================================

function specialTestsCsv(): string {
  const rows = [
    ['Code', 'Analyse', 'Tube', 'Volume', 'Transport', 'Délai de rendu', 'Remarques'],
    ['VITD', 'Vitamine D (25-OH)', 'Tube sec avec gel (bouchon jaune)', '2 mL', 'Température ambiante', '5 jours', ''],
    ['ACTH', 'ACTH', 'EDTA K2 (bouchon mauve)', '2 mL', 'Dans la glace ; centrifuger dans les 30 minutes', '7 jours', 'Prélèvement entre 7 h et 10 h'],
    ['HOMOC', 'Homocystéine', 'EDTA K2 (bouchon mauve)', '2 mL', 'Dans la glace', '10 jours', 'Centrifuger dans l’heure'],
    ['EPP', 'Électrophorèse des protéines sériques', 'Tube sec avec gel (bouchon jaune)', '2 mL', 'Température ambiante', '5 jours', ''],
    ['TPO', 'Anticorps anti-TPO', 'Tube sec avec gel (bouchon jaune)', '2 mL', 'Température ambiante', '7 jours', ''],
    ['PTH', 'Parathormone (PTH)', 'EDTA K2 (bouchon mauve)', '2 mL', 'Réfrigéré (2-8 °C) ; centrifuger dans les 2 h', '5 jours', 'Tube sec refusé.\nPréciser l’heure du prélèvement'],
  ];
  const quote = (value: string) => (/[;"\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const lines = [
    `# ${FICTIF_NOTICE}`,
    ...rows.map((row) => row.map(quote).join(';')),
  ];
  return '﻿' + lines.join('\r\n') + '\r\n';
}

// =============================================================================
// Procédure DOCX (PROC-NC-001)
// =============================================================================

function docxTable(header: string[], rows: string[][]): Table {
  const border = { style: BorderStyle.SINGLE, size: 4, color: '555555' };
  const cell = (text: string, bold: boolean) =>
    new TableCell({
      children: [new Paragraph({ children: [new TextRun({ text, bold })] })],
      borders: { top: border, bottom: border, left: border, right: border },
    });
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [
      new TableRow({ tableHeader: true, children: header.map((text) => cell(text, true)) }),
      ...rows.map((row) => new TableRow({ children: row.map((text) => cell(text, false)) })),
    ],
  });
}

async function procedureDocx(): Promise<Buffer> {
  const p = (text: string) => new Paragraph({ children: [new TextRun(text)], spacing: { after: 120 } });
  const h1 = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_1 });
  const h2 = (text: string) => new Paragraph({ text, heading: HeadingLevel.HEADING_2 });
  const bullet = (text: string) => new Paragraph({ text, bullet: { level: 0 } });
  const children: Array<Paragraph | Table> = [
    new Paragraph({ text: 'Gestion des non-conformités pré-analytiques', heading: HeadingLevel.TITLE, alignment: AlignmentType.CENTER }),
    p(`${LAB} — Procédure PROC-NC-001 — version 1.2 — applicable au 01/02/2026.`),
    p(FICTIF_NOTICE),
    h1('1. Objet'),
    p('Cette procédure définit la conduite à tenir lorsqu’un échantillon reçu au laboratoire fictif ne respecte pas les exigences pré-analytiques du manuel de prélèvement MP-PRE-001.'),
    h1('2. Domaine d’application'),
    p('Elle s’applique au personnel de réception des échantillons, aux techniciens et aux biologistes. Elle ne traite pas des non-conformités analytiques.'),
    h1('3. Définitions'),
    bullet('Non-conformité : écart entre l’échantillon reçu et les exigences du manuel de prélèvement.'),
    bullet('Dérogation : décision tracée d’un biologiste d’analyser malgré une non-conformité.'),
    bullet('Échantillon précieux : échantillon difficile ou impossible à reprélever (LCR, liquide de ponction, prélèvement pédiatrique).'),
    h1('4. Critères de non-conformité et conduite à tenir'),
    p('Le tableau ci-dessous est la référence pour la réception. Une ligne correspond à un type de non-conformité.'),
    docxTable(
      ['Non-conformité', 'Exemple', 'Conduite à tenir', 'Dérogation possible'],
      [
        ['Tube inadapté à l’analyse', 'NFS reçue uniquement sur tube citrate', 'Refuser l’analyse et demander un nouveau prélèvement sur le tube indiqué au manuel', 'Non'],
        ['Tube citrate mal rempli', 'Remplissage inférieur à 90 % du volume nominal', 'Refuser les analyses d’hémostase', 'Non'],
        ['Échantillon hémolysé', 'Potassium sur tube hémolysé', 'Refuser le potassium ; réaliser les autres analyses avec un commentaire', 'Non pour le potassium'],
        ['Délai de stabilité dépassé', 'Glycémie sur tube sec reçu après 4 h', 'Refuser l’analyse concernée', 'Oui, par un biologiste, pour un échantillon précieux'],
        ['Identification absente ou discordante', 'Tube sans étiquette', 'Ne pas analyser ; contacter le service', 'Oui, uniquement pour un échantillon précieux, après identification par le préleveur'],
        ['Transport non conforme', 'Ammoniémie reçue à température ambiante', 'Refuser l’analyse', 'Non'],
      ],
    ),
    h1('5. Enregistrement et traçabilité'),
    p('Toute non-conformité est enregistrée dans le système informatique du laboratoire avec le motif, l’heure de réception et le nom de la personne qui l’a constatée. Le service prescripteur est informé par téléphone pour les analyses urgentes.'),
    h2('5.1 Commentaire sur le compte rendu'),
    p('Lorsqu’une analyse est réalisée par dérogation, le compte rendu porte le commentaire : « Résultat obtenu sur un échantillon non conforme, à interpréter avec prudence ».'),
    h2('5.2 Indicateurs'),
    p('Le taux de non-conformités par service est suivi chaque mois par la cellule qualité fictive.'),
    h1('6. Documents associés'),
    bullet('MP-PRE-001 Manuel de prélèvement (version en vigueur).'),
    bullet('CAT-ANA Catalogue des analyses.'),
  ];
  const doc = new DocxDocument({
    creator: LAB,
    title: 'Gestion des non-conformités pré-analytiques (FICTIF)',
    sections: [{ children }],
  });
  return Packer.toBuffer(doc);
}

// =============================================================================
// Consignes de transport (Markdown)
// =============================================================================

function transportMarkdown(): string {
  return `# Consignes de transport des échantillons

> ${FICTIF_NOTICE}

Document CONS-TR-001, version 1, ${LAB}.

## Principes

Les échantillons sont transportés en position verticale, dans une boîte fermée portant le logo « risque biologique ».
Le coursier remet les échantillons en main propre à la réception du laboratoire.

## Températures de transport

| Analyse | Température | Délai maximal |
| --- | --- | --- |
| Ammoniémie | Dans la glace | 30 minutes |
| Lactate | Dans la glace | 15 minutes |
| Calcium ionisé | Sur glace | 30 minutes |
| Bilirubine | Température ambiante, à l'abri de la lumière | 4 h |
| Potassium | Température ambiante, ne pas réfrigérer | 4 h |

## En cas de retard

- Prévenir le laboratoire dès que le délai risque d'être dépassé.
- Ne jamais placer au réfrigérateur un tube destiné au potassium.
`;
}

// =============================================================================
// Écriture
// =============================================================================

async function main(): Promise<void> {
  mkdirSync(OUT_DIR, { recursive: true });
  const write = (name: string, data: Uint8Array | string) => {
    writeFileSync(join(OUT_DIR, name), data);
    process.stdout.write(`  ${name}\n`);
  };
  process.stdout.write(`Corpus FICTIF -> ${OUT_DIR}\n`);
  write(
    'manuel-prelevement-v3.pdf',
    await renderPdf(manualBlocks(3), `${LAB} — MP-PRE-001 version 3 — DOCUMENT FICTIF`),
  );
  write(
    'manuel-prelevement-v2.pdf',
    await renderPdf(manualBlocks(2), `${LAB} — MP-PRE-001 version 2 — DOCUMENT FICTIF`),
  );
  write('catalogue-analyses.xlsx', catalogXlsx());
  write('analyses-specialisees.csv', specialTestsCsv());
  write('procedure-non-conformites.docx', await procedureDocx());
  write('consignes-transport.md', transportMarkdown());
  write('scan-sans-texte.pdf', await renderScannedPdf());
}

await main();
