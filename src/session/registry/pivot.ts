/**
 * geocontext — Pivot Resolution
 *
 * Résout les stratégies de pivot : transforme un contexte de navigation
 * et une PivotStrategy en filtre concret (CQL pour WFS, query params pour REST).
 *
 * Les 4 stratégies :
 *
 *   attribute              — filtre attributaire simple
 *                            Ex: code_insee = '25349'
 *
 *   spatial                — filtre spatial BBOX ou INTERSECTS
 *                            Ex: BBOX(geom, 6.1, 47.2, 6.3, 47.4)
 *
 *   attribute_with_fallback — essai attributaire, puis fallback si 0 résultats
 *                            Ex: partition = '25349' → partition = '200067874_25349'
 *
 *   composite              — plusieurs attributs combinés (AND)
 *                            Ex: code_dep = '25' AND code_com = '349'
 *
 * @see docs/terrid-spec.md — contraintes techniques (partition, SIREN, spatial-only)
 */

import type {
  PivotStrategy,
  PivotFrom,
  AttributePivot,
  SpatialPivot,
  AttributeWithFallbackPivot,
  CompositePivot,
  CRS,
} from "./types.js";
import type { NavigationContext, Hierarchy } from "../types.js";

// ==========================================================================
// Valeur extraite du contexte
// ==========================================================================

/**
 * Extrait une valeur scalaire du contexte selon un chemin PivotFrom.
 *
 * @param ctx   — contexte de navigation courant
 * @param from  — chemin vers la valeur (ex: "context.code", "hierarchy.epci.siren")
 * @returns la valeur extraite, ou null si le chemin n'est pas résolu
 *
 * @example
 *   extractPivotValue(ctx, "context.code")           → "25349"
 *   extractPivotValue(ctx, "hierarchy.epci.siren")    → "200067874"
 *   extractPivotValue(ctx, "hierarchy.batiment.id")   → "A1B2-C3D4-E5F6"
 */
export function extractPivotValue(
  ctx: NavigationContext,
  from: PivotFrom,
): string | null {
  switch (from) {
    case "context.code":
      return ctx.code;
    case "context.bbox":
      return ctx.bbox ? ctx.bbox.join(",") : null;
    case "context.geometry":
      // La géométrie n'est pas scalaire — retourne null ici.
      // Les filtres spatiaux utilisent resolveGeometry() directement.
      return null;
    case "hierarchy.commune.code":
      return ctx.hierarchy.commune?.code ?? null;
    case "hierarchy.departement.code":
      return ctx.hierarchy.departement?.code ?? null;
    case "hierarchy.region.code":
      return ctx.hierarchy.region?.code ?? null;
    case "hierarchy.epci.siren":
      return ctx.hierarchy.epci?.siren ?? null;
    case "hierarchy.parcelle.idpar":
      return ctx.hierarchy.parcelle?.idpar ?? null;
    case "hierarchy.batiment.id":
      return ctx.hierarchy.batiment?.id ?? null;
    default: {
      // Exhaustivité TypeScript — si un nouveau PivotFrom est ajouté
      // sans handler, le compilateur signale l'erreur ici.
      const _exhaustive: never = from;
      return null;
    }
  }
}

// ==========================================================================
// Filtre CQL (pour WFS)
// ==========================================================================

/**
 * Résultat de la résolution d'un pivot en filtre CQL.
 */
export interface CqlFilterResult {
  /** Filtre CQL prêt à envoyer (ex: "code_insee = '25349'") */
  cql: string;
  /** Si fallback utilisé, le format résolu (pour mise en cache) */
  resolvedPartition?: string;
}

/**
 * Construit un filtre CQL à partir d'un AttributePivot.
 *
 * @returns filtre CQL, ou null si la valeur n'est pas disponible dans le contexte
 *
 * @example
 *   buildAttributeCql(ctx, { strategy: "attribute", attribute: "code_insee", from: "context.code" })
 *   → { cql: "code_insee = '25349'" }
 */
export function buildAttributeCql(
  ctx: NavigationContext,
  pivot: AttributePivot,
): CqlFilterResult | null {
  const raw = extractPivotValue(ctx, pivot.from);
  if (raw === null) return null;
  const value = pivot.valuePrefix ? `${pivot.valuePrefix}${raw}` : raw;
  return { cql: `${pivot.attribute} = '${escapeCql(value)}'` };
}

