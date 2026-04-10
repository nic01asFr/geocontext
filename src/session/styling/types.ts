/**
 * geocontext — Styling Types
 *
 * Types pour le système de styling thématique automatique.
 * Chaque source de données reçoit un StyleRecipe qui définit :
 *   - Le paint MapLibre (expressions data-driven si applicable)
 *   - La classification (catégoriel, gradué, mono-couleur)
 *   - La légende (toujours présente)
 */

// ==========================================================================
// Légende
// ==========================================================================

export interface LegendItem {
  /** Label en français (ex: "Urbaine (U)") */
  label: string;
  /** Couleur hex */
  color: string;
  /** Nombre de features dans cette catégorie (si connu) */
  count?: number;
}

export interface LegendConfig {
  /** Titre de la légende (ex: "Zonages PLU — Besançon") */
  title: string;
  /** Entrées de la légende */
  items: LegendItem[];
}

// ==========================================================================
// Classification
// ==========================================================================

export interface CategoricalClassification {
  method: "categorical";
  /** Champ source de la classification */
  field: string;
  /** Valeur → couleur hex */
  colorMap: Record<string, string>;
}

export interface GraduatedClassification {
  method: "graduated";
  field: string;
  /** Bornes des classes [min, b1, b2, b3, b4, max] */
  breaks: number[];
  /** Couleurs pour chaque classe (breaks.length - 1) */
  colors: string[];
}

export interface SingleClassification {
  method: "single";
  color: string;
}

export type Classification =
  | CategoricalClassification
  | GraduatedClassification
  | SingleClassification;

// ==========================================================================
// Style Recipe
// ==========================================================================

export interface StyleRecipe {
  sourceId: string;
  /** Type de géométrie détecté */
  geometryType: "point" | "line" | "polygon";
  /** Paint MapLibre natif — prêt à passer à addLayer */
  paint: Record<string, unknown>;
  /** Paint du contour (pour polygones uniquement) */
  linePaint?: Record<string, unknown>;
  /** Classification utilisée */
  classification: Classification;
  /** Légende — toujours renseignée */
  legend: LegendConfig;
  /** Template de label pour les popups (ex: "{libelle} ({typezone})") */
  labelTemplate: string | null;
}
