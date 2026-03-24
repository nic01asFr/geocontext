/**
 * geocontext — Sources Énergie
 *
 * Données énergétiques du bâtiment : DPE (via BDNB et ADEME),
 * consommation, émissions GES, isolation, chauffage.
 *
 * Stratégie de liaison :
 *   1. BDNB expose les DPE agrégés par bâtiment (source fiable)
 *   2. ADEME expose les DPE unitaires détaillés (via identifiant BAN)
 *   3. ⚠ La liaison DPE → parcelle est non fiable en direct
 *      → Toujours passer par la BDNB qui fait le matching via BAN
 *
 * Ce thème n'existe qu'au niveau bâtiment (THEMES_BY_LEVEL).
 *
 * @see docs/terrid-spec.md — contrainte DPE→parcelle non fiable
 */

import type { SourceDef, UserFilterDef } from "../types.js";

// ==========================================================================
// BDNB — DPE agrégés
// ==========================================================================

/**
 * DPE agrégés par bâtiment via la BDNB.
 *
 * La BDNB croise les données DPE ADEME avec sa base bâtimentaire
 * pour fournir un DPE représentatif par bâtiment.
 *
 * Pivot : rnb_id → lookup batiment_groupe_id BDNB.
 * Route : GET /v1/batiments_groupes?rnb_id=XXXX&select=dpe_*
 */
export const ENERGIE_DPE_BDNB: SourceDef = {
  id: "energie_dpe_bdnb",
  label: "DPE (via BDNB)",
  description: "Diagnostic de Performance Énergétique agrégé du bâtiment",
  endpoint: "bdnb",
  path: "/batiments_groupes",
  levels: ["batiment"],
  theme: "energie",
  action: "dpe",
  pivot: {
    strategy: "attribute",
    attribute: "rnb_id",
    from: "context.code",
  },
  fields: [
    {
      key: "dpe_logtype_etiquette_dpe",
      label: "Étiquette DPE",
      type: "enum",
      enumValues: {
        A: "A — Très performant",
        B: "B — Performant",
        C: "C — Assez performant",
        D: "D — Moyen",
        E: "E — Peu performant",
        F: "F — Très peu performant",
        G: "G — Extrêmement peu performant",
      },
      primary: true,
    },
    {
      key: "dpe_logtype_etiquette_ges",
      label: "Étiquette GES",
      type: "enum",
      enumValues: {
        A: "A — Émissions faibles",
        B: "B",
        C: "C",
        D: "D",
        E: "E",
        F: "F",
        G: "G — Émissions très élevées",
      },
      primary: true,
    },
    {
      key: "dpe_logtype_conso_chauffage",
      label: "Consommation chauffage",
      type: "number",
      unit: "kWh/m²/an",
      transforms: ["round_2"],
      primary: true,
    },
    {
      key: "dpe_logtype_conso_ecs",
      label: "Consommation eau chaude",
      type: "number",
      unit: "kWh/m²/an",
      transforms: ["round_2"],
      primary: false,
    },
    {
      key: "dpe_logtype_conso_5_usages",
      label: "Consommation 5 usages",
      type: "number",
      unit: "kWh/m²/an",
      transforms: ["round_2"],
      primary: true,
    },
    {
      key: "dpe_logtype_emission_ges",
      label: "Émissions GES",
      type: "number",
      unit: "kgCO₂/m²/an",
      transforms: ["round_2"],
      primary: true,
    },
    {
      key: "dpe_logtype_type_chauffage",
      label: "Type de chauffage",
      type: "string",
      primary: false,
    },
    {
      key: "dpe_logtype_type_isolation_mur",
      label: "Isolation murs",
      type: "string",
      primary: false,
    },
    {
      key: "dpe_logtype_type_isolation_toiture",
      label: "Isolation toiture",
      type: "string",
      primary: false,
    },
    {
      key: "dpe_logtype_type_isolation_plancher_bas",
      label: "Isolation plancher",
      type: "string",
      primary: false,
    },
    {
      key: "dpe_logtype_type_vitrage",
      label: "Type de vitrage",
      type: "string",
      primary: false,
    },
    {
      key: "dpe_logtype_annee_construction",
      label: "Année construction (DPE)",
      type: "number",
      primary: false,
    },
  ],
  priority: "required",
};

// ==========================================================================
// ADEME — DPE détaillés
// ==========================================================================

const DPE_FILTERS: UserFilterDef[] = [
  {
    key: "etiquette_dpe",
    label: "Étiquette DPE",
    type: "enum",
    values: {
      A: "A",
      B: "B",
      C: "C",
      D: "D",
      E: "E",
      F: "F",
      G: "G",
    },
    toParam: "etiquette_dpe",
  },
];

/**
 * DPE détaillés ADEME (logements existants).
 *
 * Données DPE unitaires avec tous les champs techniques détaillés.
 * Utilisé pour une analyse approfondie après le résumé BDNB.
 *
 * ⚠ Liaison par identifiant BAN (adresse normalisée).
 *   L'identifiant BAN est obtenu via la BDNB, pas directement.
 *
 * Authentification : clé API ADEME (env ADEME_API_KEY).
 */
export const ENERGIE_DPE_ADEME: SourceDef = {
  id: "energie_dpe_ademe",
  label: "DPE détaillés (ADEME)",
  description: "Diagnostics de Performance Énergétique détaillés (tous champs techniques)",
  endpoint: "ademe_dpe",
  path: "/lines",
  levels: ["batiment"],
  theme: "energie",
  action: "dpe_detail",
  pivot: {
    strategy: "attribute",
    attribute: "identifiant_ban",
    from: "context.code",
  },
  fields: [
    { key: "numero_dpe", label: "N° DPE", type: "string", primary: true },
    {
      key: "date_etablissement_dpe",
      label: "Date du DPE",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: true,
    },
    { key: "etiquette_dpe", label: "Étiquette DPE", type: "string", primary: true },
    { key: "etiquette_ges", label: "Étiquette GES", type: "string", primary: true },
    { key: "surface_habitable", label: "Surface habitable", type: "number", unit: "m²", primary: true },
    { key: "type_batiment", label: "Type de bâtiment", type: "string", primary: false },
    { key: "annee_construction", label: "Année construction", type: "number", primary: false },
    { key: "type_energie_chauffage", label: "Énergie chauffage", type: "string", primary: false },
    { key: "type_energie_ecs", label: "Énergie ECS", type: "string", primary: false },
    { key: "conso_chauffage", label: "Conso. chauffage", type: "number", unit: "kWh/m²/an", transforms: ["round_2"], primary: false },
    { key: "conso_ecs", label: "Conso. ECS", type: "number", unit: "kWh/m²/an", transforms: ["round_2"], primary: false },
  ],
  userFilters: DPE_FILTERS,
  constraints: {
    dateField: "date_etablissement_dpe",
  },
  defaultSort: { field: "date_etablissement_dpe", order: "desc" },
  priority: "optional",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const ENERGIE_SOURCES: SourceDef[] = [
  ENERGIE_DPE_BDNB,
  ENERGIE_DPE_ADEME,
];
