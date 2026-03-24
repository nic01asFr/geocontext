/**
 * geocontext — Session & Navigation Context Types
 *
 * These types define the stateful session model that powers
 * both the dynamic MCP tools and the web interface.
 *
 * See docs/navigation-context.md for the full design.
 */

// ---------------------------------------------------------------------------
// Territory levels
// ---------------------------------------------------------------------------

export type TerritoryLevel =
  | "region"
  | "departement"
  | "epci"
  | "commune"
  | "parcelle"
  | "batiment";

export const TERRITORY_LEVELS: TerritoryLevel[] = [
  "region",
  "departement",
  "epci",
  "commune",
  "parcelle",
  "batiment",
];

// ---------------------------------------------------------------------------
// Themes
// ---------------------------------------------------------------------------

export type Theme =
  | "identite"
  | "urbanisme"
  | "cadastre"
  | "risques"
  | "environnement"
  | "transport"
  | "hydrologie"
  | "economie"
  | "bati"
  | "energie";

/** Themes available per territory level */
export const THEMES_BY_LEVEL: Record<TerritoryLevel, Theme[]> = {
  region: ["identite", "risques", "environnement", "economie"],
  departement: ["identite", "risques", "environnement", "transport", "hydrologie", "economie"],
  epci: ["identite", "risques", "environnement", "transport", "hydrologie", "economie"],
  commune: ["identite", "urbanisme", "cadastre", "risques", "environnement", "transport", "hydrologie", "economie", "bati"],
  parcelle: ["identite", "urbanisme", "cadastre", "risques", "bati"],
  batiment: ["identite", "risques", "bati", "energie"],
};

// ---------------------------------------------------------------------------
// Hierarchy
// ---------------------------------------------------------------------------

export interface TerritoryRef {
  code: string;
  name: string;
}

export interface EpciRef extends TerritoryRef {
  siren: string;
}

export interface Hierarchy {
  region?: TerritoryRef;
  departement?: TerritoryRef;
  epci?: EpciRef;
  commune?: TerritoryRef;
  parcelle?: { idpar: string };
  batiment?: { id: string; source: "rnb" | "cleabs" | "bdnb" };
}

// ---------------------------------------------------------------------------
// Map layer state
// ---------------------------------------------------------------------------

export interface LayerState {
  name: string;
  typename?: string;        // WFS typename if applicable
  visible: boolean;
  style?: LayerStyle;
  featureCount?: number;
}

export interface LayerStyle {
  fill?: string;
  stroke?: string;
  opacity?: number;
  colorBy?: string;         // attribute name for thematic coloring
}

// ---------------------------------------------------------------------------
// Navigation context (the core session state)
// ---------------------------------------------------------------------------

export interface NavigationContext {
  // Position in the territory tree
  level: TerritoryLevel | null;
  code: string | null;
  name: string | null;
  bbox: [number, number, number, number] | null;

  // Resolved hierarchy
  hierarchy: Hierarchy;

  // Active theme
  theme: Theme | null;
  data: Record<string, any>;

  // Map layers
  layers: LayerState[];

  // Navigation stack (for back)
  history: ContextSnapshot[];
}

export type ContextSnapshot = Omit<NavigationContext, "history">;

// ---------------------------------------------------------------------------
// Actions & tool building
// ---------------------------------------------------------------------------

export interface ActionDef {
  id: string;
  label: string;
  description?: string;
}

/** Map operation types for the dynamic "map" tool */
export type MapOperation =
  | "show"
  | "hide"
  | "highlight"
  | "filter"
  | "thematic"
  | "compare";

/** What the agent can command on the view */
export type MapAction =
  | { type: "addLayer"; geojson: any; style: LayerStyle; name: string }
  | { type: "removeLayer"; name: string }
  | { type: "setFilter"; layer: string; filter: any }
  | { type: "fitBounds"; bbox: [number, number, number, number] }
  | { type: "highlight"; featureIds: string[] }
  | { type: "setTheme"; theme: Theme }
  | { type: "navigate"; territory: string; level: TerritoryLevel }
  | { type: "createThematicMap"; config: Record<string, any> };

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEmptyContext(): NavigationContext {
  return {
    level: null,
    code: null,
    name: null,
    bbox: null,
    hierarchy: {},
    theme: null,
    data: {},
    layers: [],
    history: [],
  };
}
