/**
 * geocontext — Sources Risques
 *
 * Données Georisques : WFS (couches géographiques PPR) et REST
 * (données tabulaires radon, CatNat, cavités, argiles, ICPE).
 *
 * Deux endpoints distincts :
 *   - georisques_wfs  → PPR, sites pollués (WFS, EPSG:2154 ⚠)
 *   - georisques_rest → radon, CatNat, cavités, argiles, ICPE (REST JSON)
 *
 * La plupart des données REST sont filtrées par code_insee.
 * Les couches WFS sont filtrées spatialement (bbox du territoire).
 * Le radon est un classement communal (classe 1/2/3).
 * L'argile est un classement ponctuel (lon,lat).
 *
 * @see docs/terrid-spec.md — endpoints 5 et 6
 */

import type { SourceDef, UserFilterDef } from "../types.js";

// ==========================================================================
// Georisques REST — Radon
// ==========================================================================

/**
 * Potentiel radon de la commune.
 *
 * 3 classes : 1 (faible), 2 (moyen), 3 (élevé).
 * Un seul résultat par commune.
 *
 * Route : GET /radon?code_insee=XXXXX
 */
export const RISQUES_RADON: SourceDef = {
  id: "georisques_radon",
  label: "Potentiel radon",
  description: "Classe de potentiel radon de la commune (1=faible, 2=moyen, 3=élevé)",
  endpoint: "georisques_rest",
  path: "/radon",
  levels: ["commune", "parcelle", "batiment"],
  theme: "risques",
  action: "radon",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "hierarchy.commune.code",
  },
  fields: [
    {
      key: "classe_potentiel",
      label: "Classe de potentiel",
      type: "enum",
      enumValues: {
        "1": "Faible",
        "2": "Moyen",
        "3": "Élevé",
      },
      primary: true,
    },
  ],
  priority: "recommended",
};

// ==========================================================================
// Georisques REST — Catastrophes naturelles
// ==========================================================================

/**
 * Arrêtés de catastrophe naturelle (CatNat) sur la commune.
 *
 * Historique des arrêtés : inondation, sécheresse, mouvement de terrain...
 * Tri chronologique descendant (plus récent en premier).
 *
 * Route : GET /catnat?code_insee=XXXXX
 */
const CATNAT_FILTERS: UserFilterDef[] = [
  {
    key: "period",
    label: "Période",
    type: "date_range",
    toCql: "dat_deb",
    toParam: "date",
  },
];

export const RISQUES_CATNAT: SourceDef = {
  id: "georisques_catnat",
  label: "Catastrophes naturelles",
  description: "Historique des arrêtés de catastrophe naturelle",
  endpoint: "georisques_rest",
  path: "/gaspar/catnat",
  levels: ["commune"],
  theme: "risques",
  action: "catnat",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    {
      key: "libelle_risque_jo",
      label: "Type de risque",
      type: "string",
      primary: true,
    },
    {
      key: "date_debut_evt",
      label: "Date début",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: true,
    },
    {
      key: "date_fin_evt",
      label: "Date fin",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: true,
    },
    {
      key: "date_publication_jo",
      label: "Publication JO",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: false,
    },
    {
      key: "date_publication_arrete",
      label: "Publication arrêté",
      type: "date",
      transforms: ["parse_date_iso"],
      primary: false,
    },
  ],
  userFilters: CATNAT_FILTERS,
  constraints: {
    dateField: "date_debut_evt",
  },
  defaultSort: { field: "date_debut_evt", order: "desc" },
  priority: "recommended",
};

// ==========================================================================
// Georisques REST — Cavités souterraines
// ==========================================================================

/**
 * Cavités souterraines référencées sur la commune.
 *
 * Route : GET /cavites?code_insee=XXXXX
 */
export const RISQUES_CAVITES: SourceDef = {
  id: "georisques_cavites",
  label: "Cavités souterraines",
  description: "Cavités souterraines référencées (naturelles, mines, carrières...)",
  endpoint: "georisques_rest",
  path: "/cavites",
  levels: ["commune"],
  theme: "risques",
  action: "cavites",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "nom", label: "Nom", type: "string", primary: true },
    {
      key: "type_cavite",
      label: "Type",
      type: "enum",
      enumValues: {
        naturelle: "Naturelle",
        carriere: "Carrière",
        mine: "Mine",
        ouvrage_civil: "Ouvrage civil",
        ouvrage_militaire: "Ouvrage militaire",
        indetermine: "Indéterminé",
      },
      primary: true,
    },
    {
      key: "profondeur",
      label: "Profondeur",
      type: "number",
      unit: "m",
      primary: false,
    },
  ],
  geoFields: { lon: "longitude", lat: "latitude" },
  priority: "recommended",
};

// ==========================================================================
// Georisques REST — Retrait-gonflement des argiles
// ==========================================================================

/**
 * Aléa retrait-gonflement des argiles.
 *
 * ⚠ Filtre par coordonnées (lon,lat), pas par code_insee.
 * On utilise le centroïde de la commune/parcelle/bâtiment.
 *
 * Route : GET /argiles?lon=X&lat=Y
 */
export const RISQUES_ARGILES: SourceDef = {
  id: "georisques_argiles",
  label: "Retrait-gonflement argiles",
  description: "Niveau d'aléa retrait-gonflement des argiles",
  endpoint: "georisques_rest",
  path: "/argiles",
  levels: ["commune", "parcelle", "batiment"],
  theme: "risques",
  action: "argiles",
  pivot: {
    strategy: "spatial",
    spatialOp: "bbox",
    from: "context.bbox",
  },
  fields: [
    {
      key: "niveau_alea",
      label: "Niveau d'aléa",
      type: "enum",
      enumValues: {
        fort: "Fort",
        moyen: "Moyen",
        faible: "Faible",
        "a priori nul": "A priori nul",
      },
      primary: true,
    },
  ],
  constraints: {
    spatialOnly: true,
  },
  priority: "recommended",
};