/**
 * Construit un filtre CQL spatial (BBOX ou INTERSECTS).
 *
 * Pour BBOX : BBOX(geom, minx, miny, maxx, maxy, 'CRS')
 * Pour INTERSECTS : nécessite la géométrie GeoJSON du territoire,
 * passée séparément (pas dans le contexte).
 *
 * @param ctx           — contexte de navigation
 * @param pivot         — stratégie spatiale
 * @param geometry      — géométrie GeoJSON pour INTERSECTS (optionnel)
 * @param targetCrs     — CRS cible du serveur (pour reprojection de la bbox)
 * @returns filtre CQL, ou null si la bbox/géométrie n'est pas disponible
 */
export function buildSpatialCql(
  ctx: NavigationContext,
  pivot: SpatialPivot,
  geometry?: GeoJSON.Geometry | null,
  targetCrs?: CRS,
): CqlFilterResult | null {
  const geomCol = pivot.geometryColumn ?? "the_geom";

  if (pivot.spatialOp === "bbox") {
    if (!ctx.bbox) return null;
    const [minLon, minLat, maxLon, maxLat] = ctx.bbox;
    // Le CRS est explicité ('EPSG:4326') pour éviter que certains serveurs WFS
    // interprètent les coordonnées dans leur CRS natif (ex: EPSG:2154).
    return {
      cql: `BBOX(${geomCol}, ${minLon}, ${minLat}, ${maxLon}, ${maxLat}, 'EPSG:4326')`,
    };
  }

  if (pivot.spatialOp === "intersects") {
    if (!geometry) return null;
    // Conversion GeoJSON geometry → WKT pour le filtre CQL INTERSECTS
    const wkt = geojsonToWkt(geometry);
    return {
      cql: `INTERSECTS(${geomCol}, ${wkt})`,
    };
  }

  return null;
}

/**
 * Construit les filtres CQL pour un AttributeWithFallbackPivot.
 *
 * Retourne deux variantes : la primaire et la fallback.
 * L'executor essaie la primaire ; si 0 résultats, il essaie la fallback.
 *
 * @example
 *   // Partition urbanisme : essai code_insee, puis siren_code_insee
 *   buildFallbackCql(ctx, pivot)
 *   → { primary: "partition = '25349'", fallback: "partition = '200067874_25349'" }
 */
export function buildFallbackCql(
  ctx: NavigationContext,
  pivot: AttributeWithFallbackPivot,
): { primary: CqlFilterResult; fallback: CqlFilterResult } | null {
  // Vérifier si un format est déjà en cache
  const cached = ctx.data[pivot.cacheKey] as string | undefined;
  if (cached) {
    return {
      primary: { cql: `${pivot.attribute} = '${escapeCql(cached)}'`, resolvedPartition: cached },
      fallback: { cql: `${pivot.attribute} = '${escapeCql(cached)}'`, resolvedPartition: cached },
    };
  }

  // Construire la valeur primaire
  const primaryRaw = extractPivotValue(ctx, pivot.primary.from);
  if (primaryRaw === null) return null;
  const primaryValue = pivot.valuePrefix ? `${pivot.valuePrefix}${primaryRaw}` : primaryRaw;

  // Construire la valeur fallback (concaténation de plusieurs sources)
  const fallbackParts = pivot.fallback.from.map((f) => extractPivotValue(ctx, f));
  if (fallbackParts.some((p) => p === null)) return null;
  const fallbackRaw = fallbackParts.join(pivot.fallback.separator);
  const fallbackValue = pivot.valuePrefix ? `${pivot.valuePrefix}${fallbackRaw}` : fallbackRaw;

  return {
    primary: {
      cql: `${pivot.attribute} = '${escapeCql(primaryValue)}'`,
      resolvedPartition: primaryValue,
    },
    fallback: {
      cql: `${pivot.attribute} = '${escapeCql(fallbackValue)}'`,
      resolvedPartition: fallbackValue,
    },
  };
}

/**
 * Construit un filtre CQL composite (AND de plusieurs attributs).
 *
 * @example
 *   buildCompositeCql(ctx, { parts: [
 *     { attribute: "code_dep", from: "hierarchy.departement.code" },
 *     { attribute: "code_com", from: "context.code" },
 *   ]})
 *   → { cql: "code_dep = '25' AND code_com = '349'" }
 */
