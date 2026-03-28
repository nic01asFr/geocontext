/**
 * Panneau contexte — hiérarchie territoriale + thèmes + actions.
 *
 * Écoute les changements de GeoState et met à jour le DOM.
 * Les clics émettent des actions MCP (navigate, action).
 */

const ContextPanel = {
  init() {
    GeoState.on("context-changed", (ctx) => this.renderHierarchy(ctx));
    GeoState.on("themes-changed", (themes) => this.renderThemes(themes));
    GeoState.on("tools-changed", () => this.renderActions());
    GeoState.on("action-counts-changed", () => this.renderActions());
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
      const style = indent > 0 ? ` style="margin-left:${indent * 16}px"` : "";

      html += `
        <div class="${cls}"${style} data-level="${level}" data-code="${entry.code}">
          <span class="level-tag">${this._levelLabel(level)}</span>
          <span>${entry.name || entry.code}</span>
        </div>
      `;
    }

    el.innerHTML = html;

    // Clics → navigate
    el.querySelectorAll(".tree-node").forEach((node) => {
      node.addEventListener("click", () => {
        const code = node.dataset.code;
        if (code) GeoState.emit("navigate-request", code);
      });
    });
  },

  _levelLabel(level) {
    const labels = {
      region: "RÉG",
      departement: "DÉP",
      epci: "EPCI",
      commune: "COM",
      parcelle: "PAR",
      batiment: "BÂT",
    };
    return labels[level] || level.toUpperCase().slice(0, 3);
  },

  // ================================================================
  // Thèmes
  // ================================================================

  renderThemes(themes) {
    const el = document.getElementById("themes-list");
    const ctx = GeoState.context;

    if (!themes || themes.length === 0) {
      el.innerHTML = "";
      return;
    }

    el.innerHTML = themes
      .map((t) => {
        const isActive = ctx.theme === t.id;
        return `
          <button class="theme-btn${isActive ? " active" : ""}" data-theme="${t.id}">
            <span class="icon">${t.icon || "📊"}</span>
            <span class="label">${t.label}</span>
          </button>
        `;
      })
      .join("");

    // Clics → action(thème)
    el.querySelectorAll(".theme-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const theme = btn.dataset.theme;
        GeoState.emit("action-request", theme);
      });
    });
  },

  // ================================================================
  // Actions (sous-actions du thème actif)
  // ================================================================

  renderActions() {
    const section = document.getElementById("actions-section");
    const el = document.getElementById("actions-list");
    const titleEl = document.getElementById("actions-title");

    if (!GeoState.context.theme || !GeoState.hasAction()) {
      section.classList.add("hidden");
      return;
    }

    const enums = GeoState.getActionEnums();
    if (enums.length === 0) {
      section.classList.add("hidden");
      return;
    }

    // Si les enums sont des thèmes, ne pas afficher (déjà dans la section thèmes)
    const themIds = (GeoState.context.themes || []).map((t) => t.id || t);
    const isThemeList = enums.every((e) => themIds.includes(e));
    if (isThemeList) {
      section.classList.add("hidden");
      return;
    }

    const counts = GeoState.actionCounts;

    // Filtrer les actions avec 0 résultats connus
    const visibleEnums = enums.filter((a) => counts[a] === undefined || counts[a] > 0);

    if (visibleEnums.length === 0) {
      section.classList.add("hidden");
      return;
    }

    section.classList.remove("hidden");
    titleEl.textContent = `Actions — ${GeoState.context.theme}`;

    el.innerHTML = visibleEnums
      .map((a) => {
        const count = counts[a];
        const badge = count !== undefined
          ? `<span class="action-count">${count}</span>`
          : "";
        return `<button class="action-btn" data-action="${a}">${a}${badge}</button>`;
      })
      .join("");

    el.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        GeoState.emit("action-request", btn.dataset.action);
      });
    });
  },
};

window.ContextPanel = ContextPanel;
