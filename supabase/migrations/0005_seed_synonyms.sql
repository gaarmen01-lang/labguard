-- =============================================================================
-- LabGuard — 0005_seed_synonyms : glossaire initial (modifiable par l'admin).
--
-- Règles d'écriture :
--   * un group_key = un concept ; tous ses termes sont équivalents ;
--   * éviter les couleurs seules ambiguës (« rouge » : globules rouges…) :
--     préférer « tube rouge » / « bouchon rouge » ;
--   * pas de termes numériques (« 2-8 °C ») : la tokenisation FTS les découpe
--     différemment.
-- Les couleurs suivent l'usage courant en France (ISO 6710) ; chaque
-- laboratoire doit vérifier qu'elles correspondent à SES tubes.
-- =============================================================================

insert into public.synonyms (group_key, term, note) values
  -- Tubes / anticoagulants
  ('tube_edta', 'EDTA', 'Tube à bouchon violet/mauve/lavande'),
  ('tube_edta', 'K2 EDTA', null),
  ('tube_edta', 'K3 EDTA', null),
  ('tube_edta', 'EDTA K2', null),
  ('tube_edta', 'EDTA K3', null),
  ('tube_edta', 'K2EDTA', null),
  ('tube_edta', 'K3EDTA', null),
  ('tube_edta', 'tube EDTA', null),
  ('tube_edta', 'tube mauve', null),
  ('tube_edta', 'tube violet', null),
  ('tube_edta', 'tube lavande', null),
  ('tube_edta', 'bouchon mauve', null),
  ('tube_edta', 'bouchon violet', null),
  ('tube_edta', 'bouchon lavande', null),
  ('tube_edta', 'mauve', null),
  ('tube_edta', 'lavande', null),
  ('tube_edta', 'acide éthylène diamine tétra-acétique', null),

  ('tube_citrate', 'citrate', 'Tube à bouchon bleu clair (hémostase)'),
  ('tube_citrate', 'citrate de sodium', null),
  ('tube_citrate', 'citrate trisodique', null),
  ('tube_citrate', 'tube citrate', null),
  ('tube_citrate', 'tube citraté', null),
  ('tube_citrate', 'tube bleu', null),
  ('tube_citrate', 'tube bleu clair', null),
  ('tube_citrate', 'bouchon bleu', null),
  ('tube_citrate', 'bouchon bleu clair', null),
  ('tube_citrate', 'tube hémostase', null),
  ('tube_citrate', 'tube coag', null),

  ('tube_heparin', 'héparine', 'Tube à bouchon vert'),
  ('tube_heparin', 'héparine de lithium', null),
  ('tube_heparin', 'héparine lithium', null),
  ('tube_heparin', 'héparinate de lithium', null),
  ('tube_heparin', 'lithium héparine', null),
  ('tube_heparin', 'tube hépariné', null),
  ('tube_heparin', 'tube héparine', null),
  ('tube_heparin', 'tube vert', null),
  ('tube_heparin', 'bouchon vert', null),

  ('tube_heparin_gel', 'tube vert clair', 'Héparine de lithium + gel séparateur (PST)'),
  ('tube_heparin_gel', 'bouchon vert clair', null),
  ('tube_heparin_gel', 'PST', null),
  ('tube_heparin_gel', 'héparine avec gel', null),

  ('tube_serum_plain', 'tube sec', 'Tube sans additif / avec activateur, bouchon rouge'),
  ('tube_serum_plain', 'tube sec sans gel', null),
  ('tube_serum_plain', 'tube rouge', null),
  ('tube_serum_plain', 'bouchon rouge', null),
  ('tube_serum_plain', 'tube sans additif', null),
  ('tube_serum_plain', 'activateur de coagulation', null),

  ('tube_serum_gel', 'tube gel', 'Tube sec avec gel séparateur (SST), bouchon jaune/or'),
  ('tube_serum_gel', 'tube sec avec gel', null),
  ('tube_serum_gel', 'gel séparateur', null),
  ('tube_serum_gel', 'tube jaune', null),
  ('tube_serum_gel', 'bouchon jaune', null),
  ('tube_serum_gel', 'bouchon or', null),
  ('tube_serum_gel', 'SST', null),

  ('tube_fluoride', 'fluorure', 'Tube à bouchon gris (glycémie, lactates)'),
  ('tube_fluoride', 'fluorure de sodium', null),
  ('tube_fluoride', 'NaF', null),
  ('tube_fluoride', 'fluorure oxalate', null),
  ('tube_fluoride', 'oxalate de potassium', null),
  ('tube_fluoride', 'tube fluoré', null),
  ('tube_fluoride', 'tube gris', null),
  ('tube_fluoride', 'bouchon gris', null),

  ('tube_esr', 'tube noir', 'Citrate pour vitesse de sédimentation'),
  ('tube_esr', 'bouchon noir', null),
  ('tube_esr', 'tube VS', null),

  ('tube_trace_elements', 'tube bleu foncé', 'Oligo-éléments / métaux'),
  ('tube_trace_elements', 'tube bleu roi', null),
  ('tube_trace_elements', 'bouchon bleu foncé', null),
  ('tube_trace_elements', 'bouchon bleu roi', null),
  ('tube_trace_elements', 'éléments traces', null),
  ('tube_trace_elements', 'oligo-éléments', null),

  ('tube_acd', 'ACD', 'Acide citrique – citrate – dextrose'),
  ('tube_acd', 'citrate dextrose', null),
  ('tube_acd', 'acide citrique citrate dextrose', null),

  ('blood_culture', 'hémoculture', null),
  ('blood_culture', 'hémocultures', null),
  ('blood_culture', 'flacon d''hémoculture', null),

  -- Abréviations d'analyses courantes
  ('test_cbc', 'NFS', null),
  ('test_cbc', 'numération formule sanguine', null),
  ('test_cbc', 'hémogramme', null),
  ('test_cbc', 'numération globulaire', null),

  ('test_pt', 'TP', null),
  ('test_pt', 'taux de prothrombine', null),
  ('test_pt', 'temps de Quick', null),
  ('test_pt', 'INR', null),

  ('test_aptt', 'TCA', null),
  ('test_aptt', 'temps de céphaline activée', null),
  ('test_aptt', 'TCK', null),
  ('test_aptt', 'temps de céphaline kaolin', null),

  ('test_ddimer', 'D-dimères', null),
  ('test_ddimer', 'D dimères', null),
  ('test_ddimer', 'DDI', null),

  ('test_crp', 'CRP', null),
  ('test_crp', 'protéine C réactive', null),

  ('test_hba1c', 'HbA1c', null),
  ('test_hba1c', 'hémoglobine glyquée', null),
  ('test_hba1c', 'hémoglobine glycosylée', null),

  ('test_glucose', 'glycémie', null),
  ('test_glucose', 'glucose', null),

  ('test_tsh', 'TSH', null),
  ('test_tsh', 'thyréostimuline', null),

  ('test_ionogram', 'ionogramme', null),
  ('test_ionogram', 'iono', null),
  ('test_ionogram', 'électrolytes', null),

  ('test_ast', 'ASAT', null),
  ('test_ast', 'TGO', null),
  ('test_ast', 'aspartate aminotransférase', null),

  ('test_alt', 'ALAT', null),
  ('test_alt', 'TGP', null),
  ('test_alt', 'alanine aminotransférase', null),

  ('test_ggt', 'GGT', null),
  ('test_ggt', 'gamma GT', null),
  ('test_ggt', 'gamma-glutamyl transférase', null),

  ('test_hcg', 'bêta-HCG', null),
  ('test_hcg', 'bHCG', null),
  ('test_hcg', 'HCG', null),
  ('test_hcg', 'hormone chorionique gonadotrope', null),

  ('test_psa', 'PSA', null),
  ('test_psa', 'antigène prostatique spécifique', null),

  ('test_esr', 'VS', null),
  ('test_esr', 'vitesse de sédimentation', null),

  ('test_urine_culture', 'ECBU', null),
  ('test_urine_culture', 'examen cytobactériologique des urines', null),

  -- Conditions pré-analytiques
  ('cond_room_temperature', 'température ambiante', null),
  ('cond_room_temperature', 'ambiante', null),

  ('cond_refrigerated', 'réfrigéré', null),
  ('cond_refrigerated', 'réfrigérée', null),
  ('cond_refrigerated', 'réfrigérateur', null),
  ('cond_refrigerated', 'au frais', null),
  ('cond_refrigerated', 'au froid', null),

  ('cond_frozen', 'congelé', null),
  ('cond_frozen', 'congelée', null),
  ('cond_frozen', 'congélation', null),

  ('cond_on_ice', 'dans la glace', null),
  ('cond_on_ice', 'sur glace', null),
  ('cond_on_ice', 'bain de glace', null),
  ('cond_on_ice', 'carboglace', null),

  ('cond_light', 'à l''abri de la lumière', null),
  ('cond_light', 'abri de la lumière', null),
  ('cond_light', 'protégé de la lumière', null),
  ('cond_light', 'photosensible', null),

  ('cond_fasting', 'à jeun', null),
  ('cond_fasting', 'patient à jeun', null)
on conflict on constraint synonyms_group_term_key do nothing;
