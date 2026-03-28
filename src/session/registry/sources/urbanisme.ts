/**
 * geocontext — Sources Urbanisme
 *
 * Couches du Géoportail de l'Urbanisme (GPU) exposées via le WFS Géoplateforme.
 * Documents d'urbanisme (PLU, PLUi, POS, CC, PSMV) et leurs composantes :
 * zonages, prescriptions, servitudes d'utilité publique.
 *
 * ⚠ Subtilité partition GPU :
 *   - wfs_du:document    → filtre par grid_name = code_insee (pas de préfixe)
 *   - zone_urba + prescriptions → filtre par partition = 'DU_{code_insee}'
 *     PLUi intercommunal : partition = 'DU_{siren_epci}' (fallback)
 *   - wfs_sup (SUP) → partition très complexe ({prefix}_SUP_{insee}_{type})
 *     → filtre spatial BBOX à la place
 *
 * Typenames WFS :
 *   wfs_du:document          — documents d'urbanisme en vigueur
 *   wfs_du:zone_urba         — zonages (U, AU, A, N)
 *   wfs_du:prescription_surf — prescriptions surfaciques
 *   wfs_du:prescription_lin  — prescriptions linéaires
 *   wfs_du:prescription_pct  — prescriptions ponctuelles
 *   wfs_sup:assiette_sup_s   — servitudes d'utilité publique surfaciques
 *   wfs_sup:assiette_sup_l   — servitudes linéaires
 *   wfs_sup:assiette_sup_p   — servitudes ponctuelles
 *
 * @see docs/terrid-spec.md — contrainte partition variable
 */

import type { SourceDef, UserFilterDef } from "../types.js";

// ---------------------------------------------------------------------------
// Pivots GPU
// ---------------------------------------------------------------------------

/**
 * Pivot pour wfs_du:document — filtre par grid_name (code_insee direct, sans préfixe).
 */
const DOCUMENT_PIVOT = {
  strategy: "attribute" as const,
  attribute: "grid_name",
  from: "context.code" as const,
};

/**
 * Pivot pour zone_urba, prescriptions — partition = 'DU_{code_insee}'.
 * Fallback PLUi : partition = 'DU_{siren_epci}'.
 * Le préfixe "DU_" est appliqué automatiquement via valuePrefix.
 */
const GPU_PARTITION_PIVOT = {
  strategy: "attribute_with_fallback" as const,
  attribute: "partition",
  primary: { from: "context.code" as const },
  fallback: {
    from: ["hierarchy.epci.siren" as const],
    separator: "",
  },
  cacheKey: "_partition_gpu",
  valuePrefix: "DU_",
};

/**
 * Pivot SUP — filtre spatial BBOX (partition trop complexe pour être construit).
 */
const SUP_SPATIAL_PIVOT = {
  strategy: "spatial" as const,
  spatialOp: "bbox" as const,
  from: "context.bbox" as const,
};

// ==========================================================================
// Document d'urbanisme
// ==========================================================================

/**
 * Document d'urbanisme en vigueur sur la commune.
 *
 * Retourne le type de document (PLU, PLUi, POS, CC, PSMV),
 * son statut GPU et sa date de mise à jour.
 *
 * Le document est unique par commune (sauf cas rares de transition PLU→PLUi).
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
  pivot: DOCUMENT_PIVOT,
  fields: [
    { key: "id", label: "Identifiant GPU", type: "string", primary: false },
    {
      key: "du_type",
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
      key: "gpu_status",
      label: "Statut",
      type: "enum",
      enumValues: {
        production: "En vigueur",
        archivé: "Archivé",
      },
      primary: true,
    },
    {
      key: "gpu_timestamp",
      label: "Dernière mise à jour",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: true,
    },
    { key: "name", label: "Référence", type: "string", primary: false },
    { key: "partition", label: "Partition GPU", type: "string", primary: false },
  ],
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
];

/**
 * Zonages PLU de la commune.
 *
 * Zones U (Urbaines), AU (À Urbaniser), A (Agricoles), N (Naturelles).
 * Chaque zone porte un libellé et une destination dominante.
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
  pivot: GPU_PARTITION_PIVOT,
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
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  userFilters: ZONAGE_FILTERS,
  constraints: {
    paginable: true,
  },
  priority: "required",
};

/**
 * Zonages PLU pour le niveau parcelle — pivot spatial INTERSECTS.
 *
 * Trouve la ou les zones PLU qui intersectent la parcelle.
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
  pivot: GPU_PARTITION_PIVOT,
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
  pivot: GPU_PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "txt", label: "Texte", type: "string", primary: false },
    { key: "typepsc", label: "Type", type: "string", primary: true },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
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
  pivot: GPU_PARTITION_PIVOT,
  fields: [
    { key: "libelle", label: "Libellé", type: "string", primary: true },
    { key: "txt", label: "Texte", type: "string", primary: false },
    { key: "typepsc", label: "Type", type: "string", primary: true },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
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
 * ⚠ Filtre spatial BBOX — la partition SUP suit un format trop complexe
 * ({code_dept_prefix}_SUP_{code_insee}_{sup_type}) pour être construit
 * automatiquement. Le filtre spatial est plus robuste.
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
  pivot: SUP_SPATIAL_PIVOT,
  fields: [
    { key: "nomass", label: "Nom", type: "string", primary: true },
    { key: "typeass", label: "Type", type: "string", primary: true },
    {
      key: "suptype",
      label: "Code servitude",
      type: "string",
      primary: false,
    },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
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
  pivot: SUP_SPATIAL_PIVOT,
  fields: [
    { key: "nomass", label: "Nom", type: "string", primary: true },
    { key: "typeass", label: "Type", type: "string", primary: true },
    { key: "suptype", label: "Code servitude", type: "string", primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: { spatialOnly: true },
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
  pivot: SUP_SPATIAL_PIVOT,
  fields: [
    { key: "nomass", label: "Nom", type: "string", primary: true },
    { key: "typeass", label: "Type", type: "string", primary: true },
    { key: "suptype", label: "Code servitude", type: "string", primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: { spatialOnly: true },
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
