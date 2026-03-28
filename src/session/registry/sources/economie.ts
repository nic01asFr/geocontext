/**
 * geocontext — Sources Économie
 *
 * Données économiques : entreprises et établissements via l'API INSEE SIRENE.
 *
 * L'API SIRENE donne accès au répertoire national des entreprises et de
 * leurs établissements. Filtrage par commune (communeEtablissement),
 * code NAF (activitePrincipaleEtablissement), tranche d'effectifs.
 *
 * Authentification : clé API INSEE (env INSEE_API_KEY).
 *
 * @see docs/terrid-spec.md — endpoint 10 (api.insee.fr/sirene)
 */

import type { SourceDef, UserFilterDef } from "../types.js";

// ==========================================================================
// Filtres SIRENE
// ==========================================================================

const SIRENE_FILTERS: UserFilterDef[] = [
  {
    key: "naf",
    label: "Code NAF (activité)",
    type: "text",
    toParam: "activitePrincipaleEtablissement",
  },
  {
    key: "tranche_effectifs",
    label: "Tranche d'effectifs",
    type: "enum",
    values: {
      "00": "0 salarié",
      "01": "1 ou 2 salariés",
      "02": "3 à 5 salariés",
      "03": "6 à 9 salariés",
      "11": "10 à 19 salariés",
      "12": "20 à 49 salariés",
      "21": "50 à 99 salariés",
      "22": "100 à 199 salariés",
      "31": "200 à 249 salariés",
      "32": "250 à 499 salariés",
      "41": "500 à 999 salariés",
      "42": "1 000 à 1 999 salariés",
      "51": "2 000 à 4 999 salariés",
      "52": "5 000 à 9 999 salariés",
      "53": "10 000 et plus",
    },
    toParam: "trancheEffectifsEtablissement",
  },
  {
    key: "etat",
    label: "État de l'établissement",
    type: "enum",
    values: {
      A: "Actif",
      F: "Fermé",
    },
    defaultValue: "A",
    toParam: "etatAdministratifEtablissement",
  },
];

// ==========================================================================
// Établissements SIRENE par commune
// ==========================================================================

/**
 * Établissements SIRENE sur la commune.
 *
 * Retourne les établissements (pas les entreprises/sièges) localisés
 * sur la commune. Filtrable par code NAF, tranche d'effectifs, état.
 *
 * Route : GET /siret?q=communeEtablissement:XXXXX
 *
 * ⚠ Le résultat peut être très volumineux sur les grandes communes.
 *   Pagination activée. Filtre "Actif" par défaut.
 */
export const ECONOMIE_SIRENE: SourceDef = {
  id: "eco_sirene",
  label: "Entreprises (SIRENE)",
  description: "Établissements actifs sur la commune (INSEE SIRENE)",
  endpoint: "insee_sirene",
  path: "/siret",
  levels: ["commune", "departement", "epci", "region"],
  theme: "economie",
  action: "entreprises",
  pivot: {
    strategy: "attribute",
    attribute: "communeEtablissement",
    from: "context.code",
  },
  fields: [
    { key: "siret", label: "SIRET", type: "string", primary: false },
    { key: "siren", label: "SIREN", type: "string", primary: false },
    {
      key: "denominationUniteLegale",
      label: "Nom",
      type: "string",
      transforms: ["trim"],
      primary: true,
    },
    {
      key: "activitePrincipaleEtablissement",
      label: "Code NAF",
      type: "string",
      primary: true,
    },
    {
      key: "trancheEffectifsEtablissement",
      label: "Effectifs",
      type: "enum",
      enumValues: {
        "00": "0 salarié",
        "01": "1-2",
        "02": "3-5",
        "03": "6-9",
        "11": "10-19",
        "12": "20-49",
        "21": "50-99",
        "22": "100-199",
        "31": "200-249",
        "32": "250-499",
        "41": "500-999",
        "42": "1 000-1 999",
        "51": "2 000-4 999",
        "52": "5 000-9 999",
        "53": "10 000+",
      },
      primary: true,
    },
    {
      key: "etatAdministratifEtablissement",
      label: "État",
      type: "enum",
      enumValues: {
        A: "Actif",
        F: "Fermé",
      },
      primary: false,
    },
    {
      key: "dateCreationEtablissement",
      label: "Date de création",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: false,
    },
    {
      key: "adresseEtablissement",
      label: "Adresse",
      type: "string",
      primary: false,
    },
  ],
  userFilters: SIRENE_FILTERS,
  constraints: {
    paginable: true,
  },
  priority: "recommended",
};

