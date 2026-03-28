/**
 * geocontext — Sources Bâti
 *
 * Données bâtimentaires issues de trois sources complémentaires :
 *
 *   BDTOPO V3   → emprise bâtie, hauteur, nature, nb étages/logements
 *   RNB         → identifiant universel pérenne (rnb_id), statut, adresses
 *   BDNB        → 400+ champs (énergie, matériaux, risques, qualité, DPE agrégés)
 *
 * Pivot principal : spatial (bbox/intersects sur le territoire).
 * Au niveau bâtiment individuel, pivot par rnb_id ou cleabs.
 *
 * ⚠ BDNB régénère ses batiment_groupe_id à chaque vintage.
 *   → Utiliser rnb_id ou cleabs comme pivot stable vers la BDNB.
 *
 * @see docs/terrid-spec.md — identifiants pivots bâtiment
 */

import type { SourceDef } from "../types.js";

// ==========================================================================
// BDTOPO — emprise bâtie (niveau commune)
// ==========================================================================

/**
 * Bâtiments BDTOPO de la commune.
 *
 * Emprise au sol des bâtiments avec hauteur, nature, nombre de logements.
 * Filtre spatial bbox. Peut être volumineux (>1000) → pagination.
 */
export const BATI_BDTOPO_COMMUNE: SourceDef = {
  id: "bati_bdtopo_commune",
  label: "Bâtiments BDTOPO",
  description: "Emprise bâtie avec hauteur, nature et nombre de logements (BDTOPO)",
  endpoint: "gpf_wfs",
  typename: "BDTOPO_V3:batiment",
  levels: ["commune"],
  theme: "bati",
  action: "batiments",
  pivot: {
    strategy: "spatial",
    spatialOp: "bbox",
    from: "context.bbox",
    geometryColumn: "geometrie",
  },
  fields: [
    { key: "cleabs", label: "Identifiant BDTOPO", type: "string", primary: false },
    {
      key: "nature",
      label: "Nature",
      type: "enum",
      enumValues: {
        "Indifférenciée": "Indifférenciée",
        "Industriel, agricole ou commercial": "Industriel/agricole/commercial",
        "Remarquable": "Remarquable",
        "Religieux": "Religieux",
        "Sportif": "Sportif",
        "Serre": "Serre",
        "Silo": "Silo",
        "Tribune": "Tribune",
        "Tour, donjon": "Tour/donjon",
        "Moulin à vent": "Moulin à vent",
        "Château": "Château",
        "Arc de triomphe": "Arc de triomphe",
        "Fort, blockhaus, casemate": "Fort/blockhaus",
      },
      primary: true,
    },
    { key: "usage_1", label: "Usage principal", type: "string", primary: true },
    { key: "hauteur", label: "Hauteur", type: "number", unit: "m", transforms: ["round_2"], primary: true },
    { key: "nombre_de_logements", label: "Logements", type: "number", primary: true },
    { key: "nombre_d_etages", label: "Étages", type: "number", primary: false },
    { key: "etat_de_l_objet", label: "État", type: "string", primary: false },
    { key: "geometrie", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
    paginable: true,
    maxFeaturesOverride: 500,
  },
  priority: "recommended",
};

/**
 * Bâtiments BDTOPO sur une parcelle (filtre spatial INTERSECTS).
 */
export const BATI_BDTOPO_PARCELLE: SourceDef = {
  id: "bati_bdtopo_parcelle",
  label: "Bâtiments sur la parcelle",
  description: "Bâtiments BDTOPO intersectant la parcelle",
  endpoint: "gpf_wfs",
  typename: "BDTOPO_V3:batiment",
  levels: ["parcelle"],
  theme: "bati",
  action: "batiments",
  pivot: {
    strategy: "spatial",
    spatialOp: "intersects",
    from: "context.geometry",
    geometryColumn: "geometrie",
  },
  fields: BATI_BDTOPO_COMMUNE.fields,
  constraints: {
    spatialOnly: true,
    requiresGeometry: true,
  },
  priority: "recommended",
};

// ==========================================================================
// RNB — Référentiel National des Bâtiments (niveau commune)
// ==========================================================================

/**
 * Bâtiments RNB de la commune.
 *
 * Le RNB attribue un identifiant universel pérenne (rnb_id) à chaque bâtiment.
 * Format : A1B2-C3D4-E5F6 (12 caractères, tirets).
 *
 * Route : GET /buildings/?insee_code=XXXXX
 */
export const BATI_RNB_COMMUNE: SourceDef = {
  id: "bati_rnb_commune",
  label: "Bâtiments RNB",
  description: "Bâtiments avec identifiant universel pérenne (RNB)",
  endpoint: "rnb",
  path: "/buildings/",
  levels: ["commune"],
  theme: "bati",
  action: "rnb",
  pivot: {
    strategy: "attribute",
    attribute: "insee_code",
    from: "context.code",
  },
  fields: [
    { key: "rnb_id", label: "Identifiant RNB", type: "string", primary: true },
    {
      key: "status",
      label: "Statut",
      type: "enum",
      enumValues: {
        current: "Existant",
        demolished: "Démoli",
        "under construction": "En construction",
        "not usable": "Non utilisable",
      },
      primary: true,
    },
    { key: "addresses", label: "Adresses", type: "string", primary: true },
    { key: "ext_ids", label: "Identifiants externes", type: "string", primary: false },
  ],
  constraints: {
    paginable: true,
  },
  priority: "recommended",
};

/**
 * Bâtiments RNB sur une parcelle (filtre spatial).
 */
export const BATI_RNB_PARCELLE: SourceDef = {
  id: "bati_rnb_parcelle",
  label: "Bâtiments RNB sur la parcelle",
  description: "Bâtiments RNB intersectant la parcelle",
  endpoint: "rnb",
  path: "/buildings",
  levels: ["parcelle"],
  theme: "bati",
  action: "batiments",
  pivot: {
    strategy: "spatial",
    spatialOp: "bbox",
    from: "context.bbox",
  },
  fields: BATI_RNB_COMMUNE.fields,
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

// ==========================================================================
// Bâtiment individuel — identité
// ==========================================================================

/**
 * Identité d'un bâtiment via le RNB.
 *
 * Route : GET /v1/buildings/{rnb_id}
 */
export const BATIMENT_IDENTITE_RNB: SourceDef = {
  id: "bati_rnb_detail",
  label: "Identité bâtiment (RNB)",
  description: "Détail du bâtiment : adresses, statut, parcelles rattachées",
  endpoint: "rnb",
  path: "/buildings/{id}",
  levels: ["batiment"],
  theme: "identite",
  action: null,
  pivot: {
    strategy: "attribute",
    attribute: "rnb_id",
    from: "context.code",
  },
  fields: [
    { key: "rnb_id", label: "Identifiant RNB", type: "string", primary: true },
    { key: "status", label: "Statut", type: "string", primary: true },
    { key: "addresses", label: "Adresses", type: "string", primary: true },
    { key: "parcelle_ids", label: "Parcelles", type: "string", primary: true },
    { key: "ext_ids", label: "Identifiants externes", type: "string", primary: false },
    { key: "point", label: "Géométrie", type: "geometry" },
  ],
  priority: "required",
};

/**
 * Détail BDTOPO d'un bâtiment (par identifiant cleabs ou spatial).
 */
export const BATIMENT_IDENTITE_BDTOPO: SourceDef = {
  id: "bati_bdtopo_detail",
  label: "Détail bâtiment (BDTOPO)",
  description: "Hauteur, nature, nombre de logements/étages (BDTOPO)",
  endpoint: "gpf_wfs",
  typename: "BDTOPO_V3:batiment",
  levels: ["batiment"],
  theme: "bati",
  action: null,
  pivot: {
    strategy: "spatial",
    spatialOp: "bbox",
    from: "context.bbox",
    geometryColumn: "geometrie",
  },
  fields: BATI_BDTOPO_COMMUNE.fields,
  constraints: {
    spatialOnly: true,
    maxFeaturesOverride: 5,
  },
  priority: "recommended",
};

// ==========================================================================
// BDNB — Base de Données Nationale des Bâtiments
// ==========================================================================

/**
 * Données BDNB d'un bâtiment — vue synthétique.
 *
 * La BDNB agrège 400+ champs par bâtiment. On sélectionne les
 * champs les plus pertinents pour le thème "bâti".
 *
 * Pivot : rnb_id → lookup du batiment_groupe_id BDNB.
 * Route : GET /v1/batiments_groupes?rnb_id=XXXX-XXXX-XXXX
 *
 * ⚠ Le batiment_groupe_id change à chaque vintage BDNB.
 *   On utilise rnb_id comme pivot stable.
 */
export const BATIMENT_BDNB: SourceDef = {
  id: "bati_bdnb",
  label: "Données BDNB",
  description: "Données croisées du bâtiment : matériaux, qualité, risques (BDNB)",
  endpoint: "bdnb",
  path: "/batiments_groupes",
  levels: ["batiment"],
  theme: "bati",
  action: "bdnb",
  pivot: {
    strategy: "attribute",
    attribute: "rnb_id",
    from: "context.code",
  },
  fields: [
    { key: "batiment_groupe_id", label: "ID BDNB", type: "string", primary: false },
    { key: "rnb_id", label: "ID RNB", type: "string", primary: true },
    { key: "s_geom_groupe", label: "Surface au sol", type: "number", unit: "m²", transforms: ["round_2"], primary: true },
    { key: "nb_log", label: "Nombre de logements", type: "number", primary: true },
    { key: "annee_construction", label: "Année de construction", type: "number", primary: true },
    { key: "mat_mur_txt", label: "Matériau murs", type: "string", primary: false },
    { key: "mat_toit_txt", label: "Matériau toiture", type: "string", primary: false },
    { key: "hauteur_mean", label: "Hauteur moyenne", type: "number", unit: "m", transforms: ["round_2"], primary: false },
    { key: "l_nom_voie", label: "Adresse", type: "string", primary: false },
  ],
  priority: "recommended",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const BATI_SOURCES: SourceDef[] = [
  BATI_BDTOPO_COMMUNE,
  BATI_BDTOPO_PARCELLE,
  BATI_RNB_COMMUNE,
  BATI_RNB_PARCELLE,
  BATIMENT_IDENTITE_RNB,
  BATIMENT_IDENTITE_BDTOPO,
  BATIMENT_BDNB,
];
