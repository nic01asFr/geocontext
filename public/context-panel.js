/**
 * Panneau contexte — hiérarchie territoriale + thèmes + actions.
 *
 * Thèmes et actions sont regroupés en accordéon :
 *   - Clic sur l'en-tête → ouvre/ferme l'accordéon (pas d'appel MCP)
 *   - Les sous-actions viennent de la resource themes (pas besoin d'appeler action)
 *   - Clic sur une sous-action → appelle action(sub) directement
 */

const THEME_ICONS = {
  "info": "ℹ️", "building": "🏛️", "map-pin": "📍", "alert-triangle": "⚠️",
  "leaf": "🌿", "truck": "🚛", "droplets": "💧", "briefcase": "💼",
  "home": "🏠", "zap": "⚡", "layers": "🗂️", "bar-chart": "📊",
};

const ContextPanel = {
  _openThemes: new Set(),

  init() {
    GeoState.on("context-changed", (ctx) => this.renderHierarchy(ctx));
    GeoState.on("themes-changed", (themes) => this.renderThemes(themes));
    GeoState.on("action-counts-changed", () => this.renderThemes(GeoState.context.themes || []));
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
          <span>${entry.name || entry.code}</span>
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
  // Thèmes en accordéon avec actions pré-chargées
  // ================================================================

  renderThemes(themes) {
    const el = document.getElementById("themes-list");

    // Masquer la section actions (plus nécessaire, tout est dans l'accordéon)
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
        const badge = count !== undefined
          ? `<span class="action-count">${count}</span>`
          : "";
        return `<button class="action-btn" data-action="${a}">${a}${badge}</button>`;
      }).join("");

      return `
        <div class="theme-accordion" data-theme-id="${t.id}">
          <button class="theme-accordion-header${isActive ? " active" : ""}${isOpen ? " open" : ""}"
                  data-theme="${t.id}">
            <span class="icon">${icon}</span>
            <span class="label">${t.label}</span>
            <span class="chevron">▼</span>
          </button>
          <div class="theme-accordion-body${isOpen ? " open" : ""}">
            ${actionsHtml}
          </div>
        </div>
      `;
    }).join("");

    // Clics sur en-têtes → toggle ouverture (pas d'appel MCP)
    el.querySelectorAll(".theme-accordion-header").forEach((btn) => {
      btn.addEventListener("click", () => {
        const themeId = btn.dataset.theme;
        if (this._openThemes.has(themeId)) {
          this._openThemes.delete(themeId);
        } else {
          this._openThemes.add(themeId);
        }
        this.renderThemes(GeoState.context.themes || []);
      });
    });

    // Clics sur sous-actions → appel MCP direct
    el.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        GeoState.emit("action-request", btn.dataset.action);
      });
    });
  },
};

window.ContextPanel = ContextPanel;
