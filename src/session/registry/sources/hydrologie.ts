/**
 * geocontext — Sources Hydrologie
 *
 * Données hydrologiques : cours d'eau et plans d'eau via BDTOPO WFS,
 * qualité de l'eau via Hub'Eau, masses d'eau DCE via Sandre.
 *
 * Sources BDTOPO = spatial-only (filtre bbox).
 * Hub'Eau = REST filtrable par code_commune.
 * Sandre = WFS en EPSG:2154 ⚠ (reprojection nécessaire).
 *
 * Typenames WFS Géoplateforme :
 *   BDTOPO_V3:cours_d_eau     — cours d'eau (rivières, ruisseaux)
 *   BDTOPO_V3:plan_d_eau      — plans d'eau (lacs, étangs, réservoirs)
 *
 * @see docs/terrid-spec.md — endpoints 11 (Sandre), 12 (Hub'Eau)
 */

import type { SourceDef } from "../types.js";

// ---------------------------------------------------------------------------
// Pivot spatial commun
// ---------------------------------------------------------------------------

const SPATIAL_BBOX = {
  strategy: "spatial" as const,
  spatialOp: "bbox" as const,
  from: "context.bbox" as const,
};

// ==========================================================================
// Cours d'eau (BDTOPO)
// ==========================================================================

/**
 * Cours d'eau BDTOPO — rivières, ruisseaux, canaux.
 */
export const HYDRO_COURS_EAU: SourceDef = {
  id: "hydro_cours_eau",
  label: "Cours d'eau",
  description: "Rivières, ruisseaux et canaux (BDTOPO)",
  endpoint: "gpf_wfs",
  typename: "BDTOPO_V3:cours_d_eau",
  levels: ["commune", "departement", "epci"],
  theme: "hydrologie",
  action: "cours_eau",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "toponyme", label: "Nom", type: "string", primary: true },
    {
      key: "classe",
      label: "Classe",
      type: "string",
      primary: true,
    },
    { key: "regime", label: "Régime", type: "string", primary: false },
    { key: "statut", label: "Statut", type: "string", primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
    paginable: true,
  },
  priority: "recommended",
};

// ==========================================================================
// Plans d'eau (BDTOPO)
// ==========================================================================

/**
 * Plans d'eau BDTOPO — lacs, étangs, réservoirs, mares.
 */
export const HYDRO_PLANS_EAU: SourceDef = {
  id: "hydro_plans_eau",
  label: "Plans d'eau",
  description: "Lacs, étangs, réservoirs et mares (BDTOPO)",
  endpoint: "gpf_wfs",
  typename: "BDTOPO_V3:plan_d_eau",
  levels: ["commune", "departement", "epci"],
  theme: "hydrologie",
  action: "plans_eau",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "toponyme", label: "Nom", type: "string", primary: true },
    {
      key: "nature",
      label: "Nature",
      type: "enum",
      enumValues: {
        "Lac": "Lac",
        "Retenue": "Retenue",
        "Réservoir": "Réservoir",
        "Étang": "Étang",
        "Gravière": "Gravière",
        "Mare": "Mare",
        "Bassin": "Bassin",
      },
      primary: true,
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
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

// ==========================================================================
// Hub'Eau — qualité des cours d'eau
// ==========================================================================

/**
 * Stations de mesure qualité des cours d'eau (Hub'Eau).
 *
 * Route : GET /v1/qualite_cours_eau/station?code_commune=XXXXX
 */
export const HYDRO_QUALITE_STATIONS: SourceDef = {
  id: "hubeau_qualite_stations",
  label: "Stations qualité eau",
  description: "Stations de mesure de la qualité des cours d'eau (Hub'Eau)",
  endpoint: "hubeau",
  path: "/v1/qualite_cours_eau/station",
  levels: ["commune"],
  theme: "hydrologie",
  action: "qualite",
  pivot: {
    strategy: "attribute",
    attribute: "code_commune",
    from: "context.code",
  },
  fields: [
    { key: "code_station", label: "Code station", type: "string", primary: true },
    { key: "libelle_station", label: "Nom", type: "string", primary: true },
    { key: "libelle_cours_eau", label: "Cours d'eau", type: "string", primary: true },
    { key: "longitude", label: "Longitude", type: "number", primary: false },
    { key: "latitude", label: "Latitude", type: "number", primary: false },
  ],
  priority: "optional",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const HYDROLOGIE_SOURCES: SourceDef[] = [
  HYDRO_COURS_EAU,
  HYDRO_PLANS_EAU,
  HYDRO_QUALITE_STATIONS,
];
