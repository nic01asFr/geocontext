/**
 * geocontext — Source Executor
 *
 * Point d'entrée pour exécuter une source de données. Dispatche vers
 * l'executor WFS ou REST selon le protocole de l'endpoint, applique
 * les transformations de champs, et retourne un SourceResult normalisé.
 *
 * Chaîne d'exécution :
 *
 *   1. Résoudre le pivot (CQL ou params REST)
 *   2. Appliquer les filtres utilisateur
 *   3. Dispatcher vers WFS ou REST executor
 *   4. Transformer les features brutes (champs, dates, unités)
 *   5. Reprojeter en EPSG:4326 si nécessaire
 *   6. Retourner un SourceResult normalisé
 *
 * Gestion d'erreurs :
 *   - Timeout → SourceResult avec success=false, error="Timeout"
 *   - Erreur HTTP → retry selon la policy, puis error
 *   - 0 résultats + partitionFallback → essayer le format alternatif
 *   - Source optional qui échoue → SourceResult success=false (pas de throw)
 *
 * @see registry/types.ts — ExecutionParams, SourceResult
 */

import { empriseIntersects } from "../../emprise.js";
import { lireExact, ErreurVolume } from "../../exact-gpu.js";
import { ensemble } from "../../tiles.js";
import type {
  SourceDef,
  EndpointDef,
  SourceResult,
  ExecutionParams,
  LayerSpec,
} from "../registry/types.js";
import { getEndpoint } from "../registry/endpoints.js";
import {
  buildAttributeCql,
  buildSpatialCql,
  buildFallbackCql,
  buildCompositeCql,
  buildRestParams,
} from "../registry/pivot.js";
import { combineUserFiltersCql, combineUserFiltersParams } from "../registry/filters.js";
import { transformFeatures } from "../registry/fields.js";
import { getStyleRecipe } from "../styling/index.js";
import type { NavigationContext } from "../types.js";

// ==========================================================================
// Execute — point d'entrée principal
// ==========================================================================

/**
 * Exécute une source de données et retourne un résultat normalisé.
 *
 * @param source      — la source à exécuter
 * @param ctx         — contexte de navigation courant
 * @param userFilters — filtres optionnels saisis par l'utilisateur/LLM
 * @param geometry    — géométrie du territoire (pour INTERSECTS)
 * @returns résultat normalisé
 *
 * @example
 *   const result = await executeSource(URBANISME_ZONAGES, context, { type_zone: "U" });
 *   if (result.success) {
 *     console.log(`${result.features.length} zonages trouvés`);
 *   }
 */
export async function executeSource(
  source: SourceDef,
  ctx: NavigationContext,
  userFilters?: Record<string, unknown>,
  geometry?: GeoJSON.Geometry,
): Promise<SourceResult> {
  const endpoint = getEndpoint(source.endpoint);

  try {
    if (endpoint.protocol === "wfs") {
      return await executeWfsSource(source, endpoint, ctx, userFilters, geometry);
    } else {
      return await executeRestSource(source, endpoint, ctx, userFilters);
    }
  } catch (err) {
    return {
      sourceId: source.id,
      success: false,
      error: err instanceof Error ? err.message : String(err),
      features: [],
    };
  }
}

/**
 * Exécute plusieurs sources en parallèle.
 *
 * Les erreurs de sources optionnelles n'interrompent pas les autres.
 * Les sources required qui échouent sont signalées dans le résultat.
 */
export async function executeSources(
  sources: SourceDef[],
  ctx: NavigationContext,
  userFilters?: Record<string, unknown>,
  geometry?: GeoJSON.Geometry,
): Promise<SourceResult[]> {
  return Promise.all(
    sources.map((source) => executeSource(source, ctx, userFilters, geometry)),
  );
}

// ==========================================================================
// Count — pré-comptage léger (resultType=hits)
// ==========================================================================

/**
 * Compte le nombre de features pour une source sans télécharger les données.
 * Utilise resultType=hits (WFS) — beaucoup plus rapide qu'un GetFeature.
 * Pour les sources REST, retourne -1 (pas de mécanisme de count léger).
 */