export function buildCompositeCql(
  ctx: NavigationContext,
  pivot: CompositePivot,
): CqlFilterResult | null {
  const clauses: string[] = [];
  for (const part of pivot.parts) {
    const value = extractPivotValue(ctx, part.from);
    if (value === null) return null;
    clauses.push(`${part.attribute} = '${escapeCql(value)}'`);
  }
  return { cql: clauses.join(" AND ") };
}

// ==========================================================================
// Paramètres REST (pour APIs REST)
// ==========================================================================

/**
 * Résultat de la résolution d'un pivot en paramètres REST.
 */
export interface RestParamsResult {
  /** Paramètres query à ajouter à l'URL */
  params: Record<string, string>;
  /** Si fallback utilisé, la valeur résolue */
  resolvedPartition?: string;
}

/**
 * Résout un pivot en paramètres REST (query string).
 *
 * Gère les stratégies attribute et composite.
 * Les stratégies spatial et fallback sont gérées spécifiquement par l'executor REST.
 */
export function buildRestParams(
  ctx: NavigationContext,
  pivot: PivotStrategy,
): RestParamsResult | null {
  switch (pivot.strategy) {
    case "attribute": {
      const value = extractPivotValue(ctx, pivot.from);
      if (value === null) return null;
      return { params: { [pivot.attribute]: value } };
    }
    case "composite": {
      const params: Record<string, string> = {};
      for (const part of pivot.parts) {
        const value = extractPivotValue(ctx, part.from);
        if (value === null) return null;
        params[part.attribute] = value;
      }
      return { params };
    }
    case "spatial": {
      // Pour REST, le spatial se traduit en params lon/lat ou bbox
      if (pivot.from === "context.bbox" && ctx.bbox) {
        const [minLon, minLat, maxLon, maxLat] = ctx.bbox;
        return {
          params: { bbox: `${minLon},${minLat},${maxLon},${maxLat}` },
        };
      }
      return null;
    }
    case "attribute_with_fallback": {
      // Pour REST, on essaie la valeur primaire. Le fallback est géré par l'executor.
      const value = extractPivotValue(ctx, pivot.primary.from);
      if (value === null) return null;
      return { params: { [pivot.attribute]: value } };
    }
    default:
      return null;
  }
}

// ==========================================================================
// Utilitaires
// ==========================================================================

/**
 * Échappe une valeur pour inclusion dans un filtre CQL.
 * Protège contre l'injection CQL (quotes simples).
 */
export function escapeCql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * Convertit une géométrie GeoJSON en WKT (Well-Known Text).
 *
 * Supporte : Point, LineString, Polygon, MultiPolygon.
 * Utilisé pour les filtres CQL INTERSECTS.
 */
export function geojsonToWkt(geometry: GeoJSON.Geometry): string {
  switch (geometry.type) {
    case "Point": {
      const [x, y] = geometry.coordinates;
      return `POINT(${x} ${y})`;
    }
    case "LineString": {
      const coords = geometry.coordinates.map(([x, y]) => `${x} ${y}`).join(", ");
      return `LINESTRING(${coords})`;
    }
    case "Polygon": {
      const rings = geometry.coordinates
        .map((ring) => `(${ring.map(([x, y]) => `${x} ${y}`).join(", ")})`)
        .join(", ");
      return `POLYGON(${rings})`;
    }
    case "MultiPolygon": {
      const polygons = geometry.coordinates
        .map(
          (polygon) =>
            `(${polygon.map((ring) => `(${ring.map(([x, y]) => `${x} ${y}`).join(", ")})`).join(", ")})`,
        )
        .join(", ");
      return `MULTIPOLYGON(${polygons})`;
    }
    case "MultiPoint": {
      const points = geometry.coordinates.map(([x, y]) => `(${x} ${y})`).join(", ");
      return `MULTIPOINT(${points})`;
    }
    case "MultiLineString": {
      const lines = geometry.coordinates
        .map((line) => `(${line.map(([x, y]) => `${x} ${y}`).join(", ")})`)
        .join(", ");
      return `MULTILINESTRING(${lines})`;
    }
    case "GeometryCollection": {
      const geoms = geometry.geometries.map(geojsonToWkt).join(", ");
      return `GEOMETRYCOLLECTION(${geoms})`;
    }
    default:
      throw new Error(`[pivot] Type de géométrie non supporté : ${(geometry as any).type}`);
  }
}
