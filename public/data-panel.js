/**
 * Panneau de données thématiques — tableau interactif avec tri, filtres, corrélation carte.
 *
 * Les filtres sont auto-générés depuis les UserFilterDef transmis via layerSpec.
 * Filtrer dans la table met à jour la couche carte en temps réel.
 */

const DataPanel = {
  _features: [],      // Toutes les features (non filtrées)
  _filtered: [],      // Features filtrées
  _sourceId: null,    // ID de la couche carte liée
  _meta: null,        // { filters, fields, primaryFields }
  _sortKey: null,
  _sortAsc: true,
  _filterValues: {},  // { key: value }
  _pageSize: 200,
  _page: 0,

  init() {
    document.getElementById("data-close").addEventListener("click", () => this.hide());
  },

  show() { document.getElementById("data-panel").classList.remove("hidden"); },
  hide() { document.getElementById("data-panel").classList.add("hidden"); },

  showLoading(title) {
    document.getElementById("data-title").textContent = title || "Chargement…";
    document.getElementById("data-content").innerHTML =
      '<div style="text-align:center;padding:24px"><span class="loading-spinner"></span></div>';
    this.show();
  },

  /**
   * Affiche les résultats avec tableau interactif.
   * @param {string} title
   * @param {string} textResult - Texte MCP pour affichage chat
   * @param {object[]} [features] - Features GeoJSON
   * @param {object} [meta] - { sourceId, filters, fields, primaryFields }
   */
  render(title, textResult, features, meta) {
    document.getElementById("data-title").textContent = title;

    if (!features || features.length === 0) {
      document.getElementById("data-content").innerHTML =
        typeof textResult === "string" ? this._renderText(textResult) : this._renderJson(textResult);
      this.show();
      return;
    }

    this._features = features;
    this._filtered = features;
    this._sourceId = meta?.sourceId || null;
    this._meta = meta || {};
    this._sortKey = null;
    this._sortAsc = true;
    this._filterValues = {};
    this._page = 0;
    this._colAnalysis = null; // recalculer l'analyse

    this._buildTable();
    this.show();
  },

  // ================================================================
  // Table rendering
  // ================================================================

  _buildTable() {
    const el = document.getElementById("data-content");
    const features = this._filtered;
    const filters = this._meta.filters || [];

    // Analyser les colonnes AVANT de résoudre les champs (pour exclure les constantes)
    if (!this._colAnalysis) {
      // Résoudre les champs bruts d'abord pour l'analyse
      const rawFields = this._meta.fields?.length > 0
        ? this._meta.fields.filter((f) => f.type !== "geometry")
        : this._resolveFields();
      this._colAnalysis = this._analyzeColumns(rawFields);
    }
    const fields = this._resolveFields();

    // Stats
    const statsHtml = this._buildStats(features, fields);
    const analysis = this._colAnalysis;

    // Filter inputs row — adapté au type de données
    const filterRow = fields.map((f) => {
      const filterDef = filters.find((fl) => fl.key === f.key);
      const col = analysis[f.key];
      const val = this._filterValues[f.key];

      // 1. Enum explicite du serveur
      if (filterDef?.type === "enum" && filterDef.values) {
        const selected = Array.isArray(val) ? val : [];
        const opts = Object.entries(filterDef.values)
          .map(([k, v]) => `<option value="${k}"${selected.includes(k) ? " selected" : ""}>${v}</option>`)
          .join("");
        return `<th><select class="dp-filter dp-multi" data-key="${f.key}" data-filter-type="multi" multiple size="1">${opts}</select></th>`;
      }

      // 2. Constante (1 valeur unique) → pas de filtre
      if (col?.type === "constant") {
        return `<th></th>`;
      }

      // 3. Enum auto-détecté (< 80 valeurs uniques) → select multiple
      if (col?.type === "enum") {
        const selected = Array.isArray(val) ? val : [];
        const opts = col.values
          .map((v) => `<option value="${v}"${selected.includes(v) ? " selected" : ""}>${v} (${col.counts[v]})</option>`)
          .join("");
        return `<th><select class="dp-filter dp-multi" data-key="${f.key}" data-filter-type="multi" multiple size="1">${opts}</select></th>`;
      }

      // 4. Numérique → double input min/max
      if (col?.type === "number") {
        const minVal = val?.min ?? "";
        const maxVal = val?.max ?? "";
        return `<th class="dp-range-cell">
          <input class="dp-filter dp-range-min" data-key="${f.key}" data-filter-type="range-min" type="number" placeholder="${col.min}" value="${minVal}" title="Min: ${col.min.toLocaleString("fr-FR")}" />
          <input class="dp-filter dp-range-max" data-key="${f.key}" data-filter-type="range-max" type="number" placeholder="${col.max}" value="${maxVal}" title="Max: ${col.max.toLocaleString("fr-FR")}" />
        </th>`;
      }

      // 5. Texte libre
      return `<th><input class="dp-filter" data-key="${f.key}" data-filter-type="text" placeholder="⌕" value="${val || ""}" /></th>`;
    }).join("");

    // Header row with sort indicators
    const thead = fields.map((f) => {
      const arrow = this._sortKey === f.key ? (this._sortAsc ? " ▲" : " ▼") : "";
      const label = f.label || this._formatHeader(f.key);
      const unit = f.unit ? ` <small>(${f.unit})</small>` : "";
      return `<th class="dp-sortable" data-key="${f.key}">${label}${unit}${arrow}</th>`;
    }).join("");

    // Body rows (paginated)
    const start = 0;
    const end = Math.min(features.length, (this._page + 1) * this._pageSize);
    const tbody = features.slice(start, end).map((feat, idx) => {
      const props = feat.properties || feat;
      const cells = fields.map((f) => `<td>${this._formatValue(props[f.key])}</td>`).join("");
      return `<tr data-feature-idx="${idx}">${cells}</tr>`;
    }).join("");

    const moreCount = features.length - end;

    el.innerHTML = `
      ${statsHtml}
      <table class="data-table">
        <thead>
          <tr class="dp-filter-row">${filterRow}</tr>
          <tr>${thead}</tr>
        </thead>
        <tbody>${tbody}</tbody>
      </table>
      ${moreCount > 0 ? `<button class="dp-load-more">${moreCount} éléments restants — charger plus</button>` : ""}
    `;

    this._bindEvents(el);
  },

  _bindEvents(el) {
    // Sort on header click
    el.querySelectorAll(".dp-sortable").forEach((th) => {
      th.addEventListener("click", () => {
        const key = th.dataset.key;
        if (this._sortKey === key) {
          this._sortAsc = !this._sortAsc;
        } else {
          this._sortKey = key;
          this._sortAsc = true;
        }
        this._applySort();
        this._buildTable();
      });
    });

    // Filter on input change — adapté au type
    el.querySelectorAll(".dp-filter").forEach((input) => {
      const handler = () => {
        const key = input.dataset.key;
        const filterType = input.dataset.filterType;

        if (filterType === "multi") {
          const selected = Array.from(input.selectedOptions).map((o) => o.value);
          if (selected.length > 0) {
            this._filterValues[key] = selected;
          } else {
            delete this._filterValues[key];
          }
        } else if (filterType === "range-min" || filterType === "range-max") {
          const rawVal = input.value.trim();
          if (!this._filterValues[key] || typeof this._filterValues[key] !== "object" || Array.isArray(this._filterValues[key])) {
            this._filterValues[key] = {};
          }
          if (filterType === "range-min") {
            this._filterValues[key].min = rawVal ? Number(rawVal) : undefined;
          } else {
            this._filterValues[key].max = rawVal ? Number(rawVal) : undefined;
          }
          if (this._filterValues[key].min == null && this._filterValues[key].max == null) {
            delete this._filterValues[key];
          }
        } else {
          const rawVal = input.value.trim();
          if (rawVal) {
            this._filterValues[key] = rawVal;
          } else {
            delete this._filterValues[key];
          }
        }

        this._applyFilters();
        this._buildTable();
        this._syncMapLayer();
      };
      input.addEventListener("input", handler);
      input.addEventListener("change", handler);
    });

    // Load more
    const loadMoreBtn = el.querySelector(".dp-load-more");
    if (loadMoreBtn) {
      loadMoreBtn.addEventListener("click", () => {
        this._page++;
        this._buildTable();
      });
    }

    // Row hover → carte highlight
    el.querySelectorAll("tr[data-feature-idx]").forEach((row) => {
      row.addEventListener("mouseenter", () => {
        row.classList.add("highlighted");
        GeoState.emit("feature-hover", parseInt(row.dataset.featureIdx));
      });
      row.addEventListener("mouseleave", () => {
        row.classList.remove("highlighted");
        GeoState.emit("feature-hover", null);
      });
    });
  },

  // ================================================================
  // Filter & Sort logic
  // ================================================================

  _applyFilters() {
    const entries = Object.entries(this._filterValues);
    if (entries.length === 0) {
      this._filtered = this._features;
      return;
    }
    this._filtered = this._features.filter((feat) => {
      const props = feat.properties || feat;
      return entries.every(([key, val]) => {
        const propVal = props[key];

        // Multi-sélection (tableau de valeurs)
        if (Array.isArray(val)) {
          if (propVal == null) return false;
          return val.includes(String(propVal));
        }

        // Range numérique { min, max }
        if (val && typeof val === "object" && ("min" in val || "max" in val)) {
          const num = typeof propVal === "number" ? propVal : parseFloat(propVal);
          if (isNaN(num)) return false;
          if (val.min != null && num < val.min) return false;
          if (val.max != null && num > val.max) return false;
          return true;
        }

        // Texte libre
        if (propVal == null) return false;
        const s = String(propVal).toLowerCase();
        const v = String(val).toLowerCase();
        return s === v || s.startsWith(v);
      });
    });
    this._page = 0;
  },

  _applySort() {
    if (!this._sortKey) return;
    const key = this._sortKey;
    const asc = this._sortAsc;
    this._filtered.sort((a, b) => {
      const va = (a.properties || a)[key];
      const vb = (b.properties || b)[key];
      if (va === vb) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      const cmp = typeof va === "number" && typeof vb === "number"
        ? va - vb
        : String(va).localeCompare(String(vb), "fr");
      return asc ? cmp : -cmp;
    });
  },

  /** Met à jour la couche carte pour ne montrer que les features filtrées */
  _syncMapLayer() {
    if (!this._sourceId || !window.GeoMap) return;
    const geojson = { type: "FeatureCollection", features: this._filtered };
    GeoMap.updateGeoJsonSource(this._sourceId, geojson);
  },

  // ================================================================
  // Column analysis — détecte le type optimal de filtre
  // ================================================================

  /**
   * Analyse les features pour chaque colonne :
   * - constant : 1 seule valeur → pas de filtre
   * - enum : < 25 valeurs uniques → dropdown avec comptages
   * - number : valeurs numériques → range min/max
   * - text : beaucoup de valeurs uniques → recherche libre
   */
  _analyzeColumns(fields) {
    const result = {};
    const sample = this._features; // analyser toutes les features

    for (const f of fields) {
      const values = [];
      let allNumbers = true;
      let min = Infinity, max = -Infinity;
      const counts = {};

      for (const feat of sample) {
        const v = (feat.properties || feat)[f.key];
        if (v == null) continue;
        const s = String(v);
        counts[s] = (counts[s] || 0) + 1;

        if (allNumbers && typeof v === "number") {
          if (v < min) min = v;
          if (v > max) max = v;
        } else if (allNumbers && !isNaN(Number(v))) {
          const n = Number(v);
          if (n < min) min = n;
          if (n > max) max = n;
        } else {
          allNumbers = false;
        }
        values.push(s);
      }

      const uniqueCount = Object.keys(counts).length;
      const total = values.length;

      if (uniqueCount <= 1) {
        result[f.key] = { type: "constant", total };
      } else if (allNumbers && uniqueCount > 10) {
        result[f.key] = { type: "number", min, max, total };
      } else if (uniqueCount <= 80) {
        const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
        result[f.key] = {
          type: "enum",
          values: sorted.map(([k]) => k),
          counts,
          total,
        };
      } else if (allNumbers) {
        result[f.key] = { type: "number", min, max, total };
      } else {
        result[f.key] = { type: "text", uniqueCount, total };
      }
    }
    return result;
  },

  // ================================================================
  // Field resolution
  // ================================================================

  _resolveFields() {
    let fields;
    // Si on a les définitions du serveur, les utiliser
    if (this._meta.fields?.length > 0) {
      fields = this._meta.fields.filter((f) => f.type !== "geometry");
    } else {
      // Sinon auto-détecter depuis les features
      const excluded = new Set(["geometry", "bbox", "id", "gml_id", "fid"]);
      const keys = new Set();
      for (const f of this._features.slice(0, 50)) {
        const props = f.properties || f;
        for (const k of Object.keys(props)) {
          if (!excluded.has(k) && typeof props[k] !== "object") keys.add(k);
        }
      }
      fields = [...keys].slice(0, 12).map((k) => ({ key: k, label: this._formatHeader(k) }));
    }

    // Exclure les colonnes constantes (inutiles pour l'analyse)
    if (this._colAnalysis) {
      fields = fields.filter((f) => {
        const col = this._colAnalysis[f.key];
        return !col || col.type !== "constant";
      });
    }
    return fields;
  },

  // ================================================================
  // Stats
  // ================================================================

  _buildStats(features, fields) {
    const cards = [];
    const total = features.length;
    cards.push(`<div class="stat-card"><div class="value">${total.toLocaleString("fr-FR")}</div><div class="label">éléments</div></div>`);

    // Stats numériques sur les champs primary avec unit
    for (const f of fields) {
      if (f.unit && f.type === "number") {
        const vals = features
          .map((ft) => (ft.properties || ft)[f.key])
          .filter((v) => typeof v === "number" && !isNaN(v));
        if (vals.length > 0) {
          const sum = vals.reduce((a, b) => a + b, 0);
          const label = f.label || f.key;
          cards.push(`<div class="stat-card"><div class="value">${sum.toLocaleString("fr-FR")}</div><div class="label">${label} (${f.unit})</div></div>`);
        }
      }
    }

    // Distribution visuelle pour les champs enum (barres proportionnelles)
    const analysis = this._colAnalysis || {};
    for (const f of fields) {
      const col = analysis[f.key];
      if (!col || col.type !== "enum" || col.values.length <= 1 || col.values.length > 12) continue;
      // Ne montrer que pour les champs intéressants (primary ou peu de valeurs)
      if (!f.primary && col.values.length > 6) continue;

      const sorted = col.values.map((v) => ({ value: v, count: col.counts[v] || 0 }));
      const maxCount = Math.max(...sorted.map((s) => s.count));

      const barsHtml = sorted.slice(0, 8).map((s) => {
        const pct = Math.round((s.count / total) * 100);
        const barW = Math.max(4, Math.round((s.count / maxCount) * 100));
        const label = s.value.length > 18 ? s.value.slice(0, 16) + "…" : s.value;
        return `<div class="dist-row">
          <span class="dist-label" title="${s.value}">${label}</span>
          <div class="dist-bar-bg"><div class="dist-bar" style="width:${barW}%"></div></div>
          <span class="dist-count">${s.count} <small>(${pct}%)</small></span>
        </div>`;
      }).join("");

      cards.push(`<div class="stat-card stat-dist" style="grid-column:span 2">
        <div class="label" style="margin-bottom:6px">${f.label || f.key}</div>
        ${barsHtml}
      </div>`);
    }

    return `<div class="stat-grid">${cards.join("")}</div>`;
  },

  // ================================================================
  // Formatting helpers
  // ================================================================

  _formatHeader(key) {
    return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Id$/, "ID");
  },

  _formatValue(val) {
    if (val === null || val === undefined) return "—";
    if (typeof val === "number") {
      return Number.isInteger(val) ? val.toLocaleString("fr-FR") : val.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
    }
    if (typeof val === "boolean") return val ? "Oui" : "Non";
    const s = String(val);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  },

  _renderText(text) {
    const html = text
      .replace(/── (.+?) ──/g, "<h4 style='margin:12px 0 6px;color:var(--accent)'>$1</h4>")
      .replace(/\n/g, "<br>");
    return `<div style="font-size:12px;line-height:1.6">${html}</div>`;
  },

  _renderJson(obj) {
    return `<pre style="font-size:11px;overflow-x:auto">${JSON.stringify(obj, null, 2)}</pre>`;
  },
};

window.DataPanel = DataPanel;
