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
const CTX_LAYER_PREFIX = "_ctx_";

// Niveaux administratifs avec métadonnées d'affichage
const LEVEL_DEFS = {
  region:      { label: "RÉG",  color: "#7a8abd" },
  departement: { label: "DÉP",  color: "#6a9aad" },
  epci:        { label: "EPCI", color: "#5aadad" },
  commune:     { label: "COM",  color: "#4aad8a" },
};

// Niveau enfant pour chaque niveau navigué (basé sur les FK ADMINEXPRESS)
const CHILD_LEVEL = {
  region: "departement",     // FK: departement.code_insee_de_la_region
  departement: "commune",    // FK: commune.code_insee_du_departement
  epci: "commune",           // FK: commune.codes_siren_des_epci
  commune: null,
};

// Fallback zoom-based quand aucun territoire n'est sélectionné
const ZOOM_TO_LEVEL = [
  { minZoom: 0,    maxZoom: 6.5,  level: "region" },
  { minZoom: 6.5,  maxZoom: 8.5,  level: "departement" },
  { minZoom: 8.5,  maxZoom: 10.5, level: "epci" },
  { minZoom: 10.5, maxZoom: 25,   level: "commune" },
];

function zoomToAdminLevel(zoom) {
  const entry = ZOOM_TO_LEVEL.find(z => zoom >= z.minZoom && zoom < z.maxZoom) || ZOOM_TO_LEVEL[3];
  return { ...LEVEL_DEFS[entry.level], level: entry.level };
}

