/**
 * Fetch GeoJSON direct depuis Géoplateforme + reprojection.
 *
 * Le serveur MCP retourne des layerSpecs (URL, typename, CQL, style)
 * mais PAS le GeoJSON brut (trop volumineux pour le transport MCP).
 *
 * Ce module :
 *   1. Construit l'URL WFS GetFeature depuis le layerSpec
 *   2. Fetch le GeoJSON directement depuis Géoplateforme
 *   3. Reprojette de EPSG:2154 → 4326 si nécessaire (proj4)
 *   4. Ajoute la couche sur la carte MapLibre
 */

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
   * Fetch le GeoJSON et ajoute les couches sur la carte.
   *
   * @param {Object} layerSpecs - Map de { sourceId: LayerSpec }
   */
  async loadLayers(layerSpecs) {
    const promises = Object.entries(layerSpecs).map(([sourceId, spec]) =>
      this._fetchAndDisplay(sourceId, spec),
    );
    await Promise.allSettled(promises);
  },

  /**
   * Fetch une couche WFS et l'affiche sur la carte.
   */
  async _fetchAndDisplay(sourceId, spec) {
    try {
      const url = this._buildWfsUrl(spec);
      const response = await fetch(url);

      if (!response.ok) {
        console.warn(`[geo-fetcher] ${sourceId}: HTTP ${response.status}`);
        return;
      }

      let geojson = await response.json();

      // Reprojection si nécessaire
      if (spec.nativeCrs && spec.nativeCrs !== "EPSG:4326") {
        geojson = this._reproject(geojson, spec.nativeCrs);
      }

      // Ajouter sur la carte
      if (geojson.features && geojson.features.length > 0) {
        GeoMap.addGeoJsonLayer(sourceId, geojson, spec.style || {});
        console.log(
          `[geo-fetcher] ${sourceId}: ${geojson.features.length} features chargées`,
        );
      }
    } catch (err) {
      console.warn(`[geo-fetcher] ${sourceId}: ${err.message}`);
      // Notifier l'UI (le chat affiche l'erreur)
      if (window.Chat) {
        Chat.addMessage("system", `Couche "${sourceId}" : chargement échoué (${err.message})`);
      }
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
   *
   * Utilise une projection simplifiée pour Lambert-93 :
   *   - Suffisante pour l'affichage cartographique
   *   - Pas de dépendance externe (proj4js)
   *
   * Pour les cas où srsName=EPSG:4326 est demandé au WFS,
   * le serveur fait la reprojection lui-même. Cette fonction
   * est un filet de sécurité pour les endpoints qui ne supportent
   * pas la reprojection côté serveur.
   */
  _reproject(geojson, fromCrs) {
    // La plupart des endpoints GPF supportent srsName=EPSG:4326
    // et font la reprojection côté serveur. On demande toujours
    // EPSG:4326 dans le layerSpec. Mais si le GeoJSON revient
    // en Lambert-93, on reprojette ici.

    if (fromCrs !== "EPSG:2154") {
      console.warn(`[geo-fetcher] Reprojection non supportée pour ${fromCrs}`);
      return geojson;
    }

    // Vérifier si les coordonnées sont en Lambert-93 (x > 100000)
    const firstCoord = this._getFirstCoord(geojson);
    if (!firstCoord || firstCoord[0] < 10000) {
      // Déjà en EPSG:4326 (ou pas de coordonnées)
      return geojson;
    }

    // Lambert-93 → WGS84 (approximation affine pour la France métropolitaine)
    // Précision ~10m, suffisante pour l'affichage
    return this._transformCoords(geojson, (coord) => {
      return lambert93ToWgs84(coord[0], coord[1]);
    });
  },

  /** Extrait la première coordonnée d'un GeoJSON. */
  _getFirstCoord(geojson) {
    const features = geojson.features || [];
    if (features.length === 0) return null;
    const geom = features[0].geometry;
    if (!geom) return null;
    let coords = geom.coordinates;
    while (Array.isArray(coords[0])) coords = coords[0];
    return coords;
  },

  /** Transforme récursivement les coordonnées d'un GeoJSON. */
  _transformCoords(geojson, fn) {
    const result = JSON.parse(JSON.stringify(geojson));
    for (const feature of result.features || []) {
      if (feature.geometry) {
        feature.geometry.coordinates = this._walkCoords(
          feature.geometry.coordinates,
          fn,
        );
      }
    }
    return result;
  },

  _walkCoords(coords, fn) {
    if (typeof coords[0] === "number") {
      return fn(coords);
    }
    return coords.map((c) => this._walkCoords(c, fn));
  },
};

/**
 * Lambert-93 (EPSG:2154) → WGS84 (EPSG:4326).
 *
 * Approximation Molodensky simplifiée pour la France métropolitaine.
 * Précision : ~10m (suffisant pour affichage carto, pas pour le cadastre).
 *
 * Constantes IGN pour Lambert-93 (RGF93) :
 *   - Ellipsoïde GRS80
 *   - Longitude d'origine : 3°E
 *   - Latitude d'origine : 46.5°N
 *   - Faux Est : 700 000 m
 *   - Faux Nord : 6 600 000 m
 */
function lambert93ToWgs84(x, y) {
  // Constantes Lambert-93
  const n = 0.7256077650;
  const C = 11754255.426;
  const Xs = 700000.0;
  const Ys = 12655612.050;
  const e = 0.0818191910428;

  // Lambert → lat/lon
  const R = Math.sqrt((x - Xs) * (x - Xs) + (Ys - y) * (Ys - y));
  const gamma = Math.atan((x - Xs) / (Ys - y));

  const latIso = -Math.log(R / C) / n;
  const lon = gamma / n + (3 * Math.PI) / 180;

  // Série de convergence latitude isométrique → latitude
  let lat = 2 * Math.atan(Math.exp(latIso)) - Math.PI / 2;
  for (let i = 0; i < 5; i++) {
    lat =
      2 *
        Math.atan(
          Math.exp(latIso + e * Math.atanh(e * Math.sin(lat))),
        ) -
      Math.PI / 2;
  }

  // Radians → degrés
  return [lon * (180 / Math.PI), lat * (180 / Math.PI)];
}

// Polyfill Math.atanh pour les vieux navigateurs
if (!Math.atanh) {
  Math.atanh = function (x) {
    return Math.log((1 + x) / (1 - x)) / 2;
  };
}

window.GeoFetcher = GeoFetcher;
