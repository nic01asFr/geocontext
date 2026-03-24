/**
 * geocontext — Sources Environnement
 *
 * Couches d'espaces protégés et d'inventaires écologiques via WFS Géoplateforme.
 * Toutes sont **spatial-only** : pas d'attribut code_insee, filtre par bbox ou
 * INTERSECTS sur la géométrie du territoire.
 *
 * ⚠ L'executor doit s'assurer que context.bbox ou context.geometry est rempli
 *   avant d'appeler ces sources (résolu au navigate via ADMINEXPRESS).
 *
 * Typenames WFS (Géoplateforme) :
 *   PROTECTEDAREAS.ZNIEFF1:znieff1     — ZNIEFF type I (habitats remarquables)
 *   PROTECTEDAREAS.ZNIEFF2:znieff2     — ZNIEFF type II (grands ensembles)
 *   PROTECTEDAREAS.SIC:sic              — Sites d'Importance Communautaire (Natura 2000)
 *   PROTECTEDAREAS.ZPS:zps              — Zones de Protection Spéciale (Natura 2000)
 *   PROTECTEDAREAS.PNR:pnr              — Parcs Naturels Régionaux
 *   PROTECTEDAREAS.RNN:rnn              — Réserves Naturelles Nationales
 *   PROTECTEDAREAS.PN:pn                — Parcs Nationaux
 *
 * @see docs/terrid-spec.md — contrainte spatial-only
 */

import type { SourceDef } from "../types.js";

// ---------------------------------------------------------------------------
// Pivot spatial commun — BBOX sur la géométrie du territoire
// ---------------------------------------------------------------------------

const SPATIAL_BBOX = {
  strategy: "spatial" as const,
  spatialOp: "bbox" as const,
  from: "context.bbox" as const,
};

const SPATIAL_INTERSECTS = {
  strategy: "spatial" as const,
  spatialOp: "intersects" as const,
  from: "context.geometry" as const,
};

// ==========================================================================
// ZNIEFF — Zones Naturelles d'Intérêt Écologique, Faunistique et Floristique
// ==========================================================================

/**
 * ZNIEFF de type I — secteurs de petite taille, habitats remarquables.
 *
 * Identifient des secteurs de grand intérêt biologique ou écologique.
 * Pas de portée réglementaire directe mais prises en compte dans
 * les documents d'urbanisme.
 */
export const ENV_ZNIEFF1: SourceDef = {
  id: "env_znieff1",
  label: "ZNIEFF type I",
  description: "Zones naturelles d'intérêt écologique — habitats remarquables",
  endpoint: "gpf_wfs",
  typename: "PROTECTEDAREAS.ZNIEFF1:znieff1",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "znieff",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "id_mnhn", label: "Identifiant MNHN", type: "string", primary: false },
    { key: "nom", label: "Nom", type: "string", primary: true },
    { key: "date_creation", label: "Date de création", type: "date", transforms: ["parse_date_iso", "format_date_fr"], primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

/**
 * ZNIEFF de type II — grands ensembles naturels riches.
 *
 * Espaces plus vastes intégrant des ZNIEFF I, correspondant à de
 * grands ensembles écologiques cohérents.
 */
export const ENV_ZNIEFF2: SourceDef = {
  id: "env_znieff2",
  label: "ZNIEFF type II",
  description: "Zones naturelles d'intérêt écologique — grands ensembles naturels",
  endpoint: "gpf_wfs",
  typename: "PROTECTEDAREAS.ZNIEFF2:znieff2",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "znieff",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "id_mnhn", label: "Identifiant MNHN", type: "string", primary: false },
    { key: "nom", label: "Nom", type: "string", primary: true },
    { key: "date_creation", label: "Date de création", type: "date", transforms: ["parse_date_iso", "format_date_fr"], primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

// ==========================================================================
// Natura 2000
// ==========================================================================

/**
 * Sites d'Importance Communautaire (SIC) — Directive Habitats.
 *
 * Réseau Natura 2000 : sites désignés pour la conservation
 * d'habitats naturels et d'espèces animales/végétales.
 */
export const ENV_NATURA2000_SIC: SourceDef = {
  id: "env_natura2000_sic",
  label: "Natura 2000 — Habitats (SIC)",
  description: "Sites d'Importance Communautaire (Directive Habitats)",
  endpoint: "gpf_wfs",
  typename: "PROTECTEDAREAS.SIC:sic",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "natura2000",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "sitecode", label: "Code du site", type: "string", primary: true },
    { key: "sitename", label: "Nom du site", type: "string", primary: true },
    {
      key: "superficie",
      label: "Superficie",
      type: "number",
      unit: "ha",
      primary: false,
    },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

/**
 * Zones de Protection Spéciale (ZPS) — Directive Oiseaux.
 *
 * Sites désignés pour la conservation des oiseaux sauvages.
 */
export const ENV_NATURA2000_ZPS: SourceDef = {
  id: "env_natura2000_zps",
  label: "Natura 2000 — Oiseaux (ZPS)",
  description: "Zones de Protection Spéciale (Directive Oiseaux)",
  endpoint: "gpf_wfs",
  typename: "PROTECTEDAREAS.ZPS:zps",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "natura2000",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "sitecode", label: "Code du site", type: "string", primary: true },
    { key: "sitename", label: "Nom du site", type: "string", primary: true },
    {
      key: "superficie",
      label: "Superficie",
      type: "number",
      unit: "ha",
      primary: false,
    },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

// ==========================================================================
// Espaces protégés
// ==========================================================================

/**
 * Parcs Naturels Régionaux (PNR).
 */
export const ENV_PNR: SourceDef = {
  id: "env_pnr",
  label: "Parcs Naturels Régionaux",
  description: "Parcs Naturels Régionaux (PNR)",
  endpoint: "gpf_wfs",
  typename: "PROTECTEDAREAS.PNR:pnr",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "pnr",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "nom", label: "Nom", type: "string", primary: true },
    {
      key: "date_crea",
      label: "Date de création",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: true,
    },
    { key: "url", label: "Site web", type: "string", primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

/**
 * Réserves Naturelles Nationales (RNN).
 */
export const ENV_RNN: SourceDef = {
  id: "env_rnn",
  label: "Réserves Naturelles Nationales",
  description: "Réserves Naturelles Nationales (RNN)",
  endpoint: "gpf_wfs",
  typename: "PROTECTEDAREAS.RNN:rnn",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "rnn",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "nom", label: "Nom", type: "string", primary: true },
    { key: "date_creation", label: "Date de création", type: "date", transforms: ["parse_date_iso", "format_date_fr"], primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "optional",
};

/**
 * Parcs Nationaux — zones cœur.
 */
export const ENV_PN: SourceDef = {
  id: "env_pn",
  label: "Parcs Nationaux",
  description: "Parcs Nationaux (zones cœur)",
  endpoint: "gpf_wfs",
  typename: "PROTECTEDAREAS.PN:pn",
  levels: ["commune", "departement", "epci", "region"],
  theme: "environnement",
  action: "pn",
  pivot: SPATIAL_BBOX,
  fields: [
    { key: "nom", label: "Nom", type: "string", primary: true },
    { key: "date_crea", label: "Date de création", type: "date", transforms: ["parse_date_iso", "format_date_fr"], primary: false },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  constraints: {
    spatialOnly: true,
  },
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
