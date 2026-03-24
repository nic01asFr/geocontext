/**
 * geocontext — Sources Urbanisme
 *
 * Couches du Géoportail de l'Urbanisme (GPU) exposées via le WFS Géoplateforme.
 * Documents d'urbanisme (PLU, PLUi, POS, CC, PSMV) et leurs composantes :
 * zonages, prescriptions, servitudes d'utilité publique.
 *
 * ⚠ Subtilité partition :
 *   - PLU communal  → partition = code_insee (ex: "25349")
 *   - PLUi intercommunal → partition = siren_code_insee (ex: "200067874_25349")
 *   On ne sait pas lequel sans essayer → stratégie attribute_with_fallback.
 *   Le format trouvé est mis en cache (clé "_partition_urba") pour les
 *   requêtes suivantes sur la même commune.
 *
 * Typenames WFS :
 *   wfs_du:document          — documents d'urbanisme en vigueur
 *   wfs_du:zone_urba         — zonages (U, AU, A, N)
 *   wfs_du:prescription_surf — prescriptions surfaciques
 *   wfs_du:prescription_lin  — prescriptions linéaires
 *   wfs_du:prescription_pct  — prescriptions ponctuelles
 *
 * @see docs/terrid-spec.md — contrainte partition variable
 */

import type { SourceDef, UserFilterDef } from "../types.js";

// ---------------------------------------------------------------------------
// Pivot commun — partition avec fallback PLU/PLUi
// ---------------------------------------------------------------------------

/**
 * Stratégie de pivot partagée par toutes les couches urbanisme.
 * Essai 1 : partition = code_insee (PLU communal)
 * Essai 2 : partition = siren_epci + "_" + code_insee (PLUi intercommunal)
 */
const PARTITION_PIVOT = {
  strategy: "attribute_with_fallback" as const,
  attribute: "partition",
  primary: { from: "context.code" as const },
  fallback: {
    from: ["hierarchy.epci.siren" as const, "context.code" as const],
    separator: "_",
  },
  cacheKey: "_partition_urba",
};

// ==========================================================================
// Document d'urbanisme
// ==========================================================================

/**
 * Document d'urbanisme en vigueur sur la commune.
 *
 * Retourne le type de document (PLU, PLUi, POS, CC, PSMV),
 * sa date d'approbation, et son état (en vigueur, annulé...).
 *
 * Le document est unique par commune (sauf cas rares de transition).
 */
export const URBANISME_DOCUMENT: SourceDef = {
  id: "urba_document",
  label: "Document d'urbanisme",
  description: "PLU/PLUi/POS/CC/PSMV en vigueur sur la commune",
  endpoint: "gpf_wfs",
  typename: "wfs_du:document",
  levels: ["commune"],
  theme: "urbanisme",
  action: "document",
  pivot: PARTITION_PIVOT,
  fields: [
    { key: "idurba", label: "Identifiant", type: "string", primary: false },
    {
      key: "typedoc",
      label: "Type de document",
      type: "enum",
      enumValues: {
        PLU: "Plan Local d'Urbanisme",
        PLUi: "PLU intercommunal",
        POS: "Plan d'Occupation des Sols",
        CC: "Carte Communale",
        PSMV: "Plan de Sauvegarde et Mise en Valeur",
        RNU: "Règlement National d'Urbanisme",
      },
      primary: true,
    },
    {
      key: "etat",
      label: "État",
      type: "enum",
      enumValues: {
        "01": "En cours de procédure",
        "02": "Arrêté",
        "03": "Opposable",
        "04": "Annulé",
        "05": "Remplacé",
        "06": "Abrogé",
        "07": "Approuvé",
        "08": "Partiellement annulé",
        "09": "Caduc",
      },
      primary: true,
    },
    {
      key: "datappro",
      label: "Date d'approbation",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: true,
    },
    { key: "datefin", label: "Date de fin", type: "date", transforms: ["parse_date_iso"], primary: false },
    { key: "nomplan", label: "Nom du plan", type: "string", primary: false },
    { key: "urlplan", label: "URL du plan", type: "string", primary: false },
    { key: "urlpe", label: "URL pièces écrites", type: "string", primary: false },
  ],
  constraints: {
    partitionFallback: true,
  },
  priority: "required",
};

// ==========================================================================
// Zonages
// ==========================================================================

/**
 * Filtres utilisateur pour les zonages PLU.
 */
const ZONAGE_FILTERS: UserFilterDef[] = [
  {
    key: "type_zone",
    label: "Type de zone",
    type: "enum",
    values: {
      U: "Urbaine",
      AU: "À Urbaniser",
      A: "Agricole",
      N: "Naturelle",
    },
    toCql: "typezone = '{value}'",
  },
  {
    key: "surface_min",
    label: "Surface minimale",
    type: "number_min",
    toCql: "superficie",
  },
];

