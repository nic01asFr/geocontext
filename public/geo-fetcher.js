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

// Métadonnées de niveau pour les couches de contexte (doit correspondre à map.js)
const ZOOM_TO_LEVEL_MAP = {
  region:      { level: "region",      label: "RÉG",  color: "#7a8abd" },
  departement: { level: "departement", label: "DÉP",  color: "#6a9aad" },
  epci:        { level: "epci",        label: "EPCI", color: "#5aadad" },
  commune:     { level: "commune",     label: "COM",  color: "#4aad8a" },
};

const GeoFetcher = {
  /**
   * Traite un résultat MCP tool call et extrait les layerSpecs.
   * Retourne null si pas de layerSpecs dans la réponse.
   */
  extractLayerSpecs(result) {
    if (!result?.content) return null;

    for (const block of result.content) {
      if (block.type !== "text") continue;
      const text = block.text;

      // Chercher toutes les occurrences de "{" et tenter un parse JSON complet
      let i = 0;
      while (i < text.length) {
        const start = text.indexOf('{"_type":"layerSpecs"', i);
        if (start === -1) break;
        // Trouver la fermeture en comptant les accolades
        let depth = 0, end = start;
        for (; end < text.length; end++) {
          if (text[end] === '{') depth++;
          else if (text[end] === '}') { depth--; if (depth === 0) break; }
        }
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          if (parsed._type === "layerSpecs" && parsed.layers) return parsed.layers;
        } catch {}
        i = start + 1;
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
    const loaded = results
      .map(r => r.status === "fulfilled" ? r.value : null)
      .filter(Boolean);

    // Mettre à jour la légende avec les compteurs réels (toutes les features)
    for (const layer of loaded) {
      if (layer?.features?.length > 0 && layer.styleRecipe?.classification) {
        GeoMap.updateLegendCounts(layer.features, layer.styleRecipe.classification);
      }
    }

    return loaded;
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
   * Charge la couche de contexte admin.
   * En mode navigation : affiche les enfants de l'entité courante (filtre parent).
   * En mode initial : affiche toutes les entités du niveau dans la bbox.
   *
   * @param {string} level - "region" | "departement" | "epci" | "commune"
   * @param {number[]} bbox - viewport bbox
   * @param {object} [parent] - contexte parent { level, code, hierarchy }
   */
  async loadContextLayer(level, bbox, parent) {
    const def = ADMINEXPRESS_TYPENAMES[level];
    if (!def) return;

    try {
      const propFields = level === "epci"
        ? "code_siren,nom_officiel,geometrie"
        : "code_insee,nom_officiel,geometrie";

      // Construire le filtre CQL
      let cqlFilter;
      if (parent) {
        // Mode navigation : filtrer les enfants par relation parent
        const parentFilter = this._buildParentFilter(level, parent);
        if (parentFilter) {
          cqlFilter = parentFilter;
        } else {
          // Fallback bbox si pas de filtre parent possible
          const pad = (level === "region") ? 3 : (level === "departement") ? 1 : 0.5;
          const [minLon, minLat, maxLon, maxLat] = bbox;
          cqlFilter = `BBOX(geometrie,${minLon - pad},${minLat - pad},${maxLon + pad},${maxLat + pad},'EPSG:4326')`;
        }
      } else {
        // Mode initial : bbox avec padding
        const pad = (level === "region") ? 3 : (level === "departement") ? 1 : 0.5;
        const [minLon, minLat, maxLon, maxLat] = bbox;
        cqlFilter = `BBOX(geometrie,${minLon - pad},${minLat - pad},${maxLon + pad},${maxLat + pad},'EPSG:4326')`;
      }

      const params = new URLSearchParams({
        service: "WFS",
        version: "2.0.0",
        request: "GetFeature",
        typeName: def.typename,
        outputFormat: "application/json",
        srsName: "EPSG:4326",
        count: level === "commune" ? "1000" : "300",
        propertyName: propFields,
        CQL_FILTER: cqlFilter,
      });

      const response = await fetch(`${GPF_WFS_URL}?${params}`);
      if (!response.ok) return;

      const geojson = await response.json();
      if (!geojson.features || geojson.features.length === 0) return;

      geojson.features = geojson.features.map((f, i) => ({ ...f, id: i }));

      const levelDef = ZOOM_TO_LEVEL_MAP[level];
      GeoMap.addContextLayer(`_ctx_${level}`, geojson, levelDef);
    } catch (err) {
      console.warn(`[geo-fetcher] ctx layer ${level}: ${err.message}`);
    }
  },

  /**
   * Construit le filtre CQL par clé étrangère ADMINEXPRESS.
   * Chaque relation parent→enfant utilise la FK exacte du schéma.
   */
  _buildParentFilter(childLevel, parent) {
    const h = parent.hierarchy || {};
    const level = parent.level;

    switch (childLevel) {
      case "departement":
        // région → départements : FK departement.code_insee_de_la_region
        if (h.region?.code) return `code_insee_de_la_region='${h.region.code}'`;
        return null;

      case "commune":
        // EPCI → communes : FK commune.codes_siren_des_epci (multi-valué)
        if (level === "epci" && h.epci?.siren)
          return `codes_siren_des_epci LIKE '%${h.epci.siren}%'`;
        // département → communes : FK commune.code_insee_du_departement
        if (h.departement?.code)
          return `code_insee_du_departement='${h.departement.code}'`;
        return null;

      default:
        return null;
    }
  },

  /**
   * Fetch une couche (WFS ou inline) et l'affiche sur la carte.
   * Retourne { sourceId, label, features, primaryFields } si succès.
   */
  async _fetchAndDisplay(sourceId, spec) {
    try {
      const styleRecipe = spec.styleRecipe || null;
      const meta = {
        label: spec.label || sourceId,
        primaryFields: spec.primaryFields || [],
        theme: spec.theme || null,
        styleRecipe,
      };

      if (spec.type === "inline") {
        const geojson = spec.inlineGeojson;
        if (geojson?.features?.length > 0) {
          GeoMap.addGeoJsonLayer(sourceId, geojson, spec.style || {}, meta);
          return { sourceId, label: meta.label, features: geojson.features, primaryFields: meta.primaryFields, styleRecipe };
        }
        return null;
      }

      // Mode paginé : explicite ou auto-détecté
      if (spec.paginated) {
        return await this._fetchPaginated(sourceId, spec, meta);
      }

      // Première page
      const pageSize = spec.maxFeatures || 1000;
      const url = this._buildWfsUrl(spec, 0, pageSize);
      const response = await fetch(url);
      if (!response.ok) {
        console.warn(`[geo-fetcher] ${sourceId}: HTTP ${response.status}`);
        return null;
      }
      let geojson = await response.json();
      if (spec.nativeCrs && spec.nativeCrs !== "EPSG:4326") {
        geojson = this._reproject(geojson, spec.nativeCrs);
      }

      if (!geojson?.features?.length) return null;

      // Auto-pagination : si la première page est pleine, il y a probablement plus
      if (geojson.features.length >= pageSize) {
        // Afficher la première page immédiatement
        GeoMap.addGeoJsonLayer(sourceId, geojson, spec.style || {}, meta);
        console.log(`[geo-fetcher] ${sourceId}: ${geojson.features.length} features (page 1, auto-paginating...)`);

        // Charger les pages suivantes — pas de cap artificiel
        const allFeatures = [...geojson.features];
        let startIndex = pageSize;
        while (true) {
          const pageUrl = this._buildWfsUrl(spec, startIndex, pageSize);
          const pageRes = await fetch(pageUrl);
          if (!pageRes.ok) break;
          let page = await pageRes.json();
          if (spec.nativeCrs && spec.nativeCrs !== "EPSG:4326") {
            page = this._reproject(page, spec.nativeCrs);
          }
          if (!page.features || page.features.length === 0) break;
          allFeatures.push(...page.features);
          GeoMap.updateGeoJsonSource(sourceId, { type: "FeatureCollection", features: allFeatures });
          console.log(`[geo-fetcher] ${sourceId}: ${allFeatures.length} features (page ${Math.floor(startIndex / pageSize) + 1})`);
          if (page.features.length < pageSize) break;
          startIndex += pageSize;
        }
        return { sourceId, label: meta.label, features: allFeatures, primaryFields: meta.primaryFields, styleRecipe };
      }

      // Single page — toutes les features tiennent dans une page
      GeoMap.addGeoJsonLayer(sourceId, geojson, spec.style || {}, meta);
      console.log(`[geo-fetcher] ${sourceId}: ${geojson.features.length} features chargées`);
      return { sourceId, label: meta.label, features: geojson.features, primaryFields: meta.primaryFields, styleRecipe };
    } catch (err) {
      console.warn(`[geo-fetcher] ${sourceId}: ${err.message}`);
      return null;
    }
  },

  /**
   * Fetch paginé : charge les features par pages de pageSize, affichage progressif.
   */
  async _fetchPaginated(sourceId, spec, meta) {
    const pageSize = spec.pageSize || 1000;
    const allFeatures = [];
    let startIndex = 0;
    let geojsonBase = null;

    while (true) {
      const url = this._buildWfsUrl(spec, startIndex, pageSize);
      const response = await fetch(url);
      if (!response.ok) break;

      let page = await response.json();
      if (spec.nativeCrs && spec.nativeCrs !== "EPSG:4326") {
        page = this._reproject(page, spec.nativeCrs);
      }
      if (!page.features || page.features.length === 0) break;

      allFeatures.push(...page.features);

      // Rendu progressif : mettre à jour la source MapLibre
      const geojson = { type: "FeatureCollection", features: allFeatures };
      if (!geojsonBase) {
        GeoMap.addGeoJsonLayer(sourceId, geojson, spec.style || {}, meta);
        geojsonBase = true;
      } else {
        GeoMap.updateGeoJsonSource(sourceId, geojson);
      }

      console.log(`[geo-fetcher] ${sourceId}: ${allFeatures.length} features (page ${Math.floor(startIndex / pageSize) + 1})`);

      if (page.features.length < pageSize) break; // dernière page
      startIndex += pageSize;
    }

    if (allFeatures.length > 0) {
      return { sourceId, label: meta.label, features: allFeatures, primaryFields: meta.primaryFields, styleRecipe: meta.styleRecipe };
    }
    return null;
  },

  /**
   * Construit l'URL WFS GetFeature depuis un LayerSpec.
   */
  _buildWfsUrl(spec, startIndex = 0, count) {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: spec.typename,
      outputFormat: "application/json",
      CQL_FILTER: spec.cqlFilter,
      count: String(count || spec.maxFeatures || 1000),
      srsName: spec.srsName || "EPSG:4326",
    });
    if (startIndex > 0) params.set("startIndex", String(startIndex));
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
