/**
 * geocontext — Sources ADMINEXPRESS (thème identité)
 *
 * Couches ADMINEXPRESS-COG du WFS Géoplateforme.
 * Fournissent l'identité administrative de chaque niveau territorial :
 * commune, EPCI, département, région.
 *
 * Rôle central : la couche commune contient les FK vers tous les niveaux
 * supérieurs, permettant de résoudre toute la hiérarchie en 1 requête.
 *
 * Typename WFS :
 *   ADMINEXPRESS-COG.LATEST:region
 *   ADMINEXPRESS-COG.LATEST:departement
 *   ADMINEXPRESS-COG.LATEST:epci
 *   ADMINEXPRESS-COG.LATEST:commune
 *
 * @see docs/data-model.md — remontée hiérarchique en 1 requête
 */

import type { SourceDef } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers — préfixe commun des typenames
// ---------------------------------------------------------------------------

const AE = "ADMINEXPRESS-COG.LATEST";

// ==========================================================================
// Commune — le niveau pivot
// ==========================================================================

/**
 * Identité d'une commune.
 *
 * Requête : ADMINEXPRESS-COG.LATEST:commune filtré par code_insee.
 *
 * Champs retournés — incluent les FK ascendants pour résolution hiérarchie :
 *   code_insee, nom, population, superficie,
 *   siren_epci, code_insee_du_departement, code_insee_de_la_region,
 *   code_insee_du_canton, code_insee_de_l_arrondissement
 *
 * C'est la requête la plus importante du système : elle est exécutée
 * à chaque navigate() vers une commune et alimente tout le contexte.
 */
export const COMMUNE_IDENTITE: SourceDef = {
  id: "ae_commune",
  label: "Identité commune",
  description: "Informations administratives, population et superficie de la commune",
  endpoint: "gpf_wfs",
  typename: `${AE}:commune`,
  levels: ["commune"],
  theme: "identite",
  action: null,
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "code_insee", label: "Code INSEE", type: "string", primary: true },
    { key: "nom", label: "Nom", type: "string", primary: true },
    { key: "population", label: "Population", type: "number", unit: "hab", primary: true },
    {
      key: "superficie",
      label: "Superficie",
      type: "number",
      unit: "ha",
      transforms: ["m2_to_ha"],
      primary: true,
    },
    { key: "statut", label: "Statut", type: "string", primary: false },
    {
      key: "siren_epci",
      label: "SIREN EPCI",
      type: "string",
      primary: false,
    },
    {
      key: "code_insee_du_departement",
      label: "Code département",
      type: "string",
      primary: false,
    },
    {
      key: "code_insee_de_la_region",
      label: "Code région",
      type: "string",
      primary: false,
    },
    {
      key: "code_insee_du_canton",
      label: "Code canton",
      type: "string",
      primary: false,
    },
    {
      key: "code_insee_de_l_arrondissement",
      label: "Code arrondissement",
      type: "string",
      primary: false,
    },
  ],
  priority: "required",
};

// ==========================================================================
// EPCI
// ==========================================================================

/**
 * Identité d'un EPCI (Établissement Public de Coopération Intercommunale).
 *
 * ⚠ L'EPCI est identifié par son code SIREN, pas par un code INSEE.
 * Le filtre utilise hierarchy.epci.siren (résolu via commune.siren_epci).
 */
export const EPCI_IDENTITE: SourceDef = {
  id: "ae_epci",
  label: "Identité EPCI",
  description: "Informations de l'intercommunalité (nom, nature juridique, nombre de communes)",
  endpoint: "gpf_wfs",
  typename: `${AE}:epci`,
  levels: ["epci"],
  theme: "identite",
  action: null,
  pivot: {
    strategy: "attribute",
    attribute: "code_siren",
    from: "context.code",
  },
  fields: [
    { key: "code_siren", label: "Code SIREN", type: "string", primary: true },
    { key: "nom", label: "Nom", type: "string", primary: true },
    { key: "nature_juridique", label: "Nature juridique", type: "string", primary: true },
    { key: "nombre_de_communes", label: "Communes membres", type: "number", primary: true },
  ],
  priority: "required",
};

// ==========================================================================
// Département
// ==========================================================================

/**
 * Identité d'un département.
 */
export const DEPARTEMENT_IDENTITE: SourceDef = {
  id: "ae_departement",
  label: "Identité département",
  description: "Informations administratives du département",
  endpoint: "gpf_wfs",
  typename: `${AE}:departement`,
  levels: ["departement"],
  theme: "identite",
  action: null,
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "code_insee", label: "Code INSEE", type: "string", primary: true },
    { key: "nom", label: "Nom", type: "string", primary: true },
    { key: "chf_lieu", label: "Chef-lieu", type: "string", primary: false },
  ],
  priority: "required",
};

// ==========================================================================
// Région
// ==========================================================================

/**
 * Identité d'une région.
 */
export const REGION_IDENTITE: SourceDef = {
  id: "ae_region",
  label: "Identité région",
  description: "Informations administratives de la région",
  endpoint: "gpf_wfs",
  typename: `${AE}:region`,
  levels: ["region"],
  theme: "identite",
  action: null,
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "code_insee", label: "Code INSEE", type: "string", primary: true },
    { key: "nom", label: "Nom", type: "string", primary: true },
  ],
  priority: "required",
};

// ==========================================================================
// IRIS — découpage infra-communal
// ==========================================================================

/**
 * IRIS (Ilots Regroupés pour l'Information Statistique).
 *
 * Découpage infra-communal de l'INSEE. Chaque commune de plus de
 * 5000 habitants est découpée en IRIS (~2000 hab chacun).
 * Source pour les statistiques fines (revenus, emploi, logement).
 */
export const COMMUNE_IRIS: SourceDef = {
  id: "ae_iris",
  label: "IRIS",
  description: "Découpage infra-communal INSEE (quartiers statistiques)",
  endpoint: "gpf_wfs",
  typename: "CONTOURS-IRIS.LATEST:iris_ge",
  levels: ["commune"],
  theme: "identite",
  action: "iris",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "code_iris", label: "Code IRIS", type: "string", primary: true },
    { key: "nom_iris", label: "Nom", type: "string", primary: true },
    {
      key: "typ_iris",
      label: "Type",
      type: "enum",
      enumValues: {
        H: "Habitat",
        A: "Activité",
        D: "Divers",
        Z: "Non découpé",
      },
      primary: true,
    },
  ],
  priority: "recommended",
};

// ==========================================================================
// Export groupé
// ==========================================================================

/**
 * Toutes les sources ADMINEXPRESS.
 */
export const ADMINEXPRESS_SOURCES: SourceDef[] = [
  REGION_IDENTITE,
  DEPARTEMENT_IDENTITE,
  EPCI_IDENTITE,
  COMMUNE_IDENTITE,
  COMMUNE_IRIS,
];
