/**
 * geocontext — Deterministic Style Generator
 *
 * Génère un StyleRecipe à partir des métadonnées d'une SourceDef
 * et d'un échantillon de features. Aucun appel réseau.
 *
 * Logique de classification :
 *   1. Champ enum primaire → catégoriel (couleurs dans la famille du thème)
 *   2. Champ numérique primaire → gradué (5 classes quantiles)
 *   3. Sinon → mono-couleur thématique
 *
 * Cas spéciaux :
 *   - PLU typezone → palette urbanisme historique
 *   - Risques avec niveaux (fort/moyen/faible) → rouge→jaune
 */

import type { SourceDef, FieldDef } from "../registry/types.js";
import type {
  StyleRecipe,
  LegendConfig,
  LegendItem,
  Classification,
  CategoricalClassification,
  GraduatedClassification,
} from "./types.js";

// ==========================================================================
// Palette thématique — teinte de base par thème
// ==========================================================================

const THEME_HUES: Record<string, { h: number; s: number; base: string; stroke: string }> = {
  identite:      { h: 220, s: 55, base: "#5b8def", stroke: "#3a6bd5" },
  urbanisme:     { h: 28,  s: 75, base: "#e88a3a", stroke: "#c4671a" },
  cadastre:      { h: 42,  s: 55, base: "#c4a44a", stroke: "#9a7c30" },
  risques:       { h: 8,   s: 70, base: "#d94f3a", stroke: "#a83020" },
  environnement: { h: 150, s: 55, base: "#4aad7a", stroke: "#2a8a55" },
  transport:     { h: 260, s: 40, base: "#7a6aad", stroke: "#5a4a8a" },
  hydrologie:    { h: 200, s: 60, base: "#3a8abe", stroke: "#1a5a8a" },
  economie:      { h: 270, s: 50, base: "#8a5abd", stroke: "#6a3a9a" },
  bati:          { h: 215, s: 40, base: "#5a7aad", stroke: "#3a5a8a" },
  energie:       { h: 45,  s: 80, base: "#d4a017", stroke: "#a07a10" },
};

function getThemeColors(theme: string) {
  return THEME_HUES[theme] || THEME_HUES.identite;
}

// ==========================================================================
// Palette PLU spéciale (expression MapLibre)
// ==========================================================================

const PLU_COLORS: Record<string, string> = {
  U: "#f4a460", Ub: "#e8b06a", Uc: "#dca060", Ud: "#f0945a",
  AU: "#ffe580", "1AU": "#ffe580", "2AU": "#ffd040",
  AUc: "#ffe066", AUs: "#ffd040",
  A: "#a8d48a", Aa: "#98c47a", Ap: "#b8e49a",
  N: "#5a9e5a", Nr: "#4a8e4a", Nh: "#6aae6a", Np: "#7abe7a",
};

const PLU_LEGEND_GROUPS: { label: string; color: string; prefixes: string[] }[] = [
  { label: "Urbaine (U)",         color: "#f4a460", prefixes: ["U"] },
  { label: "À urbaniser (AU)",    color: "#ffe580", prefixes: ["AU", "1AU", "2AU", "AUc", "AUs"] },
  { label: "Agricole (A)",        color: "#a8d48a", prefixes: ["A", "Aa", "Ap"] },
  { label: "Naturelle (N)",       color: "#5a9e5a", prefixes: ["N", "Nr", "Nh", "Np"] },
];

// ==========================================================================
// Palettes séquentielles pour gradué
// ==========================================================================

const SEQUENTIAL_RAMPS: Record<string, string[]> = {
  // Rouge (risques)
  red:    ["#fee5d9", "#fcae91", "#fb6a4a", "#de2d26", "#a50f15"],
  // Bleu (hydro, identité)
  blue:   ["#eff3ff", "#bdd7e7", "#6baed6", "#3182bd", "#08519c"],
  // Vert (environnement)
  green:  ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"],
  // Orange (urbanisme, énergie)
  orange: ["#feedde", "#fdbe85", "#fd8d3c", "#e6550d", "#a63603"],
  // Violet (économie)
  purple: ["#f2f0f7", "#cbc9e2", "#9e9ac8", "#756bb1", "#54278f"],
};

