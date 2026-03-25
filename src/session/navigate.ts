/**
 * geocontext — Territory Resolution (navigate)
 *
 * Résout une cible de navigation textuelle en un résultat structuré.
 *
 * Stratégies de résolution, essayées dans l'ordre :
 *
 *   1. Code INSEE commune (5 chiffres)                → WFS ADMINEXPRESS commune
 *   2. Identifiant parcellaire (14+ chars alphanum)   → WFS CADASTRALPARCELS parcelle
 *   3. Coordonnées lon,lat (deux nombres)             → GPF geocodage reverse → commune
 *   4. Code département (2-3 chiffres ou 2A/2B)       → WFS ADMINEXPRESS departement
 *   5. Code SIREN EPCI (9 chiffres commençant par 2)  → WFS ADMINEXPRESS epci
 *   6. Texte libre                                     → GPF geocodage search → commune
 *
 * Après résolution de la commune, la hiérarchie complète (EPCI, département,
 * région) est reconstruite à partir des FK retournées par la feature commune.
 *
 * @see docs/navigation-context.md — cycle de navigation
 */

import { fetchJSON } from "../helpers/http.js";
import type { TerritoryLevel, Hierarchy, NavigationContext } from "./types.js";

// ==========================================================================
// Types publics
// ==========================================================================

export interface NavigateSuccess {
  success: true;
  level: TerritoryLevel;
  code: string;
  name: string;
  bbox: [number, number, number, number] | null;
  hierarchy: Hierarchy;
}

export interface NavigateError {
  success: false;
  error: string;
}

export type NavigateResult = NavigateSuccess | NavigateError;

// ==========================================================================
// Constantes
// ==========================================================================

const GPF_WFS = "https://data.geopf.fr/wfs/ows";
const GPF_GEOCODE = "https://data.geopf.fr/geocodage";

// ==========================================================================
// Point d'entrée
// ==========================================================================

/**
 * Résout une cible de navigation en territoire identifié.
 *
 * @param target — texte libre, code INSEE, coordonnées, identifiant parcelle…
 * @param ctx    — contexte courant (peut servir à affiner)
 * @returns résultat de navigation
 */
export async function resolveTerritory(
  target: string,
  _ctx: NavigationContext,
): Promise<NavigateResult> {
  const t = target.trim();
  if (!t) return { success: false, error: "Cible de navigation vide." };

  // 1. Code INSEE commune (5 chiffres)
  if (/^\d{5}$/.test(t)) {
    return resolveCommune(t);
  }

  // 2. Identifiant parcellaire (14+ chars, alphanum majuscule)
  if (/^[0-9A-Z]{14,}$/i.test(t)) {
    return resolveParcelle(t.toUpperCase());
  }

  // 3. Coordonnées lon,lat
  const coordMatch = t.match(/^(-?\d+\.?\d*)\s*[,;\s]\s*(-?\d+\.?\d*)$/);
  if (coordMatch) {
    const lon = parseFloat(coordMatch[1]);
    const lat = parseFloat(coordMatch[2]);
    if (isValidLonLat(lon, lat)) {
      return resolveCoordinates(lon, lat);
    }
  }

  // 4. Code département (2-3 chiffres ou 2A/2B)
  if (/^(\d{2,3}|2[AB])$/i.test(t)) {
    return resolveDepartement(t.toUpperCase());
  }

  // 5. Code SIREN EPCI (9 chiffres commençant par 2)
  if (/^2\d{8}$/.test(t)) {
    return resolveEpci(t);
  }

  // 6. Texte libre → geocodage
  return resolveTextSearch(t);
}

// ==========================================================================
// Stratégies de résolution
// ==========================================================================

/**
 * Résout une commune par code INSEE via WFS ADMINEXPRESS.
 */
async function resolveCommune(codeInsee: string): Promise<NavigateResult> {
  const feature = await fetchWfsFeature(
    "ADMINEXPRESS-COG.LATEST:commune",
    `code_insee='${codeInsee}'`,
  );

  if (!feature) {
    return { success: false, error: `Commune introuvable : ${codeInsee}` };
  }

  const props = feature.properties ?? {};
  const hierarchy = buildHierarchyFromCommune(props);
  const name = props.nom_officiel ?? props.nom ?? codeInsee;

  return {
    success: true,
    level: "commune",
    code: codeInsee,
    name,
    bbox: extractBbox(feature),
    hierarchy,
  };
}

/**
 * Résout une parcelle par identifiant (idpar) via WFS CADASTRALPARCELS.
 */