// ==========================================================================
// DVF — transactions immobilières (aussi lié à l'économie locale)
// ==========================================================================

const DVF_FILTERS: UserFilterDef[] = [
  {
    key: "period",
    label: "Période",
    type: "date_range",
    toParam: "datemut",
  },
  {
    key: "codtypbien",
    label: "Type de bien",
    type: "enum",
    values: {
      "1": "Maison",
      "2": "Appartement",
      "4": "Local commercial/industriel",
    },
    toParam: "codtypbien",
  },
  {
    key: "valeur_min",
    label: "Valeur minimale (€)",
    type: "number_min",
    toParam: "valeurfonc",
  },
];

/**
 * Transactions DVF de la commune.
 *
 * Demandes de Valeurs Foncières : historique des ventes immobilières.
 * Tri chronologique descendant.
 *
 * Route : GET /dvf_opendata/mutations/?code_insee=XXXXX
 */
export const ECONOMIE_DVF_COMMUNE: SourceDef = {
  id: "eco_dvf_commune",
  label: "Transactions immobilières (DVF)",
  description: "Historique des ventes immobilières sur la commune",
  endpoint: "dvf",
  path: "/mutations/",
  levels: ["commune"],
  theme: "economie",
  action: "transactions",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    {
      key: "datemut",
      label: "Date de vente",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: true,
    },
    {
      key: "valeurfonc",
      label: "Prix",
      type: "number",
      unit: "€",
      transforms: ["round_2"],
      primary: true,
    },
    { key: "libtypbien", label: "Type de bien", type: "string", primary: true },
    { key: "sbati", label: "Surface bâtie", type: "number", unit: "m²", primary: true },
    { key: "sterr", label: "Surface terrain", type: "number", unit: "m²", primary: false },
    { key: "coddep", label: "Département", type: "string", primary: false },
    { key: "l_idpar", label: "Parcelles", type: "string", primary: false },
  ],
  userFilters: DVF_FILTERS,
  constraints: {
    dateField: "date_mutation",
    paginable: true,
  },
  defaultSort: { field: "date_mutation", order: "desc" },
  priority: "recommended",
};

/**
 * Transactions DVF d'une parcelle.
 *
 * Route : GET /dvf_opendata/mutations/?idpar=XXXXXXXXXXXXXX
 */
export const ECONOMIE_DVF_PARCELLE: SourceDef = {
  id: "eco_dvf_parcelle",
  label: "Transactions de la parcelle",
  description: "Historique des ventes sur cette parcelle",
  endpoint: "dvf",
  path: "/mutations/",
  levels: ["parcelle"],
  theme: "cadastre",
  action: "transactions",
  pivot: {
    strategy: "attribute",
    attribute: "idpar",
    from: "context.code",
  },
  fields: ECONOMIE_DVF_COMMUNE.fields,
  userFilters: [DVF_FILTERS[0]], // filtre période uniquement
  constraints: {
    dateField: "date_mutation",
  },
  defaultSort: { field: "date_mutation", order: "desc" },
  priority: "recommended",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const ECONOMIE_SOURCES: SourceDef[] = [
  ECONOMIE_SIRENE,
  ECONOMIE_DVF_COMMUNE,
  ECONOMIE_DVF_PARCELLE,
];
