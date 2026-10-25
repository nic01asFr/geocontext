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
  /** Géométrie exacte (parcelle) pour les filtres INTERSECTS */
  geometry?: GeoJSON.Geometry | null;
  hierarchy: Hierarchy;
  /** Information de résolution (ex. arrondissement rattaché à sa commune) */
  note?: string;
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


// ==========================================================================
// Codes et noms de region / departement (ambiguites)
// ==========================================================================

/** Codes a 2 chiffres portes a la fois par une region et par un departement (ex. 93 : PACA / Seine-Saint-Denis). */
const CODES_REGION_ET_DEPARTEMENT = new Set(["01", "02", "03", "04", "06", "11", "24", "27", "28", "32", "44", "52", "53", "75", "76", "84", "93", "94"]);

const sansAccent = (x: string) => x.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const ALIAS_REGION: Record<string, string> = { paca: "93", idf: "11", aura: "84" };

const normNom = (x: string) => sansAccent(x).replace(/\bst\b/g, "saint").replace(/\bste\b/g, "sainte");
/** Le nom trouvé figure-t-il, mot pour mot, dans la requête ? (« St Tropez » ↔ « Saint-Tropez » ; « Cassis 13260 » ↔ « Cassis » ; « France » ≠ « Fort-de-France ») */
export function nomCorrespond(requete: string, nom: string): boolean {
  const n = normNom(nom); if (!n) return false;
  return ` ${normNom(requete)} `.includes(` ${n} `);
}

interface EntiteAdmin { niveau: "region" | "departement"; code: string; nom: string }
let listeAdminP: Promise<EntiteAdmin[]> | null = null;
/** Regions et departements (nom, code), lus une fois dans ADMIN EXPRESS ; une erreur n'est pas memorisee. */
function listeAdmin(): Promise<EntiteAdmin[]> {
  if (!listeAdminP) {
    const lire = async (niveau: "region" | "departement"): Promise<EntiteAdmin[]> => {
      const p = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeName: `ADMINEXPRESS-COG.LATEST:${niveau}`, outputFormat: "application/json", propertyName: "nom_officiel,code_insee", count: "200" });
      const r = await fetch(`${GPF_WFS}?${p}`); if (!r.ok) throw new Error(`ADMIN EXPRESS ${niveau} : HTTP ${r.status}`);
      const j = await r.json() as any; const n: EntiteAdmin[] = (j.features ?? []).map((f: any) => ({ niveau, code: String(f.properties?.code_insee), nom: String(f.properties?.nom_officiel ?? "") }));
      if (n.length < (niveau === "region" ? 17 : 100)) throw new Error(`ADMIN EXPRESS ${niveau} : liste incomplete (${n.length})`);
      return n;
    };
    listeAdminP = Promise.all([lire("region"), lire("departement")]).then((a) => a.flat());
    listeAdminP.catch(() => { listeAdminP = null; });
  }
  return listeAdminP;
}

function codeAmbigu(code: string): NavigateError {
  return { success: false, error: `Le code ${code} designe a la fois un departement et une region. Precisez « departement:${code} » ou « region:${code} ».` };
}