/**
 * Zonages PLU de la commune.
 *
 * Zones U (Urbaines), AU (À Urbaniser), A (Agricoles), N (Naturelles).
 * Chaque zone porte un libellé, une destination dominante, et une surface.
 *
 * Au niveau parcelle, le pivot est spatial (INTERSECTS sur la géométrie
 * de la parcelle) pour trouver dans quelle zone elle se situe.
 */
export const URBANISME_ZONAGES: SourceDef = {
  id: "urba_zonages",
  label: "Zonages PLU",
  description: "Zones U/AU/A/N du PLU en vigueur",
  endpoint: "gpf_wfs",
  typename: "wfs_du:zone_urba",
  levels: ["commune", "parcelle"],
  theme: "urbanisme",
  action: "zonages",
  pivot: PARTITION_PIVOT,
  fields: [
    {
      key: "typezone",
      label: "Type de zone",
      type: "enum",
      enumValues: {
        U: "Urbaine",
        AU: "À Urbaniser",
        A: "Agricole",
        N: "Naturelle",
        AUc: "À Urbaniser constructible",
        AUs: "À Urbaniser strict",
        Nh: "Naturelle habitat",
      },
      primary: true,
    },
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "libelong", label: "Libellé long", type: "string", primary: false },
    {
      key: "destdomi",
      label: "Destination dominante",
      type: "enum",
      enumValues: {
        "01": "Habitat",
        "02": "Activité",
        "03": "Destination mixte",
        "04": "Loisirs et tourisme",
        "05": "Équipement",
        "06": "Infrastructure",
        "07": "Espace naturel",
        "08": "Espace agricole",
        "09": "Espace forestier",
        "99": "Autre",
        "00": "Sans objet",
      },
      primary: false,
    },
    {
      key: "superficie",
      label: "Superficie",
      type: "number",
      unit: "ha",
      transforms: ["m2_to_ha"],
      primary: true,
    },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  userFilters: ZONAGE_FILTERS,
  constraints: {
    partitionFallback: true,
    paginable: true,
  },
  priority: "required",
};

/**
 * Zonages PLU pour le niveau parcelle — pivot spatial.
 *
 * Trouve la ou les zones PLU qui intersectent la parcelle.
 * Utilise la géométrie de la parcelle (INTERSECTS), pas la partition.
 */
export const PARCELLE_ZONAGE: SourceDef = {
  id: "urba_zonage_parcelle",
  label: "Zonage de la parcelle",
  description: "Zone(s) PLU dans laquelle se situe la parcelle",
  endpoint: "gpf_wfs",
  typename: "wfs_du:zone_urba",
  levels: ["parcelle"],
  theme: "urbanisme",
  action: "zonage",
  pivot: {
    strategy: "spatial",
    spatialOp: "intersects",
    from: "context.geometry",
  },
  fields: URBANISME_ZONAGES.fields,
  constraints: {
    spatialOnly: true,
    requiresGeometry: true,
  },
  priority: "required",
};

// ==========================================================================
// Prescriptions
// ==========================================================================

/**
 * Prescriptions surfaciques du PLU.
 *
 * Emplacements réservés, secteurs de mixité sociale,
 * périmètres de protection, recul de construction, etc.
 */
export const URBANISME_PRESCRIPTIONS_SURF: SourceDef = {
  id: "urba_prescriptions_surf",
  label: "Prescriptions surfaciques",
  description: "Prescriptions surfaciques du PLU (emplacements réservés, secteurs...)",
  endpoint: "gpf_wfs",
  typename: "wfs_du:prescription_surf",
  levels: ["commune", "parcelle"],
  theme: "urbanisme",
  action: "prescriptions",
  pivot: PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "txt", label: "Texte", type: "string", primary: false },
    {
      key: "typepsc",
      label: "Type de prescription",
      type: "enum",
      enumValues: {
        "01": "Espace boisé classé",
        "02": "Limitation de la constructibilité",
        "03": "Secteur de mixité sociale",
        "04": "Périmètre de protection",
        "05": "Emplacement réservé",
        "06": "Secteur de taille minimum",
        "07": "Espace remarquable du littoral",
        "08": "Coupure d'urbanisation",
        "15": "Secteur de risques",
        "16": "Secteur patrimoine bâti",
        "99": "Autre",
      },
      primary: true,
    },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    partitionFallback: true,
    paginable: true,
  },
  priority: "recommended",
};

/**
 * Prescriptions linéaires du PLU.
 */
export const URBANISME_PRESCRIPTIONS_LIN: SourceDef = {
  id: "urba_prescriptions_lin",
  label: "Prescriptions linéaires",
  description: "Prescriptions linéaires du PLU (alignements, recul...)",
  endpoint: "gpf_wfs",
  typename: "wfs_du:prescription_lin",
  levels: ["commune", "parcelle"],
  theme: "urbanisme",
  action: "prescriptions",
  pivot: PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "txt", label: "Texte", type: "string", primary: false },
    { key: "typepsc", label: "Type", type: "string", primary: true },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    partitionFallback: true,
  },
  priority: "recommended",
};

