/**
 * geocontext — Sources Cadastre
 *
 * Couches du Parcellaire Express (PCI Vecteur simplifié) via WFS Géoplateforme.
 * Fournissent les parcelles cadastrales, sections et feuilles.
 *
 * Typenames WFS :
 *   CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle  — parcelles
 *   CADASTRALPARCELS.PARCELLAIRE_EXPRESS:feuille    — feuilles cadastrales
 *
 * Identifiant parcellaire (idpar) :
 *   14 caractères = code_dep (2-3) + code_com (3) + prefix (3) + section (2) + numero (4)
 *   Exemple : 25349000AD0023 = dept 25, commune 349, section AD, parcelle 23
 *
 * @see docs/data-model.md — identifiants pivots
 */

import type { SourceDef, UserFilterDef } from "../types.js";

// ==========================================================================
// Parcelles par commune
// ==========================================================================

const PARCELLE_FILTERS: UserFilterDef[] = [
  {
    key: "section",
    label: "Section cadastrale",
    type: "text",
    toCql: "section LIKE '{value}%'",
  },
  {
    key: "contenance_min",
    label: "Contenance minimale (m²)",
    type: "number_min",
    toCql: "contenance",
  },
];

/**
 * Liste des parcelles cadastrales d'une commune.
 *
 * Filtre par code_dep + code_com (extraits de la hiérarchie).
 * Possibilité de filtrer par section ou contenance minimale.
 *
 * ⚠ Peut retourner beaucoup de résultats (>1000) sur les grandes communes.
 * La pagination est activée.
 */
export const CADASTRE_PARCELLES: SourceDef = {
  id: "cad_parcelles",
  label: "Parcelles cadastrales",
  description: "Liste des parcelles de la commune avec section, numéro et contenance",
  endpoint: "gpf_wfs",
  typename: "CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle",
  levels: ["commune"],
  theme: "cadastre",
  action: "parcelles",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    {
      key: "idu",
      label: "Identifiant parcellaire",
      type: "string",
      primary: true,
    },
    { key: "code_dep", label: "Code département", type: "string", primary: false },
    { key: "code_com", label: "Code commune", type: "string", primary: false },
    { key: "com_abs", label: "Commune absorbée", type: "string", primary: false },
    { key: "section", label: "Section", type: "string", primary: true },
    { key: "numero", label: "Numéro", type: "string", primary: true },
    {
      key: "contenance",
      label: "Contenance",
      type: "number",
      unit: "m²",
      primary: true,
    },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  userFilters: PARCELLE_FILTERS,
  constraints: {
    paginable: true,
  },
  priority: "required",
};

// ==========================================================================
// Sections / feuilles cadastrales
// ==========================================================================

/**
 * Feuilles cadastrales (= sections) d'une commune.
 *
 * Chaque feuille couvre une section cadastrale et permet
 * de naviguer vers les parcelles d'une section spécifique.
 */
export const CADASTRE_FEUILLES: SourceDef = {
  id: "cad_feuilles",
  label: "Sections cadastrales",
  description: "Découpage en sections cadastrales de la commune",
  endpoint: "gpf_wfs",
  typename: "CADASTRALPARCELS.PARCELLAIRE_EXPRESS:feuille",
  levels: ["commune"],
  theme: "cadastre",
  action: "sections",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "code_dep", label: "Code département", type: "string", primary: false },
    { key: "code_com", label: "Code commune", type: "string", primary: false },
    { key: "section", label: "Section", type: "string", primary: true },
    { key: "feuille", label: "Feuille", type: "string", primary: true },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  priority: "recommended",
};

// ==========================================================================
// Détail d'une parcelle (niveau parcelle)
// ==========================================================================

/**
 * Détail d'une parcelle spécifique.
 *
 * Pivot par identifiant parcellaire (idu / idpar 14 chars).
 * Retourne tous les attributs + la géométrie complète.
 *
 * La géométrie est stockée dans le contexte pour les requêtes
 * spatiales suivantes (zonage parcelle, bâtiments sur la parcelle, etc.)
 */
export const PARCELLE_IDENTITE: SourceDef = {
  id: "cad_parcelle_detail",
  label: "Identité parcelle",
  description: "Détail de la parcelle : section, numéro, contenance, géométrie",
  endpoint: "gpf_wfs",
  typename: "CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle",
  levels: ["parcelle"],
  theme: "identite",
  action: null,
  pivot: {
    strategy: "attribute",
    attribute: "idu",
    from: "context.code",
  },
  fields: [
    { key: "idu", label: "Identifiant", type: "string", primary: true },
    { key: "code_dep", label: "Code département", type: "string", primary: false },
    { key: "code_com", label: "Code commune", type: "string", primary: false },
    { key: "com_abs", label: "Commune absorbée", type: "string", primary: false },
    { key: "section", label: "Section", type: "string", primary: true },
    { key: "numero", label: "Numéro", type: "string", primary: true },
    {
      key: "contenance",
      label: "Contenance",
      type: "number",
      unit: "m²",
      primary: true,
    },
    { key: "the_geom", label: "Géométrie", type: "geometry" },
  ],
  priority: "required",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const CADASTRE_SOURCES: SourceDef[] = [
  CADASTRE_PARCELLES,
  CADASTRE_FEUILLES,
  PARCELLE_IDENTITE,
];