export async function countSource(
  source: SourceDef,
  ctx: NavigationContext,
): Promise<number> {
  const endpoint = getEndpoint(source.endpoint);
  if (endpoint.protocol !== "wfs" || !source.typename) return -1;

  // Construire le filtre pivot
  let cqlFilter: string | null = null;
  switch (source.pivot.strategy) {
    case "attribute": {
      const result = buildAttributeCql(ctx, source.pivot);
      if (!result) return -1;
      cqlFilter = result.cql;
      break;
    }
    case "spatial": {
      const result = buildSpatialCql(ctx, source.pivot);
      if (!result) return -1;
      cqlFilter = result.cql;
      break;
    }
    case "composite": {
      const result = buildCompositeCql(ctx, source.pivot);
      if (!result) return -1;
      cqlFilter = result.cql;
      break;
    }
    case "attribute_with_fallback": {
      // Pour le count, on utilise la valeur primaire ou le cache
      const result = buildFallbackCql(ctx, source.pivot);
      if (!result) return -1;
      cqlFilter = result.primary.cql;
      break;
    }
  }

  if (!cqlFilter) return -1;
  return countWfs(endpoint, source, cqlFilter);
}

// ==========================================================================
// WFS Executor
// ==========================================================================

/**
 * Exécute une source WFS.
 *
 * Construit la requête GetFeature avec :
 * - typename (couche WFS)
 * - CQL_FILTER (pivot + filtres utilisateur)
 * - propertyName (champs demandés)
 * - maxFeatures / startIndex (pagination)
 * - srsName (CRS)
 */
/** Couches du Géoportail de l'Urbanisme au niveau commune lues avec décision EXACTE d'appartenance (jsts, serveur). */
const NIVEAUX_EXACTS = ["commune", "epci", "departement", "region"];
/** Plafond de la décision exacte pour les couches filtrées par rectangle (au-delà : déclaré, jamais tranché sur un échantillon). */
const LIMITE_EXACT_BBOX = 30000;
/**
 * Mode de lecture EXACTE d'une source WFS pour le territoire navigué :
 *  - couches du GPU au niveau commune (identifiant gid) ;
 *  - couches filtrées par rectangle (BBOX) de l'entité, à tous les niveaux (commune, EPCI, département, région) : le rectangle déborde sur les
 *    territoires voisins, la décision d'appartenance est prise sur les coordonnées (identifiant WFS, ou cleabs pour la BD TOPO).
 */
function modeExact(source: SourceDef, ctx: NavigationContext): { niveau: string; cle: string; tri: string; limite?: number } | null {
  if (!ctx.level || !ctx.code || !NIVEAUX_EXACTS.includes(ctx.level) || !source.typename) return null;
  if (/^wfs_(du|sup):/.test(source.typename)) {
    return ctx.level === "commune" && source.typename !== "wfs_du:document" ? { niveau: "commune", cle: "gid", tri: "gid" } : null;
  }
  if (source.pivot.strategy === "spatial" && source.pivot.spatialOp === "bbox" && source.typename !== "BDTOPO_V3:batiment") {
    return { niveau: ctx.level, cle: "@id", tri: /^BDTOPO_V3:/.test(source.typename) ? "cleabs" : "id_local", limite: LIMITE_EXACT_BBOX };
  }
  return null;
}

async function lireSource(
  endpoint: EndpointDef, source: SourceDef, ctx: NavigationContext, cql: string,
): Promise<{ raw: { features: Record<string, unknown>[]; totalCount?: number }; exact?: ExactInfo }> {
  const mode = modeExact(source, ctx);
  if (!mode) return { raw: await fetchWfs(endpoint, source, cql) };
  const champs = source.fields.filter((f) => f.type !== "geometry").map((f) => f.key);
  let ex;
  try {
    ex = await lireExact(endpoint.baseUrl, source.typename!, cql, ctx.code!, champs, endpoint.timeoutMs, mode);
  } catch (e) {
    if (!(e instanceof ErreurVolume)) throw e;
    // Trop d'objets pour décider : lecture partielle déclarée comme telle, total = celui du RECTANGLE (borne haute), jamais présenté comme exact.
    return { raw: await fetchWfs(endpoint, source, cql), exact: { indisponible: true, raison: e.message, rectangle: e.attendu, niveau: mode.niveau } };
  }
  const maxF = source.constraints?.maxFeaturesOverride ?? endpoint.maxFeatures;
  return {
    raw: { features: ex.gardes.slice(0, maxF), totalCount: ex.gardes.length },
    exact: { lus: ex.lus, gardes: ex.gardes.length, cheval: ex.cheval, chevalGids: ex.chevalGids, ecartes: ex.ecartes, cle: ex.cle, niveau: ex.niveau },
  };
}
type ExactInfo =
  | { lus: number; gardes: number; cheval: number; chevalGids: string[]; ecartes: Array<{ gid: string; libelle: string | null; raison: string }>; cle: string; niveau: string; indisponible?: undefined }
  | { indisponible: true; raison: string; rectangle: number; niveau: string };