// ==========================================================================
// Georisques REST — ICPE (Installations Classées)
// ==========================================================================

/**
 * Installations Classées pour la Protection de l'Environnement.
 *
 * Usines, entrepôts, stations-service, élevages... soumis à
 * déclaration, enregistrement ou autorisation.
 *
 * Route : GET /installations_classees?code_insee=XXXXX
 */
export const RISQUES_ICPE: SourceDef = {
  id: "georisques_icpe",
  label: "Installations classées (ICPE)",
  description: "Installations classées pour la protection de l'environnement",
  endpoint: "georisques_rest",
  path: "/installations_classees",
  levels: ["commune"],
  theme: "risques",
  action: "icpe",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "raisonSociale", label: "Nom", type: "string", primary: true },
    { key: "adresse1", label: "Adresse", type: "string", primary: false },
    { key: "codePostal", label: "Code postal", type: "string", primary: false },
    {
      key: "regime",
      label: "Régime",
      type: "enum",
      enumValues: {
        A: "Autorisation",
        E: "Enregistrement",
        D: "Déclaration",
        DC: "Déclaration avec contrôle",
        NC: "Non classé",
        I: "Inconnu",
      },
      primary: true,
    },
    {
      key: "seveso",
      label: "Seveso",
      type: "enum",
      enumValues: {
        SH: "Seuil haut",
        SB: "Seuil bas",
        NS: "Non Seveso",
        ND: "Non déterminé",
      },
      primary: true,
    },
    {
      key: "etat_activite",
      label: "État",
      type: "enum",
      enumValues: {
        "En fonctionnement": "En fonctionnement",
        "En construction": "En construction",
        "A l'arret": "À l'arrêt",
        "Cessation déclarée": "Cessation déclarée",
      },
      primary: false,
    },
  ],
  geoFields: { lon: "longitude", lat: "latitude" },
  userFilters: [
    {
      key: "regime",
      label: "Régime ICPE",
      type: "enum",
      values: {
        A: "Autorisation",
        E: "Enregistrement",
        D: "Déclaration",
      },
      toParam: "regime",
    },
    {
      key: "seveso",
      label: "Classement Seveso",
      type: "enum",
      values: {
        SH: "Seuil haut",
        SB: "Seuil bas",
        NS: "Non Seveso",
      },
      toParam: "seveso",
    },
  ],
  priority: "recommended",
};

// ==========================================================================
// Georisques REST — GASPAR (inventaire communal des risques)
// ==========================================================================

/**
 * GASPAR — inventaire des risques naturels et technologiques connus
 * sur la commune (PPR, TIM, DICRIM, PCS, DDRM).
 *
 * Route : GET /gaspar/risques?code_insee=XXXXX
 */
export const RISQUES_GASPAR: SourceDef = {
  id: "georisques_gaspar",
  label: "Inventaire des risques (GASPAR)",
  description: "Inventaire communal des risques naturels et technologiques connus",
  endpoint: "georisques_rest",
  path: "/gaspar/risques",
  levels: ["commune"],
  theme: "risques",
  action: null,
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "context.code",
  },
  fields: [
    { key: "libelle_risque_long", label: "Type de risque", type: "string", primary: true },
    {
      key: "num_risque",
      label: "Code risque",
      type: "string",
      primary: false,
    },
  ],
  priority: "required",
};

// ==========================================================================
// Georisques WFS — PPR (Plans de Prévention des Risques)
// ==========================================================================

/**
 * Plans de Prévention des Risques (PPR) — via GéoRisques REST.
 *
 * Inclut : PPRI (inondation), PPRT (technologique), PPRN (naturel).
 *
 * Route : GET /ppr?code_insee=XXXXX
 */
export const RISQUES_PPR: SourceDef = {
  id: "georisques_ppr",
  label: "Plans de prévention des risques",
  description: "Plans de Prévention des Risques prescrits ou approuvés (PPR)",
  endpoint: "georisques_rest",
  path: "/ppr",
  levels: ["commune", "parcelle"],
  theme: "risques",
  action: "ppr",
  pivot: {
    strategy: "attribute",
    attribute: "code_insee",
    from: "hierarchy.commune.code",
  },
  fields: [
    { key: "nom_ppr", label: "Nom du PPR", type: "string", primary: true },
    { key: "type_ppr", label: "Type", type: "string", primary: true },
    {
      key: "etat",
      label: "État",
      type: "enum",
      enumValues: {
        applique: "Appliqué",
        prescrit: "Prescrit",
        approuve: "Approuvé",
        annule: "Annulé",
      },
      primary: true,
    },
    {
      key: "date_approbation",
      label: "Date d'approbation",
      type: "date",
      transforms: ["parse_date_iso", "format_date_fr"],
      primary: false,
    },
  ],
  priority: "recommended",
};

// ==========================================================================
// Export groupé
// ==========================================================================

export const RISQUES_SOURCES: SourceDef[] = [
  RISQUES_GASPAR,
  RISQUES_RADON,
  RISQUES_CATNAT,
  RISQUES_CAVITES,
  RISQUES_ARGILES,
  RISQUES_ICPE,
  RISQUES_PPR,
];