function getRamp(theme: string): string[] {
  const map: Record<string, string> = {
    risques: "red", hydrologie: "blue", environnement: "green",
    urbanisme: "orange", energie: "orange", economie: "purple",
  };
  return SEQUENTIAL_RAMPS[map[theme] || "blue"];
}

// ==========================================================================
// Génération de couleurs catégorielles dans une famille de teinte
// ==========================================================================

function generateCategoricalColors(
  baseHue: number,
  count: number,
): string[] {
  const colors: string[] = [];
  // Varier la teinte dans ±30° autour du hue de base, et la luminosité
  for (let i = 0; i < count; i++) {
    const hueShift = (i / Math.max(count - 1, 1)) * 60 - 30;
    const h = (baseHue + hueShift + 360) % 360;
    const s = 55 + (i % 3) * 10; // 55-75%
    const l = 45 + (i % 4) * 8;  // 45-69%
    colors.push(hslToHex(h, s, l));
  }
  return colors;
}

function hslToHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const color = l - a * Math.max(Math.min(k - 3, 9 - k, 1), -1);
    return Math.round(255 * color).toString(16).padStart(2, "0");
  };
  return `#${f(0)}${f(8)}${f(4)}`;
}

// ==========================================================================
// Point d'entrée : deriveStyleRecipe
// ==========================================================================

/**
 * Génère un StyleRecipe déterministe pour une source.
 *
 * @param source    — définition de la source
 * @param features  — échantillon de features (5-50, déjà transformées)
 * @param label     — label contextuel pour la légende (ex: "Zonages PLU — Besançon")
 */
export function deriveStyleRecipe(
  source: SourceDef,
  features: Record<string, unknown>[],
  label?: string,
): StyleRecipe {
  const theme = source.theme;
  const themeColors = getThemeColors(theme);
  const geomType = detectGeometryType(source, features);
  const legendTitle = label || source.label;

  // ── Cas spécial PLU ──
  if (hasPluTypezone(source)) {
    return buildPluStyle(source, features, geomType, legendTitle);
  }

  // ── Chercher un champ classifiant ──
  const enumField = findClassifyingEnumField(source);
  if (enumField) {
    return buildCategoricalStyle(source, enumField, features, geomType, themeColors, legendTitle);
  }

  const numField = findClassifyingNumberField(source);
  if (numField && features.length >= 3) {
    return buildGraduatedStyle(source, numField, features, geomType, theme, legendTitle);
  }

  // ── Fallback mono-couleur ──
  return buildSingleStyle(source, features, geomType, themeColors, legendTitle);
}

// ==========================================================================
// Détection
// ==========================================================================

function detectGeometryType(
  source: SourceDef,
  features: Record<string, unknown>[],
): "point" | "line" | "polygon" {
  // Depuis geoFields → points REST
  if (source.geoFields) return "point";

  // Depuis les features si elles ont des géométries inline
  for (const f of features) {
    const geom = f.geometry || f.the_geom || f.geometrie;
    if (geom && typeof geom === "object" && "type" in (geom as any)) {
      const t = (geom as any).type as string;
      if (t.includes("Polygon")) return "polygon";
      if (t.includes("Line")) return "line";
      if (t.includes("Point")) return "point";
    }
  }

  // Heuristique depuis le typename
  const tn = (source.typename || "").toLowerCase();
  if (tn.includes("zone") || tn.includes("parcelle") || tn.includes("section"))
    return "polygon";
  if (tn.includes("route") || tn.includes("troncon") || tn.includes("cours"))
    return "line";

  return "polygon"; // défaut raisonnable pour données territoriales
}

function hasPluTypezone(source: SourceDef): boolean {
  return source.fields.some(
    (f) => f.key === "typezone" && f.type === "enum",
  );
}

function findClassifyingEnumField(source: SourceDef): FieldDef | null {
  // Priorité : champ enum primaire
  const primary = source.fields.find(
    (f) => f.type === "enum" && f.primary && f.enumValues && Object.keys(f.enumValues).length <= 15,
  );
  if (primary) return primary;

  // Fallback : premier champ enum avec enumValues
  return source.fields.find(
    (f) => f.type === "enum" && f.enumValues && Object.keys(f.enumValues).length > 1,
  ) ?? null;
}

