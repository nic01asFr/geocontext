/**
 * Panneau de données thématiques — affiche les résultats sous la carte.
 *
 * Écoute les événements de données et génère des tableaux et statistiques.
 */

const DataPanel = {
  init() {
    // Fermer le panneau
    document.getElementById("data-close").addEventListener("click", () => {
      this.hide();
    });
  },

  show() {
    document.getElementById("data-panel").classList.remove("hidden");
  },

  hide() {
    document.getElementById("data-panel").classList.add("hidden");
  },

  /**
   * Affiche les résultats d'un tool call MCP.
   *
   * @param {string} title - Titre du panneau
   * @param {object} result - Résultat du tool call (content[0].text)
   * @param {object[]} [geojsonFeatures] - Features GeoJSON optionnelles
   */
  render(title, result, geojsonFeatures) {
    const titleEl = document.getElementById("data-title");
    const contentEl = document.getElementById("data-content");

    titleEl.textContent = title;

    // Si on a des features GeoJSON avec propriétés, faire un tableau
    if (geojsonFeatures && geojsonFeatures.length > 0) {
      contentEl.innerHTML = this._renderFeatureTable(geojsonFeatures);
    } else if (typeof result === "string") {
      contentEl.innerHTML = this._renderText(result);
    } else {
      contentEl.innerHTML = this._renderJson(result);
    }

    this.show();

    // Hover sur lignes du tableau → highlight sur la carte
    contentEl.querySelectorAll("tr[data-feature-idx]").forEach((row) => {
      row.addEventListener("mouseenter", () => {
        row.classList.add("highlighted");
        // Émettre un événement de highlight
        GeoState.emit("feature-hover", parseInt(row.dataset.featureIdx));
      });
      row.addEventListener("mouseleave", () => {
        row.classList.remove("highlighted");
        GeoState.emit("feature-hover", null);
      });
    });
  },

  /**
   * Génère un tableau HTML à partir de features GeoJSON.
   */
  _renderFeatureTable(features) {
    if (features.length === 0) return "<p>Aucune donnée.</p>";

    // Extraire les propriétés (exclure les clés techniques)
    const excluded = new Set(["geometry", "bbox", "id", "gml_id", "fid"]);
    const allKeys = new Set();
    for (const f of features.slice(0, 50)) {
      const props = f.properties || f;
      for (const k of Object.keys(props)) {
        if (!excluded.has(k) && typeof props[k] !== "object") {
          allKeys.add(k);
        }
      }
    }
    const keys = [...allKeys].slice(0, 10); // Max 10 colonnes

    // Stats rapides
    let statsHtml = "";
    if (features.length > 1) {
      statsHtml = `
        <div class="stat-grid">
          <div class="stat-card">
            <div class="value">${features.length}</div>
            <div class="label">éléments</div>
          </div>
        </div>
      `;
    }

    // Tableau
    const thead = keys.map((k) => `<th>${this._formatHeader(k)}</th>`).join("");
    const tbody = features.slice(0, 100).map((f, idx) => {
      const props = f.properties || f;
      const cells = keys.map((k) => `<td>${this._formatValue(props[k])}</td>`).join("");
      return `<tr data-feature-idx="${idx}">${cells}</tr>`;
    }).join("");

    return `
      ${statsHtml}
      <table class="data-table">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
      ${features.length > 100 ? `<p style="color:var(--text-muted);margin-top:8px">${features.length - 100} éléments supplémentaires non affichés.</p>` : ""}
    `;
  },

  /** Formate un nom de colonne. */
  _formatHeader(key) {
    return key
      .replace(/_/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase())
      .replace(/^Id$/, "ID");
  },

  /** Formate une valeur de cellule. */
  _formatValue(val) {
    if (val === null || val === undefined) return "—";
    if (typeof val === "number") {
      if (Number.isInteger(val)) return val.toLocaleString("fr-FR");
      return val.toLocaleString("fr-FR", { maximumFractionDigits: 2 });
    }
    if (typeof val === "boolean") return val ? "Oui" : "Non";
    const s = String(val);
    return s.length > 60 ? s.slice(0, 57) + "…" : s;
  },

  /** Rend du texte brut avec formatage minimal. */
  _renderText(text) {
    // Convertir les sections ── Titre ── en headers
    const html = text
      .replace(/── (.+?) ──/g, "<h4 style='margin:12px 0 6px;color:var(--accent)'>$1</h4>")
      .replace(/\n/g, "<br>");
    return `<div style="font-size:12px;line-height:1.6">${html}</div>`;
  },

  /** Rend du JSON formaté. */
  _renderJson(obj) {
    return `<pre style="font-size:11px;overflow-x:auto">${JSON.stringify(obj, null, 2)}</pre>`;
  },
};

window.DataPanel = DataPanel;