/** Couches GPU (urbanisme, servitudes) au niveau commune : l'emprise rectangulaire est remplacée par un sur-ensemble serré du contour communal. */
async function resserrer(source: SourceDef, ctx: NavigationContext, cql: string): Promise<string> {
  if (ctx.level !== "commune" || !ctx.code || !/^wfs_(du|sup):/.test(source.typename || "") || source.typename === "wfs_du:document") return cql; // document : INTERSECTS refusé par le service (HTTP 500), BBOX conservée, contrôle exact côté client
  const geomCol = source.fields.find((f) => f.type === "geometry")?.key || "the_geom";
  const re = /BBOX\([^)]*\)/;
  if (!re.test(cql)) return cql;
  const emp = await empriseIntersects(ctx.code, geomCol);
  return cql.replace(re, () => emp);
}

const TUILES_Z = 14;
async function executeWfsSource(
  source: SourceDef,
  endpoint: EndpointDef,
  ctx: NavigationContext,
  userFilters?: Record<string, unknown>,
  geometry?: GeoJSON.Geometry,
): Promise<SourceResult> {
  // 1. Construire le filtre pivot
  let cqlFilter: string | null = null;
  let resolvedPartition: string | undefined;

  switch (source.pivot.strategy) {
    case "attribute": {
      const result = buildAttributeCql(ctx, source.pivot);
      if (!result) return emptyResult(source.id, "Contexte insuffisant pour le filtre attributaire");
      cqlFilter = result.cql;
      break;
    }
    case "spatial": {
      const result = buildSpatialCql(ctx, source.pivot, geometry, endpoint.nativeCrs);
      if (!result) return emptyResult(source.id, "Bbox ou géométrie manquante pour le filtre spatial");
      cqlFilter = result.cql;
      break;
    }
    case "attribute_with_fallback": {
      const result = buildFallbackCql(ctx, source.pivot);
      if (!result) return emptyResult(source.id, "Contexte insuffisant pour le filtre partition");

      // Essai primaire — absorbe les erreurs HTTP (ex: 400 partition inconnue)
      // pour permettre le fallback vers le format siren_code_insee
      try {
        // Partition PLUi mémorisée (préfixe, « % » final) : elle couvre tout l'EPCI, l'emprise de l'entité navigée est donc obligatoire.
        let cqlPrimaire = result.primary.cql;
        if (result.primary.resolvedPartition.endsWith("%") || (ctx.level === "commune" && /^wfs_du:/.test(source.typename || ""))) {
          if (!ctx.bbox) return emptyResult(source.id, "Emprise de l'entité absente : une partition PLUi ne peut pas être restreinte à la commune");
          const [a, b, c, d] = ctx.bbox;
          cqlPrimaire += ` AND BBOX(${source.fields.find((f) => f.type === "geometry")?.key || "the_geom"}, ${a}, ${b}, ${c}, ${d}, 'EPSG:4326')`;
        }
        cqlPrimaire = await resserrer(source, ctx, cqlPrimaire);
        const lecP = await lireSource(endpoint, source, ctx, cqlPrimaire);
        const primaryResult = lecP.raw;
        if (primaryResult.features.length > 0) {
          resolvedPartition = result.primary.resolvedPartition;
          return finalizeWfsResult(source, endpoint, cqlPrimaire, primaryResult, resolvedPartition, lecP.exact);
        }
      } catch {
        // Primary a échoué (HTTP 400/404) → fallback automatique
      }

      // Fallback (ex: partition = "200067874_25056" pour un PLUi)
      // Ajouter un filtre spatial BBOX pour circonscrire à l'entité navigée
      cqlFilter = result.fallback.cql;
      if (!ctx.bbox && result.fallback.resolvedPartition.endsWith("%")) return emptyResult(source.id, "Emprise de l'entité absente : une partition PLUi ne peut pas être restreinte à la commune");
      if (ctx.bbox) {
        const [minLon, minLat, maxLon, maxLat] = ctx.bbox;
        const geomCol = source.fields.find((f) => f.type === "geometry")?.key || "the_geom";
        cqlFilter += ` AND BBOX(${geomCol}, ${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 'EPSG:4326')`;
      }
      resolvedPartition = result.fallback.resolvedPartition;
      break;
    }
    case "composite": {
      const result = buildCompositeCql(ctx, source.pivot);
      if (!result) return emptyResult(source.id, "Contexte insuffisant pour le filtre composite");
      cqlFilter = result.cql;
      break;
    }
  }

  if (cqlFilter) cqlFilter = await resserrer(source, ctx, cqlFilter);

  // 2. Ajouter les filtres utilisateur
  if (userFilters && source.userFilters) {
    const userCql = combineUserFiltersCql(source.userFilters, userFilters);
    if (userCql) {
      cqlFilter = cqlFilter ? `${cqlFilter} AND ${userCql}` : userCql;
    }
  }

  // 2 bis. Sources « par tuiles » (bâtiments) : l'ensemble EXACT du territoire (intersection avec le polygone, pas la
  // bbox qui déborde sur les communes voisines), sans plafond, chaque tuile contrôlée ; toute défaillance = erreur.
  if (source.typename === "BDTOPO_V3:batiment" && source.pivot.strategy === "spatial" && source.pivot.spatialOp === "bbox" &&
      ctx.level === "commune" && ctx.code && ctx.bbox) {
    const ens = await ensemble("batiment", TUILES_Z, "commune", ctx.code, ctx.bbox);
    const total = ens.features.length;
    const maxF = source.constraints?.maxFeaturesOverride ?? endpoint.maxFeatures;
    const res = finalizeWfsResult(source, endpoint, cqlFilter!, { features: ens.features.slice(0, maxF).map((f: any) => ({ ...f.properties })), totalCount: total }, resolvedPartition);
    if (res.layerSpec) {
      (res.layerSpec as any).tiled = { jeu: "batiment", z: TUILES_Z, niveau: "commune", code: ctx.code, bbox: ctx.bbox, expected: total };
      res.layerSpec.featureCount = total;
    }
    return res;
  }

  // 3. Exécuter la requête WFS
  const lec = await lireSource(endpoint, source, ctx, cqlFilter!);
  const rawResult = lec.raw;

  // Si tronqué et pas de totalCount, lancer un count en parallèle
  const maxFeatures = source.constraints?.maxFeaturesOverride ?? endpoint.maxFeatures;
  if (rawResult.features.length >= maxFeatures && rawResult.totalCount == null) {
    try {
      rawResult.totalCount = await countWfs(endpoint, source, cqlFilter!);
    } catch { /* count optionnel */ }
  }

  return finalizeWfsResult(source, endpoint, cqlFilter!, rawResult, resolvedPartition, lec.exact);
}

