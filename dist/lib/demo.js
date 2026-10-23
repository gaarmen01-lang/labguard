export const demoDocuments = [
  {
    id: 'demo-identification', title: 'Identification d’un prélèvement', code: 'DEMO-PRE-001', version: '1.0',
    status: 'approved', effective: '2026-01-01', pages: 2, department: 'Démonstration', fictional: true,
    content: '[Page 1]\nDOCUMENT FICTIF — EXEMPLE DE FONCTIONNEMENT, NON APPLICABLE EN LABORATOIRE.\nIdentification d’un prélèvement. Dans cet exemple, la procédure prévoit de relever les informations manquantes sans compléter l’identité par supposition. La situation est transmise au référent désigné dans l’organisation.\n\n[Page 2]\nTraçabilité du signalement. Le dossier de non-conformité de démonstration contient la date de réception, le type de prélèvement, l’anomalie constatée et le référent contacté. La décision est documentée par la personne habilitée ; l’assistant ne prend aucune décision d’acceptation ou de rejet.',
  },
  {
    id: 'demo-documentation', title: 'Versions et validation des procédures', code: 'DEMO-DOC-002', version: '2.0',
    status: 'approved', effective: '2026-01-01', pages: 1, department: 'Démonstration', fictional: true,
    content: '[Page 1]\nDOCUMENT FICTIF — EXEMPLE DE FONCTIONNEMENT, NON APPLICABLE EN LABORATOIRE.\nAvant d’activer une procédure, le responsable vérifie son titre, son code documentaire, sa version et sa date d’entrée en vigueur. Le texte extrait est comparé au fichier original, notamment pour les tableaux et les unités. Une version archivée ou un brouillon ne sert pas de source active. En cas de contradiction entre deux documents, le référent documentaire est sollicité.',
  },
  {
    id: 'demo-signalement', title: 'Décrire une non-conformité', code: 'DEMO-QUAL-003', version: '1.0',
    status: 'approved', effective: '2026-01-01', pages: null, department: 'Démonstration', fictional: true,
    content: 'DOCUMENT FICTIF — EXEMPLE DE FONCTIONNEMENT, NON APPLICABLE EN LABORATOIRE.\nUn signalement de non-conformité décrit des faits observables : nature de l’anomalie, moment de sa détection et étape concernée. Dans cette démonstration, les noms de patients, dates de naissance et numéros de dossier sont exclus. Les actions réalisées et la personne ou fonction informée sont consignées séparément des hypothèses sur la cause.',
  },
];
