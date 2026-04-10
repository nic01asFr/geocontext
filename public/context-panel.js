/**
 * Panneau contexte — hiérarchie territoriale + thèmes + actions.
 *
 * Interactions :
 *   - Clic en-tête thème → charge le thème (action MCP) + ouvre l'accordéon
 *   - Clic sous-action  → charge l'action (action MCP)
 *   - Clic hiérarchie   → navigate vers le territoire
 *
 * Les résultats sont rendus sur la carte + data-panel, jamais dans le chat.
 */

const THEME_ICONS = {
  "info": "ℹ️", "building": "🏛️", "map-pin": "📍", "alert-triangle": "⚠️",
  "leaf": "🌿", "truck": "🚛", "droplets": "💧", "briefcase": "💼",
  "home": "🏠", "zap": "⚡", "layers": "🗂️", "bar-chart": "📊",
};

const ContextPanel = {
  _openThemes: new Set(),
  _loadingAction: null,

  init() {
    GeoState.on("context-changed", (ctx) => this.renderHierarchy(ctx));
    GeoState.on("themes-changed", (themes) => this.renderThemes(themes));
    GeoState.on("action-counts-changed", () => this.renderThemes(GeoState.context.themes || []));
  },

  /** Affiche/masque un spinner global sur le panel. */
  setLoading(loading) {
    const el = document.getElementById("panel-context");
    if (loading) {
      el.classList.add("is-loading");
    } else {
      el.classList.remove("is-loading");
    }
  },

  /** Marque un bouton d'action comme en chargement. */
  setActionLoading(action, loading) {
    this._loadingAction = loading ? action : null;
    // Re-render pour mettre à jour les visuels
    this.renderThemes(GeoState.context.themes || []);
  },

  // ================================================================
  // Hiérarchie
  // ================================================================

  renderHierarchy(ctx) {
    const el = document.getElementById("hierarchy-tree");
    if (!ctx.level) {
      el.innerHTML = '<p class="placeholder">Recherchez un lieu pour commencer.</p>';
      return;
    }

    const h = ctx.hierarchy || {};
    const levels = ["region", "departement", "epci", "commune", "parcelle", "batiment"];
    let html = "";

    for (const level of levels) {
      const entry = h[level];
      if (!entry) continue;

      const indent = levels.indexOf(level);
      const isActive = level === ctx.level;
      const cls = `tree-node${isActive ? " active" : ""}`;
      const style = indent > 0 ? ` style="margin-left:${indent * 14}px"` : "";

      html += `
        <div class="${cls}"${style} data-level="${level}" data-code="${entry.code}">
          <span class="level-tag">${this._levelLabel(level)}</span>
          <span class="tree-name">${entry.name || entry.code}</span>
        </div>
      `;
    }

    el.innerHTML = html;

    el.querySelectorAll(".tree-node").forEach((node) => {
      node.addEventListener("click", () => {
        const code = node.dataset.code;
        if (code) GeoState.emit("navigate-request", code);
      });
    });
  },

  _levelLabel(level) {
    const labels = {
      region: "RÉG", departement: "DÉP", epci: "EPCI",
      commune: "COM", parcelle: "PAR", batiment: "BÂT",
    };
    return labels[level] || level.toUpperCase().slice(0, 3);
  },

  // ================================================================
  // Thèmes en accordéon
  // ================================================================

  renderThemes(themes) {
    const el = document.getElementById("themes-list");
    const actionsSection = document.getElementById("actions-section");
    if (actionsSection) actionsSection.classList.add("hidden");

    if (!themes || themes.length === 0) {
      el.innerHTML = "";
      return;
    }

    const ctx = GeoState.context;
    const counts = GeoState.actionCounts || {};

    el.innerHTML = themes.map((t) => {
      const isActive = ctx.theme === t.id;
      const isOpen = this._openThemes.has(t.id) || isActive;
      const icon = THEME_ICONS[t.icon] || t.icon || "📊";
      const actions = t.actions || [];

      const actionsHtml = actions.map((a) => {
        const count = counts[a];
        const isLoading = this._loadingAction === a;
        const badge = isLoading
          ? '<span class="action-spinner"></span>'
          : count !== undefined
            ? `<span class="action-count">${count}</span>`
            : "";
        const cls = `action-btn${isLoading ? " loading" : ""}`;
        return `<button class="${cls}" data-action="${a}">${a}${badge}</button>`;
      }).join("");

      return `
        <div class="theme-accordion${isActive ? " active-theme" : ""}" data-theme-id="${t.id}">
          <button class="theme-accordion-header${isActive ? " active" : ""}${isOpen ? " open" : ""}"
                  data-theme="${t.id}">
            <span class="icon">${icon}</span>
            <span class="label">${t.label}</span>
            <span class="chevron">${isOpen ? "▲" : "▼"}</span>
          </button>
          <div class="theme-accordion-body${isOpen ? " open" : ""}">
            ${actionsHtml || '<span class="placeholder">Chargement…</span>'}
          </div>
        </div>
      `;
    }).join("");

    // Clics en-tête de thème → charge le thème via action MCP
    el.querySelectorAll(".theme-accordion-header").forEach((btn) => {
      btn.addEventListener("click", () => {
        const themeId = btn.dataset.theme;
        const isCurrentlyOpen = this._openThemes.has(themeId);
        const isActive = ctx.theme === themeId;

        if (isCurrentlyOpen && isActive) {
          // Fermer si déjà actif et ouvert
          this._openThemes.delete(themeId);
          this.renderThemes(GeoState.context.themes || []);
        } else {
          // Ouvrir et charger le thème
          this._openThemes.add(themeId);
          if (!isActive) {
            // Déclencher le chargement du thème
            GeoState.emit("action-request", themeId);
          } else {
            this.renderThemes(GeoState.context.themes || []);
          }
        }
      });
    });

    // Clics sous-actions → charger l'action (le serveur résout le thème implicitement)
    el.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        GeoState.emit("action-request", btn.dataset.action);
      });
    });
  },
};

window.ContextPanel = ContextPanel;