/** Nom exact (sans accent ni casse) d'une region ou d'un departement ; ambigu si plusieurs, ou si une commune porte le meme nom. */
async function resoudreNomAdministratif(texte: string): Promise<NavigateResult | null> {
  const q = sansAccent(texte); if (!q) return null;
  let liste: EntiteAdmin[];
  try { liste = await listeAdmin(); } catch { return null; } // liste indisponible : recherche habituelle
  const alias = ALIAS_REGION[q];
  const hits = alias ? liste.filter((e) => e.niveau === "region" && e.code === alias) : liste.filter((e) => sansAccent(e.nom) === q);
  if (hits.length === 0) return null;
  let commune: string | null = null; // une commune du meme nom (ex. Paris) : on ne choisit pas en silence
  try {
    const g = await fetchJSON(`${GPF_GEOCODE}/search?` + new URLSearchParams({ q: texte, type: "municipality", limit: "1" }).toString()) as any;
    const p = g.features?.[0]?.properties; if (p && sansAccent(String(p.city ?? p.name ?? "")) === q) commune = `commune:${p.citycode}`;
  } catch { /* pas de commune homonyme confirmee */ }
  if (hits.length > 1 || commune) {
    const opts = [...hits.map((e) => `${e.niveau}:${e.code} (${e.niveau} ${e.nom})`), ...(commune ? [`${commune} (commune)`] : [])];
    return { success: false, error: `« ${texte} » est ambigu. Precisez : ${opts.join(" ; ")}.` };
  }
  const h = hits[0]; return h.niveau === "region" ? resolveRegion(h.code) : resolveDepartement(h.code);
}

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

  // 0. Format typé "level:code" (ex: "region:11", "departement:33", "epci:243300316")
  const typedMatch = t.match(/^(region|departement|epci|commune):(.+)$/);
  if (typedMatch) {
    const [, level, code] = typedMatch;
    switch (level) {
      case "region": return resolveRegion(code);
      case "departement": return resolveDepartement(code);
      case "epci": return resolveEpci(code);
      case "commune": return resolveCommune(code);
    }
  }

  // 1. Code INSEE commune (5 chiffres)
  if (/^\d{5}$/.test(t)) {
    return resolveCommune(t);
  }

  // 1 bis. Identifiant BD TOPO de bâtiment (cleabs) : le niveau « bâtiment » n'est pas navigable ; refus explicite plutôt que lecture comme parcelle
  if (/^BATIMENT\d{10,}$/i.test(t)) {
    return { success: false, error: `Navigation vers un bâtiment non prise en charge (« ${t} »). Naviguer vers sa parcelle ou sa commune, puis charger la couche des bâtiments.` };
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
    if (CODES_REGION_ET_DEPARTEMENT.has(t)) return codeAmbigu(t);
    return resolveDepartement(t.toUpperCase());
  }

  // 5. Code SIREN EPCI (9 chiffres commençant par 2)
  if (/^2\d{8}$/.test(t)) {
    return resolveEpci(t);
  }

  // 6. Texte libre → geocodage
  const admin = await resoudreNomAdministratif(t);
  if (admin) return admin;
  return resolveTextSearch(t);
}

// ==========================================================================
// Stratégies de résolution
// ==========================================================================

/**
 * Résout une commune par code INSEE via WFS ADMINEXPRESS.
 */
/**
 * Paris, Lyon, Marseille : les codes d'arrondissement municipal (751xx, 6938x, 132xx)
 * n'existent pas dans la couche « commune » d'ADMINEXPRESS → rattachement à la commune.
 */
function communeMereArrondissement(code: string): string | null {
  if (/^132(0[1-9]|1[0-6])$/.test(code)) return "13055"; // Marseille
  if (/^6938[1-9]$/.test(code)) return "69123"; // Lyon
  if (/^751(0[1-9]|1\d|20)$/.test(code)) return "75056"; // Paris
  return null;
}