/**
 * Prescriptions ponctuelles du PLU.
 */
export const URBANISME_PRESCRIPTIONS_PCT: SourceDef = {
  id: "urba_prescriptions_pct",
  label: "Prescriptions ponctuelles",
  description: "Prescriptions ponctuelles du PLU (points particuliers)",
  endpoint: "gpf_wfs",
  typename: "wfs_du:prescription_pct",
  levels: ["commune", "parcelle"],
  theme: "urbanisme",
  action: "prescriptions",
  pivot: PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "txt", label: "Texte", type: "string", primary: false },
    { key: "typepsc", label: "Type", type: "string", primary: true },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    partitionFallback: true,
  },
  priority: "optional",
};

// ==========================================================================
// Servitudes d'utilité publique (SUP)
// ==========================================================================

/**
 * Assiettes de servitudes d'utilité publique surfaciques.
 *
 * Servitudes liées aux monuments historiques, canalisations de gaz/eau,
 * lignes électriques, cimetières, aérodromes, etc.
 *
 * Typename : ASSIETTESUP (via GPU), même logique de partition que urbanisme.
 */
export const URBANISME_SERVITUDES_SURF: SourceDef = {
  id: "urba_sup_surf",
  label: "Servitudes surfaciques",
  description: "Servitudes d'utilité publique surfaciques (monuments, canalisations...)",
  endpoint: "gpf_wfs",
  typename: "wfs_sup:assiette_sup_s",
  levels: ["commune", "parcelle"],
  theme: "urbanisme",
  action: "servitudes",
  pivot: PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    {
      key: "categorie",
      label: "Catégorie",
      type: "enum",
      enumValues: {
        AC1: "Monuments historiques",
        AC2: "Sites inscrits/classés",
        AC4: "Zone de protection du patrimoine",
        AR: "Aérodromes",
        AS1: "Conservation des eaux",
        EL: "Lignes électriques",
        GZ: "Canalisations de gaz",
        I3: "Canalisation de transport de matières dangereuses",
        I4: "Lignes de télécommunications",
        PM1: "Plans de prévention des risques naturels",
        PM3: "Plans de prévention des risques technologiques",
        PT: "Télécommunications",
        T1: "Voies ferrées",
        T7: "Routes",
      },
      primary: true,
    },
    { key: "generateur", label: "Générateur", type: "string", primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  userFilters: [
    {
      key: "categorie",
      label: "Catégorie de servitude",
      type: "enum",
      values: {
        AC1: "Monuments historiques",
        AC2: "Sites inscrits/classés",
        EL: "Lignes électriques",
        PM1: "PPR naturels",
        PM3: "PPR technologiques",
      },
      toCql: "categorie = '{value}'",
    },
  ],
  constraints: {
    partitionFallback: true,
    paginable: true,
  },
  priority: "recommended",
};

/**
 * Assiettes de servitudes d'utilité publique linéaires.
 */
export const URBANISME_SERVITUDES_LIN: SourceDef = {
  id: "urba_sup_lin",
  label: "Servitudes linéaires",
  description: "Servitudes d'utilité publique linéaires",
  endpoint: "gpf_wfs",
  typename: "wfs_sup:assiette_sup_l",
  levels: ["commune", "parcelle"],
  theme: "urbanisme",
  action: "servitudes",
  pivot: PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "categorie", label: "Catégorie", type: "string", primary: true },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: { partitionFallback: true },
  priority: "optional",
};

/**
 * Assiettes de servitudes d'utilité publique ponctuelles.
 */
export const URBANISME_SERVITUDES_PCT: SourceDef = {
  id: "urba_sup_pct",
  label: "Servitudes ponctuelles",
  description: "Servitudes d'utilité publique ponctuelles",
  endpoint: "gpf_wfs",
  typename: "wfs_sup:assiette_sup_p",
  levels: ["commune", "parcelle"],
  theme: "urbanisme",
  action: "servitudes",
  pivot: PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "categorie", label: "Catégorie", type: "string", primary: true },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: { partitionFallback: true },
  priority: "optional",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const URBANISME_SOURCES: SourceDef[] = [
  URBANISME_DOCUMENT,
  URBANISME_ZONAGES,
  PARCELLE_ZONAGE,
  URBANISME_PRESCRIPTIONS_SURF,
  URBANISME_PRESCRIPTIONS_LIN,
  URBANISME_PRESCRIPTIONS_PCT,
  URBANISME_SERVITUDES_SURF,
  URBANISME_SERVITUDES_LIN,
  URBANISME_SERVITUDES_PCT,
];
