/**
 * Fetch GeoJSON direct depuis Géoplateforme + reprojection.
 *
 * Le serveur MCP retourne des layerSpecs (URL, typename, CQL, style, theme…)
 * mais PAS le GeoJSON brut (trop volumineux pour le transport MCP).
 *
 * Ce module :
 *   1. Construit l'URL WFS GetFeature depuis le layerSpec
 *   2. Fetch le GeoJSON directement depuis Géoplateforme
 *   3. Reprojette de EPSG:2154 → 4326 si nécessaire
 *   4. Ajoute la couche sur la carte MapLibre avec style thématique
 */

// Typenames ADMINEXPRESS par niveau territorial
const ADMINEXPRESS_TYPENAMES = {
  commune:    { typename: "ADMINEXPRESS-COG.LATEST:commune",    field: "code_insee" },
  departement:{ typename: "ADMINEXPRESS-COG.LATEST:departement", field: "code_insee" },
  region:     { typename: "ADMINEXPRESS-COG.LATEST:region",      field: "code_insee" },
  epci:       { typename: "ADMINEXPRESS-COG.LATEST:epci",        field: "code_siren" },
};

const GPF_WFS_URL = "https://data.geopf.fr/wfs/ows";

const GeoFetcher = {
  /**
   * Traite un résultat MCP tool call et extrait les layerSpecs.
   * Retourne null si pas de layerSpecs dans la réponse.
   */
  extractLayerSpecs(result) {
    if (!result?.content) return null;

    for (const block of result.content) {
      if (block.type !== "text") continue;
      try {
        const parsed = JSON.parse(block.text);
        if (parsed._type === "layerSpecs" && parsed.layers) {
          return parsed.layers;
        }
      } catch {
        // Pas du JSON — c'est le texte pour le LLM, on ignore
      }
    }
    return null;
  },

  /**
   * Fetch le GeoJSON, ajoute les couches sur la carte, et retourne les features.
   * @param {Object} layerSpecs - Map de { sourceId: LayerSpec }
   * @returns {Array<{ sourceId, label, features, primaryFields }>}
   */
  async loadLayers(layerSpecs) {
    const promises = Object.entries(layerSpecs).map(([sourceId, spec]) =>
      this._fetchAndDisplay(sourceId, spec),
    );
    const results = await Promise.allSettled(promises);
    // Retourner les layers chargés avec succès (pour DataPanel)
    return results
      .map(r => r.status === "fulfilled" ? r.value : null)
      .filter(Boolean);
  },

  /**
   * Charge et affiche le contour du territoire courant sur la carte.
   * @param {{ level: string, code: string }} ctx
   */
  async loadTerritoryBoundary(ctx) {
    if (!ctx || !ctx.level || !ctx.code) return;
    const def = ADMINEXPRESS_TYPENAMES[ctx.level];
    if (!def) return; // parcelle, point, etc. : pas de boundary ADMINEXPRESS

    try {
      const params = new URLSearchParams({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        typeName: def.typename,
        outputFormat: "application/json",
        CQL_FILTER: `${def.field}='${ctx.code}'`,
        srsName: "EPSG:4326",
      });

      const response = await fetch(`${GPF_WFS_URL}?${params.toString()}`);
      if (!response.ok) return;

      const geojson = await response.json();
      if (geojson.features && geojson.features.length > 0) {
        GeoMap.addTerritoryBoundary(geojson);
      }
    } catch (err) {
      console.warn(`[geo-fetcher] boundary ${ctx.level}/${ctx.code}: ${err.message}`);
    }
  },

  /**
   * Fetch une couche (WFS ou inline) et l'affiche sur la carte.
   * Retourne { sourceId, label, features, primaryFields } si succès.
   */
  async _fetchAndDisplay(sourceId, spec) {
    try {
      let geojson;

      if (spec.type === "inline") {
        // GeoJSON embarqué directement dans le layerSpec (ex: ICPE, points REST)
        geojson = spec.inlineGeojson;
      } else {
        // WFS fetch depuis Géoplateforme
        const url = this._buildWfsUrl(spec);
        const response = await fetch(url);
        if (!response.ok) {
          console.warn(`[geo-fetcher] ${sourceId}: HTTP ${response.status}`);
          return null;
        }
        geojson = await response.json();

        // Reprojection si nécessaire
        if (spec.nativeCrs && spec.nativeCrs !== "EPSG:4326") {
          geojson = this._reproject(geojson, spec.nativeCrs);
        }
      }

      if (geojson?.features && geojson.features.length > 0) {
        const meta = {
          label: spec.label || sourceId,
          primaryFields: spec.primaryFields || [],
          theme: spec.theme || null,
        };
        GeoMap.addGeoJsonLayer(sourceId, geojson, spec.style || {}, meta);
        console.log(`[geo-fetcher] ${sourceId}: ${geojson.features.length} features chargées`);
        return { sourceId, label: spec.label || sourceId, features: geojson.features, primaryFields: spec.primaryFields || [] };
      }
      return null;
    } catch (err) {
      console.warn(`[geo-fetcher] ${sourceId}: ${err.message}`);
      return null;
    }
  },

  /**
   * Construit l'URL WFS GetFeature depuis un LayerSpec.
   */
  _buildWfsUrl(spec) {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: spec.typename,
      outputFormat: "application/json",
      CQL_FILTER: spec.cqlFilter,
      count: String(spec.maxFeatures || 1000),
      srsName: spec.srsName || "EPSG:4326",
    });

    return `${spec.wfsUrl}?${params.toString()}`;
  },

  /**
   * Reprojette un GeoJSON de EPSG:2154 (Lambert-93) vers EPSG:4326.
   */
  _reproject(geojson, fromCrs) {
    if (fromCrs !== "EPSG:2154") {
      console.warn(`[geo-fetcher] Reprojection non supportée pour ${fromCrs}`);
      return geojson;
    }

    const firstCoord = this._getFirstCoord(geojson);
    if (!firstCoord || firstCoord[0] < 10000) {
      return geojson;
    }

    return this._transformCoords(geojson, (coord) => {
      return lambert93ToWgs84(coord[0], coord[1]);
    });
  },

  _getFirstCoord(geojson) {
    const features = geojson.features || [];
    if (features.length === 0) return null;
    const geom = features[0].geometry;
    if (!geom) return null;
    let coords = geom.coordinates;
    while (Array.isArray(coords[0])) coords = coords[0];
    return coords;
  },

  _transformCoords(geojson, fn) {
    const result = JSON.parse(JSON.stringify(geojson));
    for (const feature of result.features || []) {
      if (feature.geometry) {
        feature.geometry.coordinates = this._walkCoords(feature.geometry.coordinates, fn);
      }
    }
    return result;
  },

  _walkCoords(coords, fn) {
    if (typeof coords[0] === "number") return fn(coords);
    return coords.map((c) => this._walkCoords(c, fn));
  },
};

/**
 * Lambert-93 (EPSG:2154) → WGS84 (EPSG:4326).
 * Approximation suffisante pour l'affichage cartographique (~10m).
 */
function lambert93ToWgs84(x, y) {
  const n = 0.7256077650;
  const C = 11754255.426;
  const Xs = 700000.0;
  const Ys = 12655612.050;
  const e = 0.0818191910428;

  const R = Math.sqrt((x - Xs) * (x - Xs) + (Ys - y) * (Ys - y));
  const gamma = Math.atan((x - Xs) / (Ys - y));
  const latIso = -Math.log(R / C) / n;
  const lon = gamma / n + (3 * Math.PI) / 180;

  let lat = 2 * Math.atan(Math.exp(latIso)) - Math.PI / 2;
  for (let i = 0; i < 5; i++) {
    lat = 2 * Math.atan(Math.exp(latIso + e * Math.atanh(e * Math.sin(lat)))) - Math.PI / 2;
  }

  return [lon * (180 / Math.PI), lat * (180 / Math.PI)];
}

if (!Math.atanh) {
  Math.atanh = function (x) { return Math.log((1 + x) / (1 - x)) / 2; };
}

window.GeoFetcher = GeoFetcher;
