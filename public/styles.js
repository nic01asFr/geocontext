/**
 * Styles thématiques et utilitaires pour la carte geocontext.
 *
 * - Palette par thème (urbanisme, risques, environnement…)
 * - Expression MapLibre data-driven pour les zones PLU
 * - Rendu HTML des popups de features
 */

const GeoStyles = {
  /** Couleurs par thème. */
  THEME_PALETTE: {
    urbanisme:     { color: "#e88a3a", opacity: 0.35, stroke: "#c4671a", strokeWidth: 1.5 },
    cadastre:      { color: "#c4a44a", opacity: 0.3,  stroke: "#9a7c30", strokeWidth: 1.0 },
    risques:       { color: "#d94f3a", opacity: 0.35, stroke: "#a83020", strokeWidth: 1.5 },
    environnement: { color: "#4aad7a", opacity: 0.35, stroke: "#2a8a55", strokeWidth: 1.5 },
    bati:          { color: "#5a7aad", opacity: 0.5,  stroke: "#3a5a8a", strokeWidth: 1.0 },
    hydrologie:    { color: "#3a8abe", opacity: 0.45, stroke: "#1a5a8a", strokeWidth: 1.5 },
    economie:      { color: "#8a5abd", opacity: 0.7,  stroke: "#6a3a9a", strokeWidth: 1.5 },
    demographique: { color: "#bd5a8a", opacity: 0.7,  stroke: "#9a3a6a", strokeWidth: 1.5 },
  },

  /**
   * Retourne le style par défaut pour un thème.
   * Fallback sur bleu neutre si thème inconnu.
   */
  forTheme(theme) {
    return this.THEME_PALETTE[theme] || { color: "#5b8def", opacity: 0.3, stroke: "#3a6bd5", strokeWidth: 1.5 };
  },

  /**
   * Expression MapLibre fill-color data-driven pour les zones PLU (typezone).
   * Couvre les cas courants du GPU : U, AU, A, N et variantes.
   */
  pluFillColor() {
    return [
      "match", ["get", "typezone"],
      "U",   "#f4a460",   // Urbain — orange sable
      "Ub",  "#e8b06a",
      "Uc",  "#dca060",
      "Ud",  "#f0945a",
      "AUc", "#ffe066",   // À urbaniser conditionnel — jaune
      "AUs", "#ffd040",   // À urbaniser strict — jaune foncé
      "AU",  "#ffe580",   // À urbaniser — jaune clair
      "1AU", "#ffe580",
      "2AU", "#ffd040",
      "A",   "#a8d48a",   // Agricole — vert clair
      "Aa",  "#98c47a",
      "Ap",  "#b8e49a",
      "N",   "#5a9e5a",   // Naturel — vert
      "Nr",  "#4a8e4a",   // Naturel réservé — vert foncé
      "Nh",  "#6aae6a",   // Naturel habité — vert moyen
      "Np",  "#7abe7a",   // Naturel paysager — vert vif
      "#b0b0b0",           // Default — gris
    ];
  },

  /**
   * Construit le HTML d'une popup de feature.
   * @param {string} label - Titre de la couche
   * @param {Object} props - Propriétés de la feature
   * @param {string[]} primaryFields - Champs à afficher en priorité
   */
  popupHtml(label, props, primaryFields) {
    // Exclure les champs techniques / geometrie
    const exclude = new Set(["the_geom", "geometrie", "geom", "shape", "bbox"]);

    const fields = primaryFields && primaryFields.length > 0
      ? primaryFields
      : Object.keys(props).filter(k => !exclude.has(k)).slice(0, 6);

    const rows = fields
      .filter(k => props[k] !== null && props[k] !== undefined && String(props[k]).trim() !== "")
      .map(k => {
        const v = String(props[k]);
        return `<tr><td class="pk">${k}</td><td>${v.length > 80 ? v.slice(0, 80) + "…" : v}</td></tr>`;
      })
      .join("");

    return `<div class="map-popup">
      <div class="popup-title">${label || "Feature"}</div>
      ${rows ? `<table class="popup-table">${rows}</table>` : ""}
    </div>`;
  },
};

window.GeoStyles = GeoStyles;
