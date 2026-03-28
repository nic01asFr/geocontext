/**
 * geocontext — Endpoint Definitions
 *
 * Définition des 16 endpoints (serveurs de données distants).
 * Chaque endpoint est défini une seule fois avec toutes ses caractéristiques
 * techniques : URL, protocole, CRS natif, limites, authentification, retry.
 *
 * Les SourceDef référencent les endpoints par leur `id`.
 * Les executors utilisent ces définitions pour construire et envoyer les requêtes.
 *
 * Organisation :
 *   - 4 endpoints principaux  (Géoplateforme + BDNB)
 *   - 5 endpoints secondaires (Georisques, RNB, DVF, ADEME)
 *   - 7 endpoints tertiaires  (INSEE, eau, culture, éducation, santé)
 *
 * @see docs/terrid-spec.md — liste complète des endpoints et données
 */

import type { EndpointDef, EndpointId } from "./types.js";

// ---------------------------------------------------------------------------
// Retry policy par défaut (partagée par la plupart des endpoints)
// ---------------------------------------------------------------------------

/**
 * Politique de retry standard : 3 tentatives, backoff exponentiel 1s→2s→4s.
 * Retrie sur 429 (rate limit), 502/503/504 (erreurs serveur transitoires).
 */
const DEFAULT_RETRY = {
  maxRetries: 3,
  initialDelayMs: 1000,
  retryOnStatus: [429, 502, 503, 504],
} as const;

// ==========================================================================
// Endpoints principaux — Géoplateforme + BDNB
// ==========================================================================

/**
 * Géoplateforme WFS — endpoint principal.
 *
 * Donne accès à ~60 couches : ADMINEXPRESS, BDTOPO, cadastre,
 * urbanisme (GPU), assiettes SUP, espaces protégés, IRIS, OCS GE,
 * RPG, BD Forêt, PEB.
 *
 * Protocole WFS 2.0.0. CRS natif EPSG:4326.
 * Limite : 1000 features/requête. Max 2 couches simultanées (juin 2026).
 * Pas d'authentification.
 */
const GPF_WFS: EndpointDef = {
  id: "gpf_wfs",
  baseUrl: "https://data.geopf.fr/wfs/ows",
  protocol: "wfs",
  nativeCrs: "EPSG:4326",
  maxFeatures: 1000,
  timeoutMs: 30_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
  wfsVersion: "2.0.0",
};

/**
 * Géoplateforme Géocodage — recherche d'adresses et de lieux.
 *
 * Endpoints : /search (géocodage), /reverse (géocodage inverse),
 * /completion (autocomplétion).
 * Retourne du GeoJSON. CRS EPSG:4326. Pas de limite de features
 * (résultats paginés par le serveur, top N).
 */