function findClassifyingNumberField(source: SourceDef): FieldDef | null {
  return source.fields.find(
    (f) => f.type === "number" && f.primary && f.key !== "id",
  ) ?? null;
}

// ==========================================================================
// Builders
// ==========================================================================

function buildPluStyle(
  source: SourceDef,
  features: Record<string, unknown>[],
  geomType: "point" | "line" | "polygon",
  legendTitle: string,
): StyleRecipe {
  // Construire l'expression MapLibre match
  const matchExpr: unknown[] = ["match", ["get", "typezone"]];
  for (const [val, color] of Object.entries(PLU_COLORS)) {
    matchExpr.push(val, color);
  }
  matchExpr.push("#b0b0b0"); // default

  // Compter par groupe pour la légende
  const counts = countByField(features, "typezone");
  const legend: LegendConfig = {
    title: legendTitle,
    items: PLU_LEGEND_GROUPS.map((g) => {
      const count = g.prefixes.reduce(
        (sum, p) => sum + Object.entries(counts)
          .filter(([k]) => k === p || k.startsWith(p))
          .reduce((s, [, c]) => s + c, 0),
        0,
      );
      return { label: g.label, color: g.color, count };
    }).filter((item) => item.count > 0),
  };

  const classification: CategoricalClassification = {
    method: "categorical",
    field: "typezone",
    colorMap: PLU_COLORS,
  };

  return {
    sourceId: source.id,
    geometryType: geomType,
    paint: { "fill-color": matchExpr, "fill-opacity": 0.4 },
    linePaint: { "line-color": "#8a7050", "line-width": 0.8, "line-opacity": 0.6 },
    classification,
    legend,
    labelTemplate: "{libelle} ({typezone})",
  };
}

function buildCategoricalStyle(
  source: SourceDef,
  field: FieldDef,
  features: Record<string, unknown>[],
  geomType: "point" | "line" | "polygon",
  themeColors: { h: number; s: number; base: string; stroke: string },
  legendTitle: string,
): StyleRecipe {
  const enumValues = field.enumValues || {};
  const keys = Object.keys(enumValues);
  const colors = generateCategoricalColors(themeColors.h, keys.length);
  const colorMap: Record<string, string> = {};
  keys.forEach((k, i) => { colorMap[k] = colors[i]; });

  // Compter les occurrences dans les features
  const counts = countByField(features, field.key);

  // Expression MapLibre match
  const matchExpr: unknown[] = ["match", ["get", field.key]];
  for (const [val, color] of Object.entries(colorMap)) {
    matchExpr.push(val, color);
  }
  matchExpr.push(themeColors.base); // default

  const legend: LegendConfig = {
    title: legendTitle,
    items: keys.map((k) => ({
      label: enumValues[k] || k,
      color: colorMap[k],
      count: counts[k] || 0,
    })).filter((item) => item.count > 0 || features.length === 0),
  };

  const classification: CategoricalClassification = {
    method: "categorical",
    field: field.key,
    colorMap,
  };

  const paint = buildPaintForGeom(geomType, matchExpr, themeColors);

  return {
    sourceId: source.id,
    geometryType: geomType,
    paint: paint.main,
    linePaint: paint.line,
    classification,
    legend,
    labelTemplate: buildLabelTemplate(source),
  };
}

