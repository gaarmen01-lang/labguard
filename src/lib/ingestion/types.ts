/**
 * Représentation commune produite par tous les parseurs : une liste de pages
 * (physiques pour un PDF, logiques pour DOCX/TXT, une feuille par page pour
 * XLSX/CSV).
 *
 * Convention de texte (contrat entre parseurs et découpage) :
 *  - blocs séparés par une ligne vide ;
 *  - une ligne de tableau = une ligne de texte, cellules séparées par « | »
 *    (` | `), cellule vide rendue « — », « | » interdit dans une cellule ;
 *    la première ligne d'un bloc de tableau est son en-tête ;
 *  - un titre occupe sa propre ligne.
 * Le texte de page est ce qui est stocké dans `document_pages.content` ; les
 * chunks en sont des sous-chaînes exactes (vérification des citations).
 */

export type FileKind = 'pdf' | 'docx' | 'xlsx' | 'csv' | 'text';

export interface ParsedTable {
  /** Cellules de l'en-tête (première ligne du tableau). */
  header: string[];
  /** Lignes de données (sans l'en-tête), toutes de la même largeur que l'en-tête. */
  rows: string[][];
}

export interface ParsedHeading {
  /** Index (0-based) de la ligne du titre dans `text`. */
  line: number;
  /** 1 = titre principal. */
  level: number;
  text: string;
}

export interface ParsedPage {
  /** 1-based. */
  pageNumber: number;
  text: string;
  /** Libellé affichable (« Feuille Biochimie », « Section 2 »…). */
  label: string | null;
  tables: ParsedTable[];
  /** Titres repérés par le parseur (prioritaires sur les heuristiques). */
  headings: ParsedHeading[];
}

export interface ParsedDocument {
  kind: FileKind;
  pages: ParsedPage[];
  /** Avertissements non bloquants, en français. */
  warnings: string[];
}

export interface ParseLimits {
  maxBytes: number;
  maxPages: number;
  /** Nombre total de caractères extraits au-delà duquel on refuse. */
  maxChars: number;
}
