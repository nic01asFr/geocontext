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

      // Essai primaire
      const primaryResult = await fetchWfs(endpoint, source, result.primary.cql);
      if (primaryResult.features.length > 0) {
        resolvedPartition = result.primary.resolvedPartition;
        return finalizeWfsResult(source, endpoint, result.primary.cql, primaryResult, resolvedPartition);
      }

      // Fallback
      cqlFilter = result.fallback.cql;
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

  // 2. Ajouter les filtres utilisateur
  if (userFilters && source.userFilters) {
    const userCql = combineUserFiltersCql(source.userFilters, userFilters);
    if (userCql) {
      cqlFilter = cqlFilter ? `${cqlFilter} AND ${userCql}` : userCql;
    }
  }

  // 3. Exécuter la requête WFS
  const rawResult = await fetchWfs(endpoint, source, cqlFilter!);
  return finalizeWfsResult(source, endpoint, cqlFilter!, rawResult, resolvedPartition);
}

/**
 * Construit et envoie une requête WFS GetFeature.
 */
async function fetchWfs(
  endpoint: EndpointDef,
  source: SourceDef,
  cqlFilter: string,
): Promise<{ features: Record<string, unknown>[]; totalCount?: number }> {
  // Champs à demander (exclure les géométries pour réduire la taille)
  const propertyNames = source.fields
    .filter((f) => f.type !== "geometry")
    .map((f) => f.key);

  // Inclure la géométrie si des champs geometry sont déclarés
  const hasGeometry = source.fields.some((f) => f.type === "geometry");

  const maxFeatures = source.constraints?.maxFeaturesOverride ?? endpoint.maxFeatures;

  const params = new URLSearchParams({
    service: "WFS",
    version: endpoint.wfsVersion ?? "2.0.0",
    request: "GetFeature",
    typeName: source.typename!,
    outputFormat: "application/json",
    CQL_FILTER: cqlFilter,
    count: String(maxFeatures),
  });

  // propertyName — seulement si on veut limiter les champs
  if (propertyNames.length > 0 && !hasGeometry) {
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
    // Style par défaut selon le thème
    const style = source.displayStyle ?? {
      color: "#5b8def",
      opacity: 0.3,
      stroke: "#3a6bd5",
      strokeWidth: 1.5,
    };

    layerSpec = {
      wfsUrl: endpoint.baseUrl,
      typename: source.typename,
      cqlFilter,
      srsName: "EPSG:4326",
      maxFeatures,
      nativeCrs: endpoint.nativeCrs,
      style,
    };
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
  const headers: Record<string, string> = { Accept: "application/json" };
  if (endpoint.authEnvVar) {
    const apiKey = process.env[endpoint.authEnvVar];
    if (apiKey) {
      headers["Authorization"] = `Bearer ${apiKey}`;
    }
  }

  // 4. Requête
  const response = await fetchWithRetry(url.toString(), endpoint, headers);
  const json = await response.json() as any;

  // 5. Extraire les features selon le format de réponse
  let rawFeatures: Record<string, unknown>[];

  if (endpoint.protocol === "rest_geojson" && json.features) {
    // GeoJSON FeatureCollection
    rawFeatures = json.features.map((f: any) => f.properties ?? f);
  } else if (Array.isArray(json)) {
    rawFeatures = json;
  } else if (json.data && Array.isArray(json.data)) {
    rawFeatures = json.data;
  } else if (json.results && Array.isArray(json.results)) {
    rawFeatures = json.results;
  } else if (json.etablissements && Array.isArray(json.etablissements)) {
    // Format spécifique INSEE SIRENE
    rawFeatures = json.etablissements;
  } else {
    // Objet unique → tableau d'un élément
    rawFeatures = [json];
  }

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

  return {
    sourceId: source.id,
    success: true,
    features: transformed,
    totalCount: json.total ?? json.header?.total ?? rawFeatures.length,
    truncated: rawFeatures.length >= endpoint.maxFeatures,
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
        `HTTP ${response.status} ${response.statusText} — ${endpoint.id} — ${url.substring(0, 200)}`,
      );
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));

      if (lastError.name === "AbortError") {
        throw new Error(`Timeout (${endpoint.timeoutMs}ms) — ${endpoint.id}`);
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