const GeoMap = {
  map: null,
  _layerIds: new Set(),      // Couches thématiques (hors limite territoire)
  _layerMeta: new Map(),     // sourceId → { label, primaryFields, theme }
  _popup: null,
  _ctxLayerIds: new Set(),   // Couches de contexte admin (cliquables selon zoom)
  _ctxCurrentLevel: null,    // Niveau admin actuellement affiché
  _ctxDebounce: null,        // Timer debounce moveend/zoomend

  /** Initialise la carte MapLibre. */
  init() {
    this.map = new maplibregl.Map({
      container: "map",
      style: {
        version: 8,
        name: "OSM Light",
        sources: {
          "osm-light": {
            type: "raster",
            tiles: [
              "https://a.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
              "https://b.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
              "https://c.basemaps.cartocdn.com/light_all/{z}/{x}/{y}@2x.png",
            ],
            tileSize: 256,
            attribution: "&copy; <a href='https://www.openstreetmap.org/copyright'>OSM</a> &copy; <a href='https://carto.com/'>CARTO</a>",
            maxzoom: 19,
          },
        },
        layers: [
          {
            id: "osm-light-layer",
            type: "raster",
            source: "osm-light",
            paint: { "raster-opacity": 0.9 },
          },
        ],
        glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
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

    // Clic : context admin entity → entity card | feature thématique → popup | fond → navigate
    this.map.on("click", (e) => {
      // 1. Feature thématique ?
      const thematicHit = this._getTopFeature(e.point);
      if (thematicHit) {
        const meta = this._layerMeta.get(thematicHit.sourceId) || {};
        const html = GeoStyles.popupHtml(meta.label, thematicHit.feature.properties || {}, meta.primaryFields);
        this._popup.setLngLat(e.lngLat).setHTML(html).addTo(this.map);
        GeoState.emit("feature-click", { feature: thematicHit.feature, meta });
        return;
      }
      // 2. Entité admin de la couche de contexte ?
      const ctxHit = this._getContextFeature(e.point);
      if (ctxHit) {
        this._popup.remove();
        this._showEntityCard(e.lngLat, ctxHit.feature, ctxHit.levelDef);
        return;
      }
      // 3. Fond de carte → navigate par coordonnées
      this._popup.remove();
      GeoState.emit("map-click", { lon: e.lngLat.lng, lat: e.lngLat.lat });
    });

    // Curseur pointer sur les couches interactives
    this.map.on("mousemove", (e) => {
      const thematic = this._getTopFeature(e.point);
      const ctx = !thematic && this._getContextFeature(e.point);
      this.map.getCanvas().style.cursor = (thematic || ctx) ? "pointer" : "";
      // Hover highlight couche contexte
      this._hoverContextFeature(ctx ? ctx.feature : null);
    });

    // Charger la couche de contexte au démarrage et sur zoom/move
    // En mode navigation, le zoom/move ne recharge PAS la couche (enfants fixes)
    this.map.on("load", () => this._updateContextLayer());
    this.map.on("zoomend", () => {
      if (this._navContext) return; // navigation active → pas de reload auto
      clearTimeout(this._ctxDebounce);
      this._ctxDebounce = setTimeout(() => this._updateContextLayer(), 350);
    });
    this.map.on("moveend", () => {
      if (this._navContext) return; // navigation active → pas de reload auto
      clearTimeout(this._ctxDebounce);
      this._ctxDebounce = setTimeout(() => this._updateContextLayer(), 500);
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
    if (!this.map) return;
    if (!this.map.isStyleLoaded()) {
      this.map.once("load", () => this.addGeoJsonLayer(id, geojson, style, meta));
      return;
    }
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
    if (!this.map) return;
    if (!this.map.isStyleLoaded()) {
      this.map.once("load", () => this.addTerritoryBoundary(geojson));
      return;
    }
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
   * Met à jour les données d'une source GeoJSON existante (rendu progressif).
   */
  updateGeoJsonSource(id, geojson) {
    if (!this.map) return;
    const sourceId = `src-${id}`;
    const source = this.map.getSource(sourceId);
    if (source) source.setData(geojson);
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
    // Supprimer les sources src-* sauf la limite territoire et les couches contexte
    const style = this.map.getStyle();
    if (style?.sources) {
      for (const sid of Object.keys(style.sources)) {
        if (
          sid.startsWith("src-") &&
          sid !== `src-${BOUNDARY_ID}` &&
          !sid.startsWith(`src-${CTX_LAYER_PREFIX}`)
        ) {
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

  // ================================================================
  // Couche de contexte admin — suit le niveau navigué
  // ================================================================

  _navContext: null,  // { level, code, hierarchy }

  /** Réinitialise la couche contexte (retour à l'état initial). */
  resetContextLayer() {
    this._navContext = null;
    this._ctxCurrentLevel = null;
    this._updateContextLayer();
  },

  /**
   * Met à jour le contexte de navigation — affiche les entités enfants de l'entité courante.
   * Ex: navigué sur département → affiche les EPCI du département
   */
  setNavigationContext(ctx) {
    this._navContext = ctx;
    // Toujours supprimer l'ancienne couche contexte avant de charger la nouvelle
    this.clearContextLayer();
    this._ctxCurrentLevel = null;
    this._updateContextLayer();
  },

  /** Déclenche la mise à jour de la couche de contexte. */
  _updateContextLayer() {
    const b = this.map.getBounds();
    const bbox = [b.getWest(), b.getSouth(), b.getEast(), b.getNorth()];

    // Mode navigation : afficher les enfants de l'entité courante
    if (this._navContext?.level) {
      const childLevel = CHILD_LEVEL[this._navContext.level];
      if (!childLevel) {
        // Pas d'enfants (commune) → masquer la couche contexte
        this.clearContextLayer();
        this._ctxCurrentLevel = null;
        return;
      }
      if (childLevel === this._ctxCurrentLevel) return; // déjà affiché
      this._ctxCurrentLevel = childLevel;
      GeoState.emit("context-layer-update", {
        level: childLevel,
        bbox,
        // Filtre pour ne charger que les enfants de l'entité courante
        parent: this._navContext,
      });
      return;
    }

    // Mode initial (pas de navigation) : zoom-based
    const zoom = this.map.getZoom();
    const levelDef = zoomToAdminLevel(zoom);
    if (levelDef.level === this._ctxCurrentLevel && this._ctxCurrentLevel !== null) return;
    this._ctxCurrentLevel = levelDef.level;
    GeoState.emit("context-layer-update", { level: levelDef.level, bbox });
  },

  /** Ajoute la couche de contexte (ADMINEXPRESS polygones) sur la carte. */
  addContextLayer(id, geojson, levelDef) {
    if (!this.map) return;
    if (!this.map.isStyleLoaded()) {
      // Defer jusqu'à ce que le style soit prêt
      this.map.once("idle", () => this.addContextLayer(id, geojson, levelDef));
      return;
    }
    this.clearContextLayer();
    if (!geojson.features || geojson.features.length === 0) return;

    const sourceId = `src-${id}`;
    this.map.addSource(sourceId, {
      type: "geojson",
      data: geojson,
      tolerance: 1.5,  // simplifier les géométries complexes (régions)
      buffer: 128,     // buffer de tuile élargi pour éviter les coupures
    });

    this.map.addLayer({
      id: `${id}-fill`,
      type: "fill",
      source: sourceId,
      paint: {
        "fill-color": levelDef.color,
        "fill-opacity": ["case", ["boolean", ["feature-state", "hover"], false], 0.25, 0.10],
      },
    });
    this.map.addLayer({
      id: `${id}-line`,
      type: "line",
      source: sourceId,
      paint: {
        "line-color": levelDef.color,
        "line-width": 1.2,
        "line-opacity": 0.5,
      },
    });
    this._ctxLayerIds.add(`${id}-fill`);
    this._ctxLayerIds.add(`${id}-line`);
    this._ctxSourceId = sourceId;
    this._ctxLayerId = `${id}-fill`;
  },

  /** Supprime la couche de contexte actuelle. */
  clearContextLayer() {
    if (!this.map) return;
    for (const lid of [...this._ctxLayerIds]) {
      if (this.map.getLayer(lid)) this.map.removeLayer(lid);
    }
    this._ctxLayerIds.clear();
    if (this._ctxSourceId && this.map.getSource(this._ctxSourceId)) {
      this.map.removeSource(this._ctxSourceId);
    }
    this._ctxSourceId = null;
    this._ctxLayerId = null;
    this._ctxHoveredId = null;
  },

  /** Retourne la feature de contexte sous le point de clic. */
  _getContextFeature(point) {
    if (this._ctxLayerIds.size === 0) return null;
    // Requêter les layers fill ET line pour couvrir les frontières
    const allLayers = [...this._ctxLayerIds]
      .filter(lid => this.map.getLayer(lid));
    if (allLayers.length === 0) return null;

    // D'abord essayer un point précis, puis élargir avec une bbox de tolérance
    let features = this.map.queryRenderedFeatures(point, { layers: allLayers });
    if (!features || features.length === 0) {
      // Tolérance de 5px pour capter les features proches
      const bbox = [[point.x - 5, point.y - 5], [point.x + 5, point.y + 5]];
      features = this.map.queryRenderedFeatures(bbox, { layers: allLayers });
    }
    if (!features || features.length === 0) return null;

    // Privilégier les features du fill (plus fiables pour l'identité)
    const fillFeature = features.find(f => f.layer.id.endsWith("-fill"));
    const best = fillFeature || features[0];

    // Le levelDef correspond au niveau de la couche contexte actuellement affichée
    const level = this._ctxCurrentLevel || zoomToAdminLevel(this.map.getZoom()).level;
    const levelDef = { ...LEVEL_DEFS[level], level };
    return { feature: best, levelDef };
  },

  /** Hover highlight d'une feature de contexte (feature state). */
  _hoverContextFeature(feature) {
    if (!this._ctxSourceId || !this.map.getSource(this._ctxSourceId)) return;
    if (this._ctxHoveredId !== undefined && this._ctxHoveredId !== null) {
      this.map.setFeatureState(
        { source: this._ctxSourceId, id: this._ctxHoveredId },
        { hover: false },
      );
    }
    this._ctxHoveredId = feature ? feature.id : null;
    if (feature && feature.id !== undefined) {
      this.map.setFeatureState(
        { source: this._ctxSourceId, id: feature.id },
        { hover: true },
      );
    }
  },

  /** Affiche la carte d'entité administrative (vue synthétique). */
  _showEntityCard(lngLat, feature, levelDef) {
    const props = feature.properties || {};
    const name = props.nom_officiel || props.nom || "?";
    const code = props.code_insee || props.code_siren || "";
    const labelColor = levelDef.color;

    const html = `<div class="entity-card">
      <div class="ec-level" style="background:${labelColor}">${levelDef.label}</div>
      <div class="ec-name">${name}</div>
      ${code ? `<div class="ec-code">${code}</div>` : ""}
      <button class="ec-navigate" data-code="${code || name}">→ Naviguer</button>
    </div>`;

    const popup = new maplibregl.Popup({
      closeButton: true,
      closeOnClick: true,
      maxWidth: "240px",
      className: "geocontext-popup entity-popup",
    })
      .setLngLat(lngLat)
      .setHTML(html)
      .addTo(this.map);

    // Bouton naviguer — passer le niveau + code pour une résolution non ambiguë
    popup.getElement().querySelector(".ec-navigate")?.addEventListener("click", () => {
      popup.remove();
      GeoState.emit("navigate-request", { code, name, level: levelDef.level });
    });
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