function buildGraduatedStyle(
  source: SourceDef,
  field: FieldDef,
  features: Record<string, unknown>[],
  geomType: "point" | "line" | "polygon",
  theme: string,
  legendTitle: string,
): StyleRecipe {
  const values = features
    .map((f) => Number(f[field.key]))
    .filter((v) => !isNaN(v))
    .sort((a, b) => a - b);

  if (values.length < 3) {
    const themeColors = getThemeColors(theme);
    return buildSingleStyle(source, features, geomType, themeColors, legendTitle);
  }

  const ramp = getRamp(theme);
  const breaks = quantileBreaks(values, ramp.length);

  // Expression MapLibre step
  const stepExpr: unknown[] = ["step", ["get", field.key], ramp[0]];
  for (let i = 1; i < breaks.length; i++) {
    stepExpr.push(breaks[i], ramp[Math.min(i, ramp.length - 1)]);
  }

  const unit = field.unit ? ` ${field.unit}` : "";
  const legend: LegendConfig = {
    title: legendTitle,
    items: breaks.map((b, i) => {
      if (i >= ramp.length) return null;
      const lo = formatNum(breaks[i]);
      const hi = i < breaks.length - 1 ? formatNum(breaks[i + 1]) : "+";
      return {
        label: `${lo}–${hi}${unit}`,
        color: ramp[i],
      };
    }).filter(Boolean) as LegendItem[],
  };

  const classification: GraduatedClassification = {
    method: "graduated",
    field: field.key,
    breaks,
    colors: ramp,
  };

  const themeColors = getThemeColors(theme);
  const paint = buildPaintForGeom(geomType, stepExpr, themeColors);

  return {
    sourceId: source.id,
    geometryType: geomType,
    paint: paint.main,
    linePaint: paint.line,
    classification,
    legend,
    labelTemplate: buildLabelTemplate(source),
  };
}

function buildSingleStyle(
  source: SourceDef,
  features: Record<string, unknown>[],
  geomType: "point" | "line" | "polygon",
  themeColors: { h: number; s: number; base: string; stroke: string },
  legendTitle: string,
): StyleRecipe {
  const paint = buildPaintForGeom(geomType, themeColors.base, themeColors);

  const legend: LegendConfig = {
    title: legendTitle,
    items: [{
      label: source.label,
      color: themeColors.base,
      count: features.length,
    }],
  };

  return {
    sourceId: source.id,
    geometryType: geomType,
    paint: paint.main,
    linePaint: paint.line,
    classification: { method: "single", color: themeColors.base },
    legend,
    labelTemplate: buildLabelTemplate(source),
  };
}

// ==========================================================================
// Helpers
// ==========================================================================

function buildPaintForGeom(
  geomType: "point" | "line" | "polygon",
  colorExpr: unknown,
  theme: { base: string; stroke: string },
): { main: Record<string, unknown>; line?: Record<string, unknown> } {
  switch (geomType) {
    case "point":
      return {
        main: {
          "circle-radius": 6,
          "circle-color": colorExpr,
          "circle-stroke-width": 1.5,
          "circle-stroke-color": "#fff",
          "circle-opacity": 0.85,
        },
      };
    case "line":
      return {
        main: {
          "line-color": colorExpr,
          "line-width": 2.5,
          "line-opacity": 0.8,
        },
      };
    case "polygon":
      return {
        main: {
          "fill-color": colorExpr,
          "fill-opacity": 0.4,
        },
        line: {
          "line-color": theme.stroke,
          "line-width": 1,
          "line-opacity": 0.6,
        },
      };
  }
}

function countByField(
  features: Record<string, unknown>[],
  fieldKey: string,
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const f of features) {
    const v = String(f[fieldKey] ?? "");
    if (v) counts[v] = (counts[v] || 0) + 1;
  }
  return counts;
}

function quantileBreaks(sorted: number[], numClasses: number): number[] {
  if (sorted.length === 0) return [0];
  const breaks: number[] = [sorted[0]];
  for (let i = 1; i < numClasses; i++) {
    const idx = Math.floor((i / numClasses) * sorted.length);
    const val = sorted[Math.min(idx, sorted.length - 1)];
    if (val !== breaks[breaks.length - 1]) {
      breaks.push(val);
    }
  }
  if (breaks[breaks.length - 1] !== sorted[sorted.length - 1]) {
    breaks.push(sorted[sorted.length - 1]);
  }
  return breaks;
}

function formatNum(n: number): string {
  if (Number.isInteger(n)) return n.toLocaleString("fr-FR");
  return n.toLocaleString("fr-FR", { maximumFractionDigits: 1 });
}

function buildLabelTemplate(source: SourceDef): string | null {
  const primary = source.fields.filter((f) => f.primary && f.type !== "geometry");
  if (primary.length === 0) return null;
  return primary.map((f) => `{${f.key}}`).join(" — ");
}