const GPF_GEOCODAGE: EndpointDef = {
  id: "gpf_geocodage",
  baseUrl: "https://data.geopf.fr/geocodage",
  protocol: "rest_geojson",
  nativeCrs: "EPSG:4326",
  maxFeatures: 20,
  timeoutMs: 10_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * Géoplateforme Altimétrie — altitude d'un point.
 *
 * Endpoint : /alti/rest/elevation.json
 * Retourne un JSON simple avec l'altitude en mètres.
 */
const GPF_ALTIMETRIE: EndpointDef = {
  id: "gpf_altimetrie",
  baseUrl: "https://data.geopf.fr/altimetrie",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 1,
  timeoutMs: 10_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * BDNB — Base de Données Nationale des Bâtiments.
 *
 * API REST avec 400+ champs par bâtiment : énergie (DPE agrégés),
 * structure, matériaux, risques, adresses, parcelles.
 *
 * Authentification par clé API (env BDNB_API_KEY).
 * Limite : 500 résultats par page.
 */
const BDNB: EndpointDef = {
  id: "bdnb",
  baseUrl: "https://api.bdnb.io/v1",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 500,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: "BDNB_API_KEY",
};

// ==========================================================================
// Endpoints secondaires — Georisques, RNB, DVF, ADEME
// ==========================================================================

/**
 * Georisques WFS — couches géographiques des risques.
 *
 * PPR (Plans de Prévention des Risques), sites pollués (BASOL/BASIAS),
 * ICPE, cavités, mouvements de terrain.
 *
 * ⚠ CRS natif EPSG:2154 (Lambert-93) — reprojection nécessaire.
 * WFS 1.1.0 (pas 2.0). Limite : 500 features/requête.
 */
const GEORISQUES_WFS: EndpointDef = {
  id: "georisques_wfs",
  baseUrl: "https://mapsref.brgm.fr/wxs/georisques/risques",
  protocol: "wfs",
  nativeCrs: "EPSG:2154",
  maxFeatures: 500,
  timeoutMs: 30_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
  wfsVersion: "1.1.0",
};

/**
 * Georisques REST — API de consultation des risques par commune.
 *
 * Routes : /radon, /catnat, /cavites, /argiles, /icpe, /gaspar.
 * Filtrage par code_insee ou coordonnées (lon,lat).
 * Pas d'authentification. Pas de CRS (données tabulaires + coordonnées WGS84).
 */
const GEORISQUES_REST: EndpointDef = {
  id: "georisques_rest",
  baseUrl: "https://georisques.gouv.fr/api/v1",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 100,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * RNB — Référentiel National des Bâtiments.
 *
 * Identifiant universel et pérenne pour chaque bâtiment (rnb_id).
 * API REST JSON. Filtrage par insee_code, point, bbox.
 * Réponse paginée : { results: [...], count, next }
 */
const RNB: EndpointDef = {
  id: "rnb",
  baseUrl: "https://rnb-api.beta.gouv.fr/api/alpha",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 100,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * DVF+ — Demandes de Valeurs Foncières (API CEREMA / DVF+).
 *
 * Transactions immobilières. Filtrage par code_insee ou idpar (parcelle).
 * Réponse paginée : { count, next, previous, results: [...] }
 */
const DVF: EndpointDef = {
  id: "dvf",
  baseUrl: "https://apidf-preprod.cerema.fr/dvf_opendata",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 500,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * ADEME DPE — Diagnostics de Performance Énergétique détaillés.
 *
 * Données DPE unitaires avec tous les champs techniques.
 * Authentification par clé API (env ADEME_API_KEY).
 * ⚠ Liaison parcelle non fiable — passer par BDNB (matching via BAN).
 */
const ADEME_DPE: EndpointDef = {
  id: "ademe_dpe",
  baseUrl: "https://data.ademe.fr/data-fair/api/v1/datasets/dpe-v2-logements-existants",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 1000,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: "ADEME_API_KEY",
};

// ==========================================================================
// Endpoints tertiaires — INSEE, eau, culture, éducation, santé
// ==========================================================================

/**
 * INSEE SIRENE — répertoire des entreprises et établissements.
 *
 * Filtrage par commune (communeEtablissement), code NAF,
 * tranche d'effectifs. Authentification par clé API.
 */
const INSEE_SIRENE: EndpointDef = {
  id: "insee_sirene",
  baseUrl: "https://api.insee.fr/entreprises/sirene/V3.11",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 1000,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: "INSEE_API_KEY",
};

/**
 * Sandre — référentiel eau (masses d'eau, stations, captages).
 *
 * WFS avec couches BD TOPAGE, masses d'eau DCE, captages AEP.
 * ⚠ CRS natif EPSG:2154 (Lambert-93) — reprojection nécessaire.
 */
const SANDRE: EndpointDef = {
  id: "sandre",
  baseUrl: "https://services.sandre.eaufrance.fr/geo/MasseDEau",
  protocol: "wfs",
  nativeCrs: "EPSG:2154",
  maxFeatures: 1000,
  timeoutMs: 30_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
  wfsVersion: "2.0.0",
};

/**
 * Hub'Eau — API de données hydrologiques (qualité eau, hydrométrie).
 *
 * API REST avec pagination. Filtrage par code_commune, bbox.
 * Pas d'authentification.
 */
const HUBEAU: EndpointDef = {
  id: "hubeau",
  baseUrl: "https://hubeau.eaufrance.fr/api",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 500,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * Gest'eau — SAGE et SDAGE (schémas d'aménagement et gestion des eaux).
 *
 * WFS avec couches SAGE, SDAGE.
 * ⚠ CRS natif EPSG:2154 (Lambert-93) — reprojection nécessaire.
 */
const GESTEAU: EndpointDef = {
  id: "gesteau",
  baseUrl: "https://maps.oieau.fr/ows/OIEau/gesteau",
  protocol: "wfs",
  nativeCrs: "EPSG:2154",
  maxFeatures: 1000,
  timeoutMs: 30_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
  wfsVersion: "2.0.0",
};

/**
 * Monuments historiques — base Mérimée / Atlas du patrimoine.
 */
const CULTURE: EndpointDef = {
  id: "culture",
  baseUrl: "https://data.culture.gouv.fr/api/explore/v2.1/catalog/datasets",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 100,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * Établissements scolaires — annuaire de l'Éducation nationale.
 */
const EDUCATION: EndpointDef = {
  id: "education",
  baseUrl: "https://data.education.gouv.fr/api/explore/v2.1/catalog/datasets",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 100,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

/**
 * Établissements sanitaires — FINESS (DREES).
 */
const DREES: EndpointDef = {
  id: "drees",
  baseUrl: "https://data.drees.solidarites-sante.gouv.fr/api/explore/v2.1/catalog/datasets",
  protocol: "rest_json",
  nativeCrs: "EPSG:4326",
  maxFeatures: 100,
  timeoutMs: 15_000,
  retry: DEFAULT_RETRY,
  authEnvVar: null,
};

// ==========================================================================
// Registre d'endpoints — accès par ID
// ==========================================================================

/**
 * Map de tous les endpoints indexés par leur ID.
 * Utilisé par le registry pour résoudre endpoint d'une SourceDef.
 */
export const ENDPOINTS: ReadonlyMap<EndpointId, EndpointDef> = new Map([
  ["gpf_wfs", GPF_WFS],
  ["gpf_geocodage", GPF_GEOCODAGE],
  ["gpf_altimetrie", GPF_ALTIMETRIE],
  ["bdnb", BDNB],
  ["georisques_wfs", GEORISQUES_WFS],
  ["georisques_rest", GEORISQUES_REST],
  ["rnb", RNB],
  ["dvf", DVF],
  ["ademe_dpe", ADEME_DPE],
  ["insee_sirene", INSEE_SIRENE],
  ["sandre", SANDRE],
  ["hubeau", HUBEAU],
  ["gesteau", GESTEAU],
  ["culture", CULTURE],
  ["education", EDUCATION],
  ["drees", DREES],
]);

/**
 * Récupère un endpoint par son ID.
 * @throws Error si l'endpoint n'existe pas (erreur de programmation).
 */
export function getEndpoint(id: EndpointId): EndpointDef {
  const endpoint = ENDPOINTS.get(id);
  if (!endpoint) {
    throw new Error(`[registry] Endpoint inconnu : "${id}"`);
  }
  return endpoint;
}