async function resolveParcelle(idpar: string): Promise<NavigateResult> {
  const feature = await fetchWfsFeature(
    "CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle",
    `idu='${idpar}'`,
  );

  if (!feature) {
    return { success: false, error: `Parcelle introuvable : ${idpar}` };
  }

  // Extraire le code commune depuis l'idpar (5 premiers caractères)
  const codeCommune = idpar.substring(0, 5);

  // Résoudre la hiérarchie via la commune
  const communeResult = await resolveCommune(codeCommune);
  const hierarchy: Hierarchy = communeResult.success
    ? { ...communeResult.hierarchy, parcelle: { idpar } }
    : { parcelle: { idpar } };

  return {
    success: true,
    level: "parcelle",
    code: idpar,
    name: `Parcelle ${idpar}`,
    bbox: extractBbox(feature),
    hierarchy,
  };
}

/**
 * Résout des coordonnées lon/lat → commune via geocodage reverse.
 */
async function resolveCoordinates(
  lon: number,
  lat: number,
): Promise<NavigateResult> {
  const url = `${GPF_GEOCODE}/reverse?` + new URLSearchParams({
    lon: String(lon),
    lat: String(lat),
  }).toString();

  try {
    const json = await fetchJSON(url) as any;
    const features = json.features ?? [];
    if (features.length === 0) {
      return { success: false, error: `Aucun résultat pour les coordonnées ${lon}, ${lat}` };
    }

    const props = features[0].properties ?? {};
    const codeInsee = props.citycode ?? props.postcode;
    if (codeInsee && /^\d{5}$/.test(codeInsee)) {
      return resolveCommune(codeInsee);
    }

    return {
      success: false,
      error: `Geocodage inversé : code commune non trouvé pour ${lon}, ${lat}`,
    };
  } catch (err) {
    return {
      success: false,
      error: `Erreur geocodage inversé : ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Résout un département par code INSEE.
 */
async function resolveDepartement(code: string): Promise<NavigateResult> {
  const feature = await fetchWfsFeature(
    "ADMINEXPRESS-COG.LATEST:departement",
    `code_insee='${code}'`,
  );

  if (!feature) {
    return { success: false, error: `Département introuvable : ${code}` };
  }

  const props = feature.properties ?? {};
  const name = props.nom_officiel ?? props.nom ?? code;

  // Chercher la région parente
  const codeRegion = props.code_insee_de_la_region ?? props.insee_reg;
  const hierarchy: Hierarchy = {
    departement: { code, name },
  };

  if (codeRegion) {
    const regionFeature = await fetchWfsFeature(
      "ADMINEXPRESS-COG.LATEST:region",
      `code_insee='${codeRegion}'`,
    );
    if (regionFeature?.properties) {
      const rProps = regionFeature.properties;
      hierarchy.region = {
        code: codeRegion,
        name: rProps.nom_officiel ?? rProps.nom ?? codeRegion,
      };
    }
  }

  return {
    success: true,
    level: "departement",
    code,
    name,
    bbox: extractBbox(feature),
    hierarchy,
  };
}

/**
 * Résout un EPCI par code SIREN.
 */
async function resolveEpci(siren: string): Promise<NavigateResult> {
  const feature = await fetchWfsFeature(
    "ADMINEXPRESS-COG.LATEST:epci",
    `code_siren='${siren}'`,
  );

  if (!feature) {
    return { success: false, error: `EPCI introuvable : ${siren}` };
  }

  const props = feature.properties ?? {};
  const name = props.nom_officiel ?? props.nom ?? siren;

  return {
    success: true,
    level: "epci",
    code: siren,
    name,
    bbox: extractBbox(feature),
    hierarchy: {
      epci: { code: siren, name, siren },
    },
  };
}

/**
 * Résout un texte libre via le geocodage GPF → commune.
 */
async function resolveTextSearch(text: string): Promise<NavigateResult> {
  const url = `${GPF_GEOCODE}/completion/?` + new URLSearchParams({
    text,
    maximumResponses: "1",
  }).toString();

  try {
    const json = await fetchJSON(url) as any;
    const results = json.results ?? [];
    if (results.length === 0) {
      return { success: false, error: `Aucun résultat pour « ${text} »` };
    }

    const first = results[0];
    const lon = first.x;
    const lat = first.y;

    // Si le résultat a un code commune, l'utiliser directement
    if (first.city && first.zipcode) {
      // Utiliser les coordonnées pour trouver la commune via reverse
      return resolveCoordinates(lon, lat);
    }

    // Sinon, tenter avec les coordonnées
    if (typeof lon === "number" && typeof lat === "number") {
      return resolveCoordinates(lon, lat);
    }

    return { success: false, error: `Résultat non exploitable pour « ${text} »` };
  } catch (err) {
    return {
      success: false,
      error: `Erreur geocodage : ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

// ==========================================================================
// Utilitaires WFS
// ==========================================================================

/**
 * Récupère une feature unique depuis le WFS GPF.
 */
async function fetchWfsFeature(
  typename: string,
  cqlFilter: string,
): Promise<any | null> {
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName: typename,
    outputFormat: "application/json",
    CQL_FILTER: cqlFilter,
    count: "1",
    srsName: "EPSG:4326",
  });

  const url = `${GPF_WFS}?${params.toString()}`;

  try {
    const json = await fetchJSON(url) as any;
    const features = json.features ?? [];
    return features.length > 0 ? features[0] : null;
  } catch {
    return null;
  }
}

/**
 * Construit la hiérarchie complète à partir des propriétés d'une commune.
 *
 * La feature ADMINEXPRESS commune contient les FK vers les niveaux parents :
 *   - siren_epci
 *   - code_insee_du_departement (ou code_dept)
 *   - code_insee_de_la_region (ou insee_reg)
 */
function buildHierarchyFromCommune(props: Record<string, any>): Hierarchy {
  const hierarchy: Hierarchy = {};

  // Commune elle-même
  // ADMINEXPRESS: code_insee, nom_officiel
  const codeInsee = props.code_insee ?? props.insee_com;
  if (codeInsee) {
    hierarchy.commune = {
      code: codeInsee,
      name: props.nom_officiel ?? props.nom ?? codeInsee,
    };
  }

  // EPCI
  // ADMINEXPRESS commune FK: siren_epci, nom_epci (pas toujours présent)
  const sirenEpci = props.siren_epci ?? props.code_epci;
  if (sirenEpci) {
    hierarchy.epci = {
      code: sirenEpci,
      name: props.nom_epci ?? sirenEpci,
      siren: sirenEpci,
    };
  }

  // Département
  // ADMINEXPRESS commune FK: code_insee_du_departement
  const codeDept = props.code_insee_du_departement ?? props.code_dept ?? props.insee_dep;
  if (codeDept) {
    hierarchy.departement = {
      code: codeDept,
      name: props.nom_du_departement ?? props.nom_dept ?? codeDept,
    };
  }

  // Région
  // ADMINEXPRESS commune FK: code_insee_de_la_region
  const codeRegion = props.code_insee_de_la_region ?? props.insee_reg;
  if (codeRegion) {
    hierarchy.region = {
      code: codeRegion,
      name: props.nom_de_la_region ?? props.nom_reg ?? codeRegion,
    };
  }

  return hierarchy;
}

// ==========================================================================
// Utilitaires géométriques
// ==========================================================================

/**
 * Extrait la bbox d'une feature GeoJSON.
 * Retourne [minLon, minLat, maxLon, maxLat] ou null.
 */
function extractBbox(feature: any): [number, number, number, number] | null {
  // bbox directe
  if (feature.bbox && feature.bbox.length >= 4) {
    return [feature.bbox[0], feature.bbox[1], feature.bbox[2], feature.bbox[3]];
  }

  // Calculer depuis la géométrie
  if (feature.geometry?.coordinates) {
    return computeBbox(feature.geometry);
  }

  return null;
}

/**
 * Calcule la bbox d'une géométrie GeoJSON.
 */
function computeBbox(geometry: any): [number, number, number, number] | null {
  const coords = flattenCoordinates(geometry);
  if (coords.length === 0) return null;

  let minLon = Infinity, minLat = Infinity;
  let maxLon = -Infinity, maxLat = -Infinity;

  for (const [lon, lat] of coords) {
    if (lon < minLon) minLon = lon;
    if (lat < minLat) minLat = lat;
    if (lon > maxLon) maxLon = lon;
    if (lat > maxLat) maxLat = lat;
  }

  return [minLon, minLat, maxLon, maxLat];
}

/**
 * Aplatit les coordonnées d'une géométrie GeoJSON en tableau de [lon, lat].
 */
function flattenCoordinates(geometry: any): number[][] {
  if (!geometry?.coordinates) return [];

  const type = geometry.type;
  const coords = geometry.coordinates;

  switch (type) {
    case "Point":
      return [coords];
    case "MultiPoint":
    case "LineString":
      return coords;
    case "MultiLineString":
    case "Polygon":
      return coords.flat();
    case "MultiPolygon":
      return coords.flat(2);
    default:
      return [];
  }
}

/**
 * Vérifie que des coordonnées lon/lat sont dans des bornes raisonnables
 * (métropole + outre-mer français).
 */
function isValidLonLat(lon: number, lat: number): boolean {
  return lon >= -180 && lon <= 180 && lat >= -90 && lat <= 90;
}
