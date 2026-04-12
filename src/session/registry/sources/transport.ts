/**
 * geocontext — Sources Transport
 *
 * Couches BDTOPO V3 du WFS Géoplateforme pour les infrastructures de transport :
 * routes, voies ferrées, pistes cyclables, points d'activité/intérêt.
 *
 * Toutes sont **spatial-only** (filtre bbox sur le territoire).
 *
 * Typenames WFS :
 *   BDTOPO_V3:troncon_de_route         — réseau routier
 *   BDTOPO_V3:troncon_de_voie_ferree   — réseau ferroviaire
 *
 * @see docs/terrid-spec.md — endpoint 1 (data.geopf.fr/wfs)
 */

import type { SourceDef, UserFilterDef } from "../types.js";

// ---------------------------------------------------------------------------
// Pivot spatial commun
// ---------------------------------------------------------------------------

const SPATIAL_BBOX = {
  strategy: "spatial" as const,
  spatialOp: "bbox" as const,
  from: "context.bbox" as const,
  geometryColumn: "geometrie",
};

// ==========================================================================
// Routes
// ==========================================================================

const ROUTE_FILTERS: UserFilterDef[] = [
  {
    key: "importance",
    label: "Importance de la voie",
    type: "enum",
    values: {
      "1": "Autoroute / liaison nationale",
      "2": "Liaison régionale",
      "3": "Liaison locale",
      "4": "Voie secondaire",
      "5": "Voie locale / chemin",
    },
    toCql: "importance = '{value}'",
  },
  {
    key: "nature",
    label: "Nature de la voie",
    type: "enum",
    values: {
      "Autoroute": "Autoroute",
      "Route à 2 chaussées": "Route à 2 chaussées",
      "Route à 1 chaussée": "Route à 1 chaussée",
      "Bretelle": "Bretelle",
      "Rond-point": "Rond-point",
      "Chemin": "Chemin",
      "Piste cyclable": "Piste cyclable",
      "Sentier": "Sentier",
      "Escalier": "Escalier",
    },
    toCql: "nature = '{value}'",
  },
];

/**
 * Réseau routier (tronçons de route BDTOPO).
 *
 * Filtre spatial bbox. Peut être volumineux sur les grandes communes
 * (>1000 tronçons) → pagination activée.
 */
export const TRANSPORT_ROUTES: SourceDef = {
  id: "transport_routes",
  label: "Réseau routier",
  description: "Tronçons de route BDTOPO (autoroutes, routes, chemins, pistes cyclables)",
  endpoint: "gpf_wfs",
  typename: "BDTOPO_V3:troncon_de_route",
  levels: ["commune", "departement", "epci"],
  theme: "transport",
  action: "routes",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "nature", label: "Nature", type: "string", primary: true },
    { key: "importance", label: "Importance", type: "string", primary: true },
    { key: "nombre_de_voies", label: "Nombre de voies", type: "number", primary: false },
    { key: "largeur_de_chaussee", label: "Largeur chaussée", type: "number", unit: "m", primary: false },
    { key: "nom_collaboratif_gauche", label: "Nom voie", type: "string", primary: false },
    { key: "geometrie", label: "Géométrie", type: "geometry" },
  ],
  userFilters: ROUTE_FILTERS,
  constraints: {
    spatialOnly: true,
    paginable: true,
    maxFeaturesOverride: 500,
  },
  priority: "recommended",
};

// ==========================================================================
// Voies ferrées
// ==========================================================================

/**
 * Réseau ferroviaire (tronçons de voie ferrée BDTOPO).
 */
export const TRANSPORT_FERROVIAIRE: SourceDef = {
  id: "transport_ferroviaire",
  label: "Réseau ferroviaire",
  description: "Voies ferrées BDTOPO (LGV, classique, fret, touristique)",
  endpoint: "gpf_wfs",
  typename: "BDTOPO_V3:troncon_de_voie_ferree",
  levels: ["commune", "departement", "epci"],
  theme: "transport",
  action: "ferroviaire",
  pivot: SPATIAL_BBOX,
  fields: [
    {
      key: "nature",
      label: "Nature",
      type: "enum",
      enumValues: {
        "LGV": "Ligne à Grande Vitesse",
        "Voie ferrée principale": "Voie ferrée principale",
        "Voie ferrée non exploitée": "Non exploitée",
        "Voie de service": "Voie de service",
        "Transport urbain": "Transport urbain",
        "Funiculaire ou crémaillère": "Funiculaire",
      },
      primary: true,
    },
    { key: "position_par_rapport_au_sol", label: "Position", type: "string", primary: false },
    { key: "etat_de_l_objet", label: "État", type: "string", primary: false },
    { key: "geometrie", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const TRANSPORT_SOURCES: SourceDef[] = [
  TRANSPORT_ROUTES,
  TRANSPORT_FERROVIAIRE,
];