/**
 * Requête WFS count-only (resultType=hits) — retourne uniquement le nombre total.
 * Beaucoup plus rapide qu'un GetFeature complet.
 */
async function countWfs(
  endpoint: EndpointDef,
  source: SourceDef,
  cqlFilter: string,
): Promise<number> {
  const params = new URLSearchParams({
    service: "WFS",
    version: endpoint.wfsVersion ?? "2.0.0",
    request: "GetFeature",
    typeName: source.typename!,
    resultType: "hits",
    CQL_FILTER: cqlFilter,
  });
  const url = `${endpoint.baseUrl}?${params.toString()}`;
  const response = await fetchWithRetry(url, endpoint);
  const json = await response.json() as any;
  return json.numberMatched ?? json.totalFeatures ?? 0;
}

/**
 * Construit et envoie une requête WFS GetFeature.
 */
async function fetchWfs(
  endpoint: EndpointDef,
  source: SourceDef,
  cqlFilter: string,
  maxOverride?: number,
): Promise<{ features: Record<string, unknown>[]; totalCount?: number }> {
  // Champs à demander (exclure les géométries pour réduire la taille)
  const propertyNames = source.fields
    .filter((f) => f.type !== "geometry")
    .map((f) => f.key);

  // Inclure la géométrie si des champs geometry sont déclarés
  const hasGeometry = source.fields.some((f) => f.type === "geometry");

  const maxFeatures = maxOverride ?? source.constraints?.maxFeaturesOverride ?? endpoint.maxFeatures;

  const params = new URLSearchParams({
    service: "WFS",
    version: endpoint.wfsVersion ?? "2.0.0",
    request: "GetFeature",
    typeName: source.typename!,
    outputFormat: "application/json",
    CQL_FILTER: cqlFilter,
    count: String(maxFeatures),
  });

  // propertyName — toujours exclure la géométrie du fetch serveur
  // (le frontend fetch les géométries directement via layerSpec)
  if (propertyNames.length > 0) {
    params.set("propertyName", propertyNames.join(","));
  }

  params.set("srsName", "EPSG:4326");

  const url = `${endpoint.baseUrl}?${params.toString()}`;
  const response = await fetchWithRetry(url, endpoint);
  const json = await response.json() as any;

  const features = (json.features ?? []).map((f: any) => ({
    ...f.properties,
    ...(f.geometry ? { [geometryFieldName(source)]: f.geometry } : {}),
  }));

  return {
    features,
    totalCount: json.numberMatched ?? json.totalFeatures ?? undefined,
  };
}

