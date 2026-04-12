/**
 * geocontext — Sources Environnement
 *
 * Couches d'espaces protégés et d'inventaires écologiques via WFS Géoplateforme.
 * Toutes sont **spatial-only** : pas d'attribut code_insee, filtre par bbox.
 *
 * Schéma patrinat uniforme :
 *   id_local, nom_site, date_crea, modif_adm, modif_geo,
 *   url_fiche, surf_off, acte_deb, acte_fin, gest_site
 *
 * Colonne géométrie : "geom"
 *
 * @see docs/terrid-spec.md — contrainte spatial-only
 */

import type { SourceDef } from "../types.js";

// ---------------------------------------------------------------------------
// Pivot spatial commun
// ---------------------------------------------------------------------------

const SPATIAL_BBOX = {
  strategy: "spatial" as const,
  spatialOp: "bbox" as const,
  from: "context.bbox" as const,
  geometryColumn: "geom",
};

// ---------------------------------------------------------------------------
// Champs patrinat communs
// ---------------------------------------------------------------------------

const PATRINAT_FIELDS = [
  { key: "nom_site", label: "Nom", type: "string" as const, primary: true },
  { key: "id_local", label: "Identifiant", type: "string" as const, primary: false },
  { key: "date_crea", label: "Date de création", type: "string" as const, primary: false },
  { key: "surf_off", label: "Surface officielle", type: "number" as const, unit: "ha", primary: false },
  { key: "url_fiche", label: "Fiche", type: "string" as const, primary: false },
  { key: "gest_site", label: "Gestionnaire", type: "string" as const, primary: false },
  { key: "geom", label: "Géométrie", type: "geometry" as const },
];

// ==========================================================================
// ZNIEFF
// ==========================================================================

export const ENV_ZNIEFF1: SourceDef = {
  id: "env_znieff1",
  label: "ZNIEFF type I",
  description: "Zones naturelles d'intérêt écologique — habitats remarquables",
  endpoint: "gpf_wfs",
  typename: "patrinat_znieff1:znieff1",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "znieff",
  pivot: SPATIAL_BBOX,
  fields: [...PATRINAT_FIELDS],
  constraints: { spatialOnly: true },
  priority: "recommended",
};

export const ENV_ZNIEFF2: SourceDef = {
  id: "env_znieff2",
  label: "ZNIEFF type II",
  description: "Zones naturelles d'intérêt écologique — grands ensembles naturels",
  endpoint: "gpf_wfs",
  typename: "patrinat_znieff2:znieff2",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "znieff",
  pivot: SPATIAL_BBOX,
  fields: [...PATRINAT_FIELDS],
  constraints: { spatialOnly: true },
  priority: "recommended",
};

// ==========================================================================
// Natura 2000
// ==========================================================================

export const ENV_NATURA2000_SIC: SourceDef = {
  id: "env_natura2000_sic",
  label: "Natura 2000 — Habitats (SIC)",
  description: "Sites d'Importance Communautaire (Directive Habitats)",
  endpoint: "gpf_wfs",
  typename: "patrinat_sic:sic",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "natura2000",
  pivot: SPATIAL_BBOX,
  fields: [...PATRINAT_FIELDS],
  constraints: { spatialOnly: true },
  priority: "recommended",
};

export const ENV_NATURA2000_ZPS: SourceDef = {
  id: "env_natura2000_zps",
  label: "Natura 2000 — Oiseaux (ZPS)",
  description: "Zones de Protection Spéciale (Directive Oiseaux)",
  endpoint: "gpf_wfs",
  typename: "patrinat_zps:zps",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "natura2000",
  pivot: SPATIAL_BBOX,
  fields: [...PATRINAT_FIELDS],
  constraints: { spatialOnly: true },
  priority: "recommended",
};

// ==========================================================================
// Espaces protégés
// ==========================================================================

export const ENV_PNR: SourceDef = {
  id: "env_pnr",
  label: "Parcs Naturels Régionaux",
  description: "Parcs Naturels Régionaux (PNR)",
  endpoint: "gpf_wfs",
  typename: "patrinat_pnr:pnr",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "pnr",
  pivot: SPATIAL_BBOX,
  fields: [...PATRINAT_FIELDS],
  constraints: { spatialOnly: true },
  priority: "recommended",
};

export const ENV_RNN: SourceDef = {
  id: "env_rnn",
  label: "Réserves Naturelles Nationales",
  description: "Réserves Naturelles Nationales (RNN)",
  endpoint: "gpf_wfs",
  typename: "patrinat_rnn:rnn",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "rnn",
  pivot: SPATIAL_BBOX,
  fields: [...PATRINAT_FIELDS],
  constraints: { spatialOnly: true },
  priority: "optional",
};

export const ENV_PN: SourceDef = {
  id: "env_pn",
  label: "Parcs Nationaux",
  description: "Parcs Nationaux (zones cœur)",
  endpoint: "gpf_wfs",
  typename: "patrinat_pn2:pn",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "pn",
  pivot: SPATIAL_BBOX,
  fields: [...PATRINAT_FIELDS],
  constraints: { spatialOnly: true },
  priority: "optional",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const ENVIRONNEMENT_SOURCES: SourceDef[] = [
  ENV_ZNIEFF1,
  ENV_ZNIEFF2,
  ENV_NATURA2000_SIC,
  ENV_NATURA2000_ZPS,
  ENV_PNR,
  ENV_RNN,
  ENV_PN,
];
