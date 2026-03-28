/**
 * Carte MapLibre GL JS pour geocontext.
 *
 * Comportement :
 *   - Clic sur une feature → popup avec propriétés (pas de navigate)
 *   - Clic sur fond de carte → navigate par coordonnées
 *   - Couche "territoire" : contour pointillé de l'entité sélectionnée
 *   - Couches thématiques : styles par thème, expression data-driven pour PLU
 */

const BOUNDARY_ID = "_territory_boundary";

const GeoMap = {
  map: null,
  _layerIds: new Set(),      // Couches thématiques (hors limite territoire)
  _layerMeta: new Map(),     // sourceId → { label, primaryFields, theme }
  _popup: null,

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
      center: [2.5, 46.8],
      zoom: 5.5,
      maxZoom: 20,
      minZoom: 3,
    });

    this._popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: false,
      maxWidth: "320px",
      className: "geocontext-popup",
    });

    // Contrôles
    this.map.addControl(new maplibregl.NavigationControl(), "bottom-right");
    this.map.addControl(
      new maplibregl.ScaleControl({ maxWidth: 150, unit: "metric" }),
      "bottom-left",
    );

    // Clic : feature → popup, fond carte → navigate
    this.map.on("click", (e) => {
      const hit = this._getTopFeature(e.point);
      if (hit) {
        const meta = this._layerMeta.get(hit.sourceId) || {};
        const html = GeoStyles.popupHtml(meta.label, hit.feature.properties || {}, meta.primaryFields);
        this._popup.setLngLat(e.lngLat).setHTML(html).addTo(this.map);
        GeoState.emit("feature-click", { feature: hit.feature, meta });
      } else {
        this._popup.remove();
        GeoState.emit("map-click", { lon: e.lngLat.lng, lat: e.lngLat.lat });
      }
    });

    // Curseur pointer sur les couches interactives
    this.map.on("mousemove", (e) => {
      const hit = this._getTopFeature(e.point);
      this.map.getCanvas().style.cursor = hit ? "pointer" : "";
    });

    // Écouter les changements de contexte
    GeoState.on("context-changed", (ctx) => {
      if (ctx.bbox) this.fitBbox(ctx.bbox);
      this._updateBadge(ctx);
    });

    // Hover data-panel → highlight feature sur la carte
    GeoState.on("feature-hover", (idx) => {
      for (const lid of this._layerIds) {
        if (!this.map.getLayer(lid)) continue;
        const type = this.map.getLayer(lid).type;
        if (idx !== null && idx !== undefined) {
          if (type === "fill") {
            this.map.setPaintProperty(lid, "fill-opacity", [
              "case", ["==", ["id"], idx], 0.65, 0.25,
            ]);
          } else if (type === "circle") {
            this.map.setPaintProperty(lid, "circle-radius", [
              "case", ["==", ["id"], idx], 8, 5,
            ]);
          }
        } else {
          if (type === "fill") this.map.setPaintProperty(lid, "fill-opacity", 0.3);
          if (type === "circle") this.map.setPaintProperty(lid, "circle-radius", 5);
        }
      }
    });
  },

  /**
   * Retourne la première feature thématique touchée par un clic.
   * @returns {{ feature, sourceId } | null}
   */
  _getTopFeature(point) {
    const layerArr = [...this._layerIds].filter(lid => this.map.getLayer(lid));
    if (layerArr.length === 0) return null;

    const features = this.map.queryRenderedFeatures(point, { layers: layerArr });
    if (!features || features.length === 0) return null;

    const f = features[0];
    // Retrouver le sourceId depuis le layer id (ex: "hydro_cours_eau-fill" → "hydro_cours_eau")
    const lid = f.layer.id;
    const sourceId = lid.replace(/-fill$/, "").replace(/-line$/, "");
    return { feature: f, sourceId };
  },

  /**
   * Ajuste la vue sur une bbox [minLon, minLat, maxLon, maxLat].
   */
  fitBbox(bbox) {
    if (!bbox || bbox.length !== 4) return;
    this.map.fitBounds(
      [[bbox[0], bbox[1]], [bbox[2], bbox[3]]],
      { padding: 50, duration: 800 },
    );
  },

  /**
   * Ajoute une couche GeoJSON thématique sur la carte.
   * @param {string} id
   * @param {Object} geojson
   * @param {Object} style - style de base (color, opacity, stroke, strokeWidth)
   * @param {Object} [meta] - { label, primaryFields, theme }
   */
  addGeoJsonLayer(id, geojson, style = {}, meta = {}) {
    if (!this.map || !this.map.isStyleLoaded()) return;
    this.removeLayer(id);

    const sourceId = `src-${id}`;
    this.map.addSource(sourceId, { type: "geojson", data: geojson });

    const features = geojson.features || [];
    const geomType = features[0]?.geometry?.type || "Point";
    const theme = meta.theme || style.theme;

    // Résoudre le style :
    //   1. Palette thématique (GeoStyles) — couleurs par thème
    //   2. Écrasé par le displayStyle explicite de la source (si non vide)
    const base = theme ? GeoStyles.forTheme(theme) : { color: "#5b8def", opacity: 0.3, stroke: "#3a6bd5", strokeWidth: 1.5 };
    const hasExplicitStyle = style && Object.keys(style).some(k => style[k] !== undefined);
    const resolved = hasExplicitStyle ? Object.assign({}, base, style) : base;

    if (geomType === "Point" || geomType === "MultiPoint") {
      this.map.addLayer({
        id,
        type: "circle",
        source: sourceId,
        paint: {
          "circle-radius": style.radius || 6,
          "circle-color": resolved.color,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": resolved.stroke || "#fff",
          "circle-opacity": resolved.opacity || 0.85,
        },
      });
      this._layerIds.add(id);

    } else if (geomType.includes("Polygon")) {
      // PLU : coloration data-driven par typezone
      const hasPlu = features.some(f => f.properties?.typezone);
      const fillColor = hasPlu ? GeoStyles.pluFillColor() : resolved.color;

      this.map.addLayer({
        id: `${id}-fill`,
        type: "fill",
        source: sourceId,
        paint: {
          "fill-color": fillColor,
          "fill-opacity": resolved.opacity || 0.3,
        },
      });
      this.map.addLayer({
        id: `${id}-line`,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": resolved.stroke || resolved.color,
          "line-width": resolved.strokeWidth || 1.5,
        },
      });
      this._layerIds.add(`${id}-fill`);
      this._layerIds.add(`${id}-line`);

    } else {
      // Lignes (cours d'eau, etc.)
      this.map.addLayer({
        id,
        type: "line",
        source: sourceId,
        paint: {
          "line-color": resolved.color,
          "line-width": resolved.strokeWidth || 2,
          "line-opacity": resolved.opacity || 0.85,
        },
      });
      this._layerIds.add(id);
    }

    // Stocker le meta pour les popups
    this._layerMeta.set(id, meta);
  },

  /**
   * Ajoute le contour du territoire comme couche de contexte (pointillé).
   * Remplace l'ancienne couche territoire si elle existe.
   */
  addTerritoryBoundary(geojson) {
    if (!this.map || !this.map.isStyleLoaded()) return;
    this.clearBoundary();

    const sourceId = `src-${BOUNDARY_ID}`;
    this.map.addSource(sourceId, { type: "geojson", data: geojson });

    // Fond très léger + contour pointillé distinctif
    this.map.addLayer({
      id: `${BOUNDARY_ID}-fill`,
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": "#4a90d9",
        "fill-opacity": 0.04,
      },
    });
    this.map.addLayer({
      id: `${BOUNDARY_ID}-line`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": "#2a70b9",
        "line-width": 2,
        "line-dasharray": [4, 3],
        "line-opacity": 0.7,
      },
    });
  },

  /** Supprime la couche territoire. */
  clearBoundary() {
    if (!this.map) return;
    const toRemove = [`${BOUNDARY_ID}-fill`, `${BOUNDARY_ID}-line`];
    for (const lid of toRemove) {
      if (this.map.getLayer(lid)) this.map.removeLayer(lid);
    }
    const sourceId = `src-${BOUNDARY_ID}`;
    if (this.map.getSource(sourceId)) this.map.removeSource(sourceId);
  },

  /**
   * Supprime une couche thématique et sa source.
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
    this._layerMeta.delete(id);
  },

  /**
   * Supprime toutes les couches thématiques (pas la limite territoire).
   */
  clearLayers() {
    if (!this.map) return;
    for (const lid of [...this._layerIds]) {
      if (this.map.getLayer(lid)) this.map.removeLayer(lid);
    }
    this._layerIds.clear();
    this._layerMeta.clear();
    this._popup.remove();
    // Supprimer les sources src-* sauf la limite territoire
    const style = this.map.getStyle();
    if (style?.sources) {
      for (const sid of Object.keys(style.sources)) {
        if (sid.startsWith("src-") && sid !== `src-${BOUNDARY_ID}`) {
          if (this.map.getSource(sid)) this.map.removeSource(sid);
        }
      }
    }
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