/**
 * Finalise le résultat WFS : transformations de champs, détection troncature.
 */
function finalizeWfsResult(
  source: SourceDef,
  endpoint: EndpointDef,
  cqlFilter: string,
  raw: { features: Record<string, unknown>[]; totalCount?: number },
  resolvedPartition?: string,
  exact?: ExactInfo,
): SourceResult {
  const maxFeatures = source.constraints?.maxFeaturesOverride ?? endpoint.maxFeatures;
  const transformed = transformFeatures(raw.features, source.fields);

  // Tri par défaut si configuré
  if (source.defaultSort) {
    const { field, order } = source.defaultSort;
    transformed.sort((a, b) => {
      const va = a[field];
      const vb = b[field];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = va < vb ? -1 : 1;
      return order === "desc" ? -cmp : cmp;
    });
  }

  // Construire le layerSpec pour fetch direct côté frontend
  // (évite de transiter les géométries volumineuses par MCP)
  const hasGeometry = source.fields.some((f) => f.type === "geometry");
  let layerSpec: LayerSpec | undefined;
  if (hasGeometry && source.typename) {
    const isTruncated = raw.features.length >= maxFeatures;
    const totalFeatures = raw.totalCount ?? undefined;
    const pageSize = 1000;

    layerSpec = {
      wfsUrl: endpoint.baseUrl,
      typename: source.typename,
      cqlFilter,
      srsName: "EPSG:4326",
      maxFeatures: pageSize,
      nativeCrs: endpoint.nativeCrs,
      style: source.displayStyle,
      theme: source.theme,
      label: source.label,
      primaryFields: source.fields
        .filter((f) => f.primary && f.type !== "geometry")
        .map((f) => f.key),
      featureCount: totalFeatures ?? transformed.length,
      // Toujours paginer si tronqué — le frontend charge les pages suivantes
      ...(isTruncated ? {
        paginated: true,
        totalFeatures,
        pageSize,
      } : {}),
      // Filtres et champs pour le data-panel interactif
      filters: source.userFilters?.map((f) => ({
        key: f.key, label: f.label, type: f.type, values: f.values,
      })),
      fields: source.fields
        .filter((f) => f.type !== "geometry")
        .map((f) => ({ key: f.key, label: f.label, type: f.type, primary: f.primary, unit: f.unit, ...(f.aggregate ? { aggregate: f.aggregate } : {}) })),
    };

    if (exact) { (layerSpec as any).exact = exact; if ("gardes" in exact) layerSpec.featureCount = exact.gardes; }

    // Générer le style recipe (déterministe, instantané)
    try {
      const recipe = getStyleRecipe(source, transformed);
      layerSpec.styleRecipe = {
        paint: recipe.paint,
        linePaint: recipe.linePaint,
        geometryType: recipe.geometryType,
        legend: recipe.legend,
        classification: { ...recipe.classification, field: "field" in recipe.classification ? recipe.classification.field : null },
        labelTemplate: recipe.labelTemplate,
      };
    } catch (e) {
      // Styling non critique — continuer sans
    }
  }

  // Ne PAS inclure le geojson brut dans le résultat MCP
  // → le frontend le fetchera directement via layerSpec

  return {
    sourceId: source.id,
    success: true,
    features: transformed,
    layerSpec,
    totalCount: raw.totalCount,
    truncated: raw.features.length >= maxFeatures,
    resolvedPartition,
  };
}

// ==========================================================================
// REST Executor
// ==========================================================================

/**
 * Exécute une source REST.
 */
/** Pagination par service : taille de page maximale testée, nombre de pages lues au plus (au-delà, le résultat est déclaré partiel). */
const PAGINATION: Record<string, { sizeParam?: string; size?: number; maxPages?: number }> = {
  dvf: { sizeParam: "page_size", size: 500, maxPages: 40 }, // 500 = maximum accepté par l'API ; 40 pages = 20 000 mutations
  ademe_dpe: { sizeParam: "size", size: 1000, maxPages: 25 }, // 1000 = maximum par page ; au-delà on déclare le partiel
  rnb: { maxPages: 5 }, // pages de 20, curseur : la liste d'une commune est très longue, on déclare le partiel
};