async function resolveCommune(codeInsee: string): Promise<NavigateResult> {
  const mere = communeMereArrondissement(codeInsee);
  if (mere) {
    const r = await resolveCommune(mere);
    if (r.success) {
      return { ...r, note: `Le code ${codeInsee} est un arrondissement municipal : rattaché à la commune ${r.name} (${mere}).` };
    }
    return r;
  }
  const feature = await fetchWfsFeature(
    "ADMINEXPRESS-COG.LATEST:commune",
    `code_insee='${codeInsee}'`,
  );

  if (!feature) {
    return { success: false, error: `Commune introuvable : ${codeInsee}` };
  }

  const props = feature.properties ?? {};
  const hierarchy = await buildHierarchyFromCommune(props);
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
    geometry: feature.geometry ?? null,
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
 * Résout une région par code INSEE.
 * Utilise le fetch natif Node.js pour éviter les problèmes de node-fetch.
 */
async function resolveRegion(code: string): Promise<NavigateResult> {
  // fetchWfsFeature utilise node-fetch qui peut échouer silencieusement
  // pour les géométries lourdes → requêter sans géométrie d'abord
  const params = new URLSearchParams({
    service: "WFS",
    version: "2.0.0",
    request: "GetFeature",
    typeName: "ADMINEXPRESS-COG.LATEST:region",
    outputFormat: "application/json",
    CQL_FILTER: `code_insee='${code}'`,
    count: "1",
    srsName: "EPSG:4326",
  });

  try {
    const response = await fetch(`${GPF_WFS}?${params.toString()}`);
    const json = await response.json() as any;
    const feature = (json.features ?? [])[0];

    if (!feature) {
      return { success: false, error: `Région introuvable : ${code}` };
    }

    const props = feature.properties ?? {};
    const name = props.nom_officiel ?? props.nom ?? code;

    return {
      success: true,
      level: "region",
      code,
      name,
      bbox: extractBbox(feature),
      hierarchy: {
        region: { code, name },
      },
    };
  } catch (err) {
    return { success: false, error: `Erreur résolution région ${code}: ${err}` };
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
 *
 * Utilise /search avec type=municipality pour retourner directement
 * le citycode INSEE, évitant le round-trip coordinates→reverse qui
 * peut tomber sur une commune voisine.
 */
async function resolveTextSearch(text: string): Promise<NavigateResult> {
  const url = `${GPF_GEOCODE}/search?` + new URLSearchParams({
    q: text,
    type: "municipality",
    limit: "1",
  }).toString();

  try {
    const json = await fetchJSON(url) as any;
    const features = json.features ?? [];
    if (features.length === 0) {
      return { success: false, error: `Aucun résultat pour « ${text} »` };
    }

    const props = features[0].properties ?? {};
    const citycode = props.citycode;
    // Le géocodeur renvoie toujours « la plus proche » : sans correspondance de nom, on ne choisit pas en silence (ex. « France » → Fort-de-France).
    const nomTrouve = String(props.city ?? props.name ?? "");
    if (nomTrouve && !nomCorrespond(text, nomTrouve)) {
      return { success: false, error: `« ${text} » ne correspond à aucune commune par son nom : le géocodeur propose « ${nomTrouve} »${citycode ? ` (${citycode})` : ""}. Si c'est bien celle-ci, précisez « commune:${citycode ?? "code INSEE"} » ; sinon reformulez avec le nom exact de la commune, de l'EPCI, du département ou de la région (la France entière n'est pas un territoire navigable).` };
    }
    if (citycode && /^\d{5}$/.test(citycode)) {
      return resolveCommune(citycode);
    }

    // Fallback sur les coordonnées si pas de citycode
    const [lon, lat] = features[0].geometry?.coordinates ?? [];
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
 *   - codes_siren_des_epci
 *   - code_insee_du_departement
 *   - code_insee_de_la_region
 *
 * Les noms département et région ne sont pas dans la feature commune —
 * on fait des appels WFS séparés pour les récupérer.
 */
async function buildHierarchyFromCommune(props: Record<string, any>): Promise<Hierarchy> {
  const hierarchy: Hierarchy = {};

  // Commune
  const codeInsee = props.code_insee ?? props.insee_com;
  if (codeInsee) {
    hierarchy.commune = {
      code: codeInsee,
      name: props.nom_officiel ?? props.nom ?? codeInsee,
    };
  }

  // EPCI — la FK est codes_siren_des_epci (peut contenir plusieurs, on prend le premier)
  const sirenEpciRaw = props.codes_siren_des_epci ?? props.siren_epci ?? props.code_epci;
  const sirenEpci = typeof sirenEpciRaw === "string"
    ? sirenEpciRaw.split("/")[0].trim()
    : sirenEpciRaw;
  if (sirenEpci) {
    const epciFeature = await fetchWfsFeature(
      "ADMINEXPRESS-COG.LATEST:epci",
      `code_siren='${sirenEpci}'`,
    );
    hierarchy.epci = {
      code: sirenEpci,
      name: epciFeature?.properties?.nom_officiel ?? sirenEpci,
      siren: sirenEpci,
    };
  }

  // Département
  const codeDept = props.code_insee_du_departement ?? props.code_dept ?? props.insee_dep;
  if (codeDept) {
    const deptFeature = await fetchWfsFeature(
      "ADMINEXPRESS-COG.LATEST:departement",
      `code_insee='${codeDept}'`,
    );
    hierarchy.departement = {
      code: codeDept,
      name: deptFeature?.properties?.nom_officiel ?? codeDept,
    };
  }

  // Région
  const codeRegion = props.code_insee_de_la_region ?? props.insee_reg;
  if (codeRegion) {
    const regionFeature = await fetchWfsFeature(
      "ADMINEXPRESS-COG.LATEST:region",
      `code_insee='${codeRegion}'`,
    );
    hierarchy.region = {
      code: codeRegion,
      name: regionFeature?.properties?.nom_officiel ?? codeRegion,
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
