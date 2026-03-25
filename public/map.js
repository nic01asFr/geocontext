/**
 * Carte MapLibre GL JS pour geocontext.
 *
 * - Fond de carte IGN Plan v2 (WMTS)
 * - Couches GeoJSON dynamiques (ajoutées par le serveur MCP)
 * - Clic → reverse geocoding (navigate par coordonnées)
 * - Zoom adaptatif = niveau adaptatif
 */

const GeoMap = {
  map: null,
  _layerIds: new Set(),

  /** Initialise la carte MapLibre. */
  init() {
    this.map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        name: "IGN Plan v2",
        sources: {
          "ign-plan": {
            type: "raster",
            tiles: [
              "https://data.geopf.fr/wmts?" +
              "SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0" +
              "&LAYER=GEOGRAPHICALGRIDSYSTEMS.PLANIGNV2" +
              "&STYLE=normal&TILEMATRIXSET=PM" +
              "&TILEMATRIX={z}&TILEROW={y}&TILECOL={x}" +
              "&FORMAT=image/png",
            ],
            tileSize: 256,
            attribution: "&copy; IGN",
            maxzoom: 19,
          },
        },
        layers: [
          {
            id: "ign-plan-layer",
            type: "raster",
            source: "ign-plan",
            paint: { "raster-opacity": 0.85 },
          },
        ],
      },
      center: [2.5, 46.8], // France métropolitaine
      zoom: 5.5,
      maxZoom: 20,
      minZoom: 3,
    });

    // Contrôles
    this.map.addControl(new maplibregl.NavigationControl(), "bottom-right");
    this.map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 150, unit: "metric" }),
      "bottom-left",
    );

    // Clic carte → navigate par coordonnées
    this.map.on("click", (e) => {
      const { lng, lat } = e.lngLat;
      GeoState.emit("map-click", { lon: lng, lat });
    });

    // Écouter les changements de contexte
    GeoState.on("context-changed", (ctx) => {
      if (ctx.bbox) this.fitBbox(ctx.bbox);
      this._updateBadge(ctx);
    });

    // Écouter les nouvelles couches
    GeoState.on("layers-changed", (layers) => {
      // Les couches sont ajoutées via addGeoJsonLayer
    });
  },

  /**
   * Ajuste la vue sur une bbox [minLon, minLat, maxLon, maxLat].
   */
  fitBbox(bbox) {
    if (!bbox || bbox.length !== 4) return;
    this.map.fitBounds(
      [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      { padding: 40, duration: 800 },
    );
  },

  /**
   * Ajoute une couche GeoJSON sur la carte.
   */
  addGeoJsonLayer(id, geojson, style = {}) {
    if (!this.map) return;

    // Supprimer si elle existe déjà
    this.removeLayer(id);

    const sourceId = `src-${id}`;
    this.map.addSource(sourceId, {
      type: "geojson",
      data: geojson,
    });

    // Détecter le type de géométrie
    const features = geojson.features || [];
    const geomType = features[0]?.geometry?.type || "Point";

    if (geomType === "Point" || geomType === "MultiPoint") {
      this.map.addLayer({
        id,
        type: "circle",
        source: sourceId,
        paint: {
          "circle-radius": style.radius || 5,
          "circle-color": style.color || "#5b8def",
          "circle-stroke-width": 1,
          "circle-stroke-color": "#fff",
          "circle-opacity": style.opacity || 0.8,
        },
      });
    } else if (geomType.includes("Polygon")) {
      this.map.addLayer({
        id: `${id}-fill`,
        type: "fill",
        source: sourceId,
        paint: {
          "fill-color": style.color || "#5b8def",
          "fill-opacity": style.opacity || 0.2,
        },
      });
      this.map.addLayer({
        id: `${id}-line`,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": style.stroke || style.color || "#5b8def",
          "line-width": style.strokeWidth || 1.5,
        },
      });
      this._layerIds.add(`${id}-fill`);
      this._layerIds.add(`${id}-line`);
    } else {
      this.map.addLayer({
        id,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": style.color || "#5b8def",
          "line-width": style.strokeWidth || 2,
        },
      });
    }

    this._layerIds.add(id);
  },

  /**
   * Supprime une couche et sa source.
   */
  removeLayer(id) {
    if (!this.map) return;
    const toRemove = [`${id}-fill`, `${id}-line`, id];
    for (const lid of toRemove) {
      if (this.map.getLayer(lid)) this.map.removeLayer(lid);
      this._layerIds.delete(lid);
    }
    const sourceId = `src-${id}`;
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  },

  /**
   * Bascule la visibilité d'une couche.
   */
  toggleLayer(id, visible) {
    const toToggle = [`${id}-fill`, `${id}-line`, id];
    const visibility = visible ? "visible" : "none";
    for (const lid of toToggle) {
      if (this.map.getLayer(lid)) {
        this.map.setLayoutProperty(lid, "visibility", visibility);
      }
    }
  },

  /**
   * Supprime toutes les couches dynamiques.
   */
  clearLayers() {
    for (const lid of [...this._layerIds]) {
      if (this.map.getLayer(lid)) this.map.removeLayer(lid);
    }
    this._layerIds.clear();
    // Supprimer les sources src-*
    const style = this.map.getStyle();
    if (style?.sources) {
      for (const sid of Object.keys(style.sources)) {
        if (sid.startsWith("src-")) this.map.removeSource(sid);
      }
    }
  },

  /** Met à jour le badge territoire sur la carte. */
  _updateBadge(ctx) {
    const badge = document.getElementById("territory-badge");
    if (!ctx.level || !ctx.name) {
      badge.classList.add("hidden");
      return;
    }
    badge.classList.remove("hidden");
    badge.innerHTML = `${ctx.name}<span class="code">${ctx.code}</span>`;
  },
};

window.GeoMap = GeoMap;