async function executeRestSource(
  source: SourceDef,
  endpoint: EndpointDef,
  ctx: NavigationContext,
  userFilters?: Record<string, unknown>,
): Promise<SourceResult> {
  // 1. Construire les params de base (pivot)
  const pivotResult = buildRestParams(ctx, source.pivot);
  if (!pivotResult) return emptyResult(source.id, "Contexte insuffisant pour les paramètres REST");

  const params = { ...pivotResult.params };

  // 2. Ajouter les filtres utilisateur
  if (userFilters && source.userFilters) {
    const userParams = combineUserFiltersParams(source.userFilters, userFilters);
    Object.assign(params, userParams);
  }

  // 3. Construire l'URL
  let path = source.path ?? "";

  // Remplacer les placeholders {id} dans le path
  if (path.includes("{id}")) {
    const pivotValue = ctx.code;
    if (!pivotValue) return emptyResult(source.id, "Code manquant pour le placeholder {id}");
    path = path.replace("{id}", encodeURIComponent(pivotValue));
  }

  const url = new URL(`${endpoint.baseUrl}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  // Auth header si nécessaire
  if (endpoint.keyRequired && endpoint.authEnvVar && !process.env[endpoint.authEnvVar]) {
    return emptyResult(source.id, `Source indisponible : ${endpoint.id} exige une clé d'API (variable ${endpoint.authEnvVar} non définie sur le serveur) ; sans clé le service ne renvoie qu'un extrait de 10 lignes.`);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (endpoint.authEnvVar) {
    const apiKey = process.env[endpoint.authEnvVar];
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  // 4. Requête(s) : on suit la pagination du service jusqu'au bout (dans une borne), sinon on le DIT (truncated) — jamais de liste présentée comme complète si elle ne l'est pas
  const pag = PAGINATION[endpoint.id] ?? {};
  if (pag.sizeParam && pag.size && !url.searchParams.has(pag.sizeParam)) url.searchParams.set(pag.sizeParam, String(pag.size));
  const maxPages = pag.maxPages ?? 10;
  const extraire = (j: any): Record<string, unknown>[] => {
    if (endpoint.protocol === "rest_geojson" && j.features) return j.features.map((f: any) => f.properties ?? f);
    if (Array.isArray(j)) return j;
    if (j.data && Array.isArray(j.data)) return j.data;
    if (j.results && Array.isArray(j.results)) return j.results;
    if (j.etablissements && Array.isArray(j.etablissements)) return j.etablissements; // format spécifique INSEE SIRENE
    return [j]; // objet unique
  };
  const origine = new URL(endpoint.baseUrl).origin;
  const suivante = (j: any, courante: URL): URL | null => {
    if (j && typeof j.next === "string" && j.next) {
      const u = new URL(j.next); if (u.protocol === "http:") u.protocol = "https:"; // certains services annoncent « next » en http
      return u.origin === origine ? u : null; // on ne suit jamais un lien vers un autre serveur
    }
    if (j && Number.isFinite(j.total_pages) && Number.isFinite(j.page) && j.page < j.total_pages) { const u = new URL(courante.toString()); u.searchParams.set("page", String(j.page + 1)); return u; }
    return null;
  };
  let json = await (await fetchWithRetry(url.toString(), endpoint, headers)).json() as any;
  const rawFeatures: Record<string, unknown>[] = [...extraire(json)];
  const premier = json;
  let courante = url, pages = 1, reste: URL | null = suivante(json, courante);
  while (reste && pages < maxPages) {
    courante = reste; json = await (await fetchWithRetry(courante.toString(), endpoint, headers)).json() as any;
    rawFeatures.push(...extraire(json)); pages++; reste = suivante(json, courante);
  }
  const incomplet = reste !== null; // il reste des pages que l'on n'a pas lues
  const totalAnnonce = premier.count ?? premier.total ?? premier.header?.total ?? (typeof premier.results === "number" ? premier.results : undefined);

  // 5. (extraction faite ci-dessus)

  // 6. Transformer
  const transformed = transformFeatures(rawFeatures, source.fields);

  // Tri par défaut
  if (source.defaultSort) {
    const { field, order } = source.defaultSort;
    transformed.sort((a, b) => {
      const va = a[field];
      const vb = b[field];
      if (va === vb) return 0;
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      const cmp = va < vb ? -1 : 1;
      return order === "desc" ? -cmp : cmp;
    });
  }

  // Construire un layerSpec inline si la source a des champs de coordonnées
  // On utilise rawFeatures (avant transformation) pour accéder aux coordonnées
  // même si elles ne sont pas déclarées dans source.fields
  let layerSpec: LayerSpec | undefined;
  let sansPosition = 0;
  const raw_valeur = (r: Record<string, unknown>, k: string): string | null => (r[k] == null ? null : String(r[k]).slice(0, 80));
  // Une liste incomplète n'est jamais cartographiée : l'interface ne sait pas signaler ce manque, le texte de réponse le fait.
  if (source.geoPointField && rawFeatures.length > 0 && !(incomplet || (totalAnnonce != null && rawFeatures.length < totalAnnonce))) {
    const cle = source.geoPointField;
    const lire = (v: unknown): [number, number] | null => {
      if (typeof v !== "string") return null;
      const m = v.split(",").map((x) => Number(x.trim()));
      if (m.length !== 2 || !m.every(Number.isFinite)) return null;
      const [la, lo] = m;
      return Math.abs(la) <= 90 && Math.abs(lo) <= 180 ? [lo, la] : null;
    };
    // Positions aberrantes : un lot de diagnostics d'une même commune ne s'étale pas sur plus de 50 km ; au-delà (ex. coordonnées
    // d'ADEME à (-1,36 ; -5,98), en plein golfe de Guinée, pour une adresse d'Aubagne), la position est fausse : on l'écarte et on le dit.
    const lus = rawFeatures.map((raw) => lire(raw[cle]));
    // DPE : les diagnostics d'une même adresse (BAN) partagent exactement le même point. On dénombre les superpositions (sur la valeur brute
    // du point) pour qu'elles se lisent au lieu d'être cachées : un seul point peut porter plusieurs diagnostics.
    const parPoint = new Map<string, number>();
    if (source.id === "energie_dpe_ademe_commune") for (const raw of rawFeatures) { const k = raw[cle]; if (typeof k === "string") parPoint.set(k, (parPoint.get(k) ?? 0) + 1); }
    if (parPoint.size) rawFeatures.forEach((raw, i) => { const k = raw[cle]; if (transformed[i] && typeof k === "string") (transformed[i] as Record<string, unknown>).meme_position = parPoint.get(k) ?? null; });
    const med = (v: number[]) => { const t = [...v].sort((x, y) => x - y); return t[Math.floor(t.length / 2)]; };
    const valides = lus.filter((c): c is [number, number] => !!c);
    const mLo = valides.length ? med(valides.map((c) => c[0])) : 0, mLa = valides.length ? med(valides.map((c) => c[1])) : 0;
    const loinKm = (c: [number, number]) => Math.hypot((c[0] - mLo) * 111.32 * Math.cos(mLa * Math.PI / 180), (c[1] - mLa) * 110.54);
    // Toutes les lignes sont gardées (le total de la commune reste le vrai) : sans position fiable, geometry = null (jamais replacée).
    const cleId = source.fields.find((f) => f.primary && f.type !== "geometry")?.key;
    const anomalies: NonNullable<LayerSpec["anomalies"]> = [];
    const geoFeatures = rawFeatures
      .map((raw, i) => ({ c: lus[i] && loinKm(lus[i]!) <= 50 ? lus[i] : null, props: transformed[i] ?? {} }))
      .map(({ c, props }, i) => { if (!c) { sansPosition++; const brut = raw_valeur(rawFeatures[i], cle); const d = lus[i] ? Math.round(loinKm(lus[i]!) * 10) / 10 : undefined;
        anomalies.push({ ligne: i, id: cleId && props[cleId] != null ? String(props[cleId]) : null, raison: lus[i] ? "position à plus de 50 km des autres de la commune" : "coordonnées absentes ou invalides", valeur: brut, ...(d !== undefined ? { distanceKm: d } : {}) }); } return { type: "Feature" as const, id: i, geometry: c ? { type: "Point" as const, coordinates: c as [number, number] } : null, properties: props }; });
    if (geoFeatures.length > sansPosition) {
      layerSpec = {
        type: "inline",
        inlineGeojson: { type: "FeatureCollection", features: geoFeatures },
        wfsUrl: "", typename: "", cqlFilter: "", srsName: "EPSG:4326",
        maxFeatures: geoFeatures.length,
        theme: source.theme, label: source.label,
        primaryFields: source.fields.filter((f) => f.primary && f.type !== "geometry").map((f) => f.key),
        fields: source.fields.filter((f) => f.type !== "geometry").map((f) => ({ key: f.key, label: f.label, type: f.type, primary: f.primary, unit: f.unit, ...(f.aggregate ? { aggregate: f.aggregate } : {}) })),
        featureCount: geoFeatures.length,
        ...(sansPosition ? { ecartees: sansPosition, anomalies } : {}),
      };
      try {
        const recipe = getStyleRecipe(source, transformed);
        layerSpec.styleRecipe = { paint: recipe.paint, linePaint: recipe.linePaint, geometryType: recipe.geometryType, legend: recipe.legend,
          classification: { ...recipe.classification, field: "field" in recipe.classification ? recipe.classification.field : null }, labelTemplate: recipe.labelTemplate };
      } catch (e) { /* style non critique */ }
    }
  }
  if (source.geoFields && rawFeatures.length > 0) {
    const { lon, lat } = source.geoFields;
    const geoFeatures = rawFeatures
      .map((raw, i) => ({ raw, props: transformed[i] ?? {} }))
      .filter(({ raw }) => raw[lon] != null && raw[lat] != null)
      .map(({ raw, props }, i) => ({
        type: "Feature" as const,
        id: i,
        geometry: {
          type: "Point" as const,
          coordinates: [Number(raw[lon]), Number(raw[lat])],
        },
        properties: props,
      }));

    if (geoFeatures.length > 0) {
      layerSpec = {
        type: "inline",
        inlineGeojson: { type: "FeatureCollection", features: geoFeatures },
        wfsUrl: "",
        typename: "",
        cqlFilter: "",
        srsName: "EPSG:4326",
        maxFeatures: geoFeatures.length,
        theme: source.theme,
        label: source.label,
        primaryFields: source.fields
          .filter((f) => f.primary && f.type !== "geometry")
          .map((f) => f.key),
        featureCount: geoFeatures.length,
        fields: source.fields.filter((f) => f.type !== "geometry").map((f) => ({ key: f.key, label: f.label, type: f.type, primary: f.primary, unit: f.unit, ...(f.aggregate ? { aggregate: f.aggregate } : {}) })),
      };

      // Style recipe pour sources REST inline
      try {
        const recipe = getStyleRecipe(source, transformed);
        layerSpec.styleRecipe = {
          paint: recipe.paint,
          linePaint: recipe.linePaint,
          geometryType: recipe.geometryType,
          legend: recipe.legend,
          classification: { ...recipe.classification, field: "field" in recipe.classification ? recipe.classification.field : null },
          labelTemplate: recipe.labelTemplate,
        };
      } catch (e) {
        // Styling non critique
      }
    }
  }

  return {
    sourceId: source.id,
    success: true,
    features: transformed,
    layerSpec,
    totalCount: totalAnnonce ?? (incomplet ? undefined : rawFeatures.length),
    sansPosition: sansPosition || undefined,
    truncated: incomplet || (totalAnnonce != null && rawFeatures.length < totalAnnonce) || (!totalAnnonce && rawFeatures.length >= endpoint.maxFeatures),
  };
}

// ==========================================================================
// Utilitaires
// ==========================================================================

/**
 * Fetch avec retry et backoff exponentiel.
 */
async function fetchWithRetry(
  url: string,
  endpoint: EndpointDef,
  headers?: Record<string, string>,
): Promise<Response> {
  const { maxRetries, initialDelayMs, retryOnStatus } = endpoint.retry;
  let lastError: Error | null = null;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), endpoint.timeoutMs);

      const response = await fetch(url, {
        headers,
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (response.ok) return response;

      if (retryOnStatus.includes(response.status) && attempt < maxRetries - 1) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }

      throw new Error(
        `HTTP ${response.status} ${response.statusText} — ${endpoint.id}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.name === "AbortError") {
        // un délai dépassé est réessayé comme toute autre panne passagère ; échec explicite seulement après la dernière tentative
        if (attempt < maxRetries - 1) { await sleep(initialDelayMs * Math.pow(2, attempt)); lastError = new Error(`Timeout (${endpoint.timeoutMs}ms) — ${endpoint.id}`); continue; }
        throw new Error(`Timeout (${endpoint.timeoutMs}ms) après ${maxRetries} tentatives — ${endpoint.id}`);
      }

      if (attempt < maxRetries - 1) {
        const delay = initialDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
    }
  }

  throw lastError ?? new Error(`Échec après ${maxRetries} tentatives — ${endpoint.id}`);
}

/**
 * Résultat vide avec message d'erreur explicatif.
 */
function emptyResult(sourceId: string, error: string): SourceResult {
  return { sourceId, success: false, error, features: [] };
}

/**
 * Nom du champ géométrie dans une source.
 */
function geometryFieldName(source: SourceDef): string {
  const geomField = source.fields.find((f) => f.type === "geometry");
  return geomField?.key ?? "the_geom";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
