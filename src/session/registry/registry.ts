/**
 * geocontext — Registry (registre central)
 *
 * Assemble toutes les sources de données et fournit un index pour
 * résoudre : (level, theme, action?) → SourceDef[].
 *
 * Le registre est construit une seule fois au démarrage du serveur.
 * Il est immutable après construction. La validation au boot garantit
 * que chaque source référence un endpoint existant et que les pivots
 * sont cohérents avec les niveaux déclarés.
 *
 * API publique :
 *   registry.getSources(level, theme, action?)  → SourceDef[]
 *   registry.getSource(sourceId)                → SourceDef
 *   registry.getThemes(level)                   → Theme[]
 *   registry.getActions(level, theme)           → string[]
 *   registry.getAllSources()                    → SourceDef[]
 *
 * @see docs/data-model.md  — modèle de données
 * @see docs/dynamic-tools.md — comment les tools utilisent le registre
 */

import type {
  SourceDef,
  RegistryKey,
  EndpointId,
} from "./types.js";
import { buildRegistryKey } from "./types.js";
import { ENDPOINTS } from "./endpoints.js";
import type { TerritoryLevel, Theme } from "../types.js";
import { THEMES_BY_LEVEL } from "../types.js";

// ---------------------------------------------------------------------------
// Import de toutes les sources
// ---------------------------------------------------------------------------

import { ADMINEXPRESS_SOURCES } from "./sources/adminexpress.js";
import { URBANISME_SOURCES } from "./sources/urbanisme.js";
import { CADASTRE_SOURCES } from "./sources/cadastre.js";
import { RISQUES_SOURCES } from "./sources/risques.js";
import { ENVIRONNEMENT_SOURCES } from "./sources/environnement.js";
import { TRANSPORT_SOURCES } from "./sources/transport.js";
import { HYDROLOGIE_SOURCES } from "./sources/hydrologie.js";
import { BATI_SOURCES } from "./sources/bati.js";
import { ENERGIE_SOURCES } from "./sources/energie.js";
import { ECONOMIE_SOURCES } from "./sources/economie.js";

// ==========================================================================
// Toutes les sources — catalogue complet
// ==========================================================================

/**
 * Tableau plat de toutes les sources du registre.
 * Ordre : pas important, l'index se charge du classement.
 */
const ALL_SOURCES: SourceDef[] = [
  ...ADMINEXPRESS_SOURCES,
  ...URBANISME_SOURCES,
  ...CADASTRE_SOURCES,
  ...RISQUES_SOURCES,
  ...ENVIRONNEMENT_SOURCES,
  ...TRANSPORT_SOURCES,
  ...HYDROLOGIE_SOURCES,
  ...BATI_SOURCES,
  ...ENERGIE_SOURCES,
  ...ECONOMIE_SOURCES,
];

// ==========================================================================
// Validation au boot
// ==========================================================================

/**
 * Erreur de validation du registre — détectée au démarrage.
 */
class RegistryValidationError extends Error {
  constructor(public readonly errors: string[]) {
    super(`[registry] ${errors.length} erreur(s) de validation :\n  - ${errors.join("\n  - ")}`);
    this.name = "RegistryValidationError";
  }
}

/**
 * Valide l'intégrité du registre au boot.
 *
 * Vérifications :
 * 1. Chaque source référence un endpoint existant
 * 2. Les IDs de source sont uniques
 * 3. Chaque source a au moins un level
 * 4. Le thème de chaque source est compatible avec ses levels (THEMES_BY_LEVEL)
 * 5. Les sources WFS ont un typename, les sources REST ont un path
 */
function validateSources(sources: SourceDef[]): void {
  const errors: string[] = [];
  const seenIds = new Set<string>();

  for (const source of sources) {
    // 1. Endpoint existant
    if (!ENDPOINTS.has(source.endpoint)) {
      errors.push(`Source "${source.id}" : endpoint inconnu "${source.endpoint}"`);
    }

    // 2. ID unique
    if (seenIds.has(source.id)) {
      errors.push(`Source "${source.id}" : ID dupliqué`);
    }
    seenIds.add(source.id);

    // 3. Au moins un level
    if (source.levels.length === 0) {
      errors.push(`Source "${source.id}" : aucun level déclaré`);
    }

    // 4. Thème compatible avec les levels
    for (const level of source.levels) {
      const allowedThemes = THEMES_BY_LEVEL[level];
      if (!allowedThemes.includes(source.theme)) {
        errors.push(
          `Source "${source.id}" : thème "${source.theme}" non autorisé au niveau "${level}"`,
        );
      }
    }

    // 5. WFS → typename requis, REST → path requis
    const endpoint = ENDPOINTS.get(source.endpoint);
    if (endpoint) {
      if (endpoint.protocol === "wfs" && !source.typename) {
        errors.push(`Source "${source.id}" : endpoint WFS mais pas de typename`);
      }
      if (endpoint.protocol !== "wfs" && !source.path && source.path !== "") {
        errors.push(`Source "${source.id}" : endpoint REST mais pas de path`);
      }
    }
  }

  if (errors.length > 0) {
    throw new RegistryValidationError(errors);
  }
}

// ==========================================================================
// Index — construction des maps de lookup
// ==========================================================================

/** Index par clé composite level.theme.action → SourceDef[] */
type SourceIndex = ReadonlyMap<RegistryKey, SourceDef[]>;

/** Index par source ID → SourceDef */
type SourceById = ReadonlyMap<string, SourceDef>;

/**
 * Construit les index de lookup à partir du tableau de sources.
 *
 * Chaque source est indexée pour chaque level qu'elle déclare.
 * Ex: une source avec levels=["commune","parcelle"] apparaît dans
 * les clés "commune.urbanisme.zonages" ET "parcelle.urbanisme.zonages".
 */
function buildIndexes(sources: SourceDef[]): {
  byKey: SourceIndex;
  byId: SourceById;
} {
  const byKey = new Map<RegistryKey, SourceDef[]>();
  const byId = new Map<string, SourceDef>();

  for (const source of sources) {
    byId.set(source.id, source);

    for (const level of source.levels) {
      // Clé avec action (ex: "commune.urbanisme.zonages")
      const key = buildRegistryKey(level, source.theme, source.action);
      const existing = byKey.get(key) ?? [];
      existing.push(source);
      byKey.set(key, existing);

      // Clé sans action (ex: "commune.urbanisme") — pour la vue d'ensemble du thème
      if (source.action) {
        const themeKey = buildRegistryKey(level, source.theme);
        const themeExisting = byKey.get(themeKey) ?? [];
        // Éviter les doublons si déjà ajouté
        if (!themeExisting.includes(source)) {
          themeExisting.push(source);
          byKey.set(themeKey, themeExisting);
        }
      }
    }
  }

  return { byKey, byId };
}

// ==========================================================================
// Registry class
// ==========================================================================

/**
 * Le registre central — interface publique.
 *
 * Construit et validé une seule fois. Immutable après construction.
 */
export class Registry {
  private readonly byKey: SourceIndex;
  private readonly byId: SourceById;
  private readonly sources: readonly SourceDef[];

  constructor(sources: SourceDef[] = ALL_SOURCES) {
    validateSources(sources);
    const indexes = buildIndexes(sources);
    this.byKey = indexes.byKey;
    this.byId = indexes.byId;
    this.sources = Object.freeze([...sources]);
  }

  // -----------------------------------------------------------------------
  // Lookup par clé composite
  // -----------------------------------------------------------------------

  /**
   * Retourne les sources pour un (level, theme, action?) donné.
   *
   * @param level  — niveau territorial
   * @param theme  — thème
   * @param action — action spécifique (optionnel)
   * @returns tableau de SourceDef (vide si aucune source trouvée)
   *
   * @example
   *   registry.getSources("commune", "urbanisme", "zonages")
   *   → [URBANISME_ZONAGES]
   *
   *   registry.getSources("commune", "urbanisme")
   *   → [URBANISME_DOCUMENT, URBANISME_ZONAGES, URBANISME_PRESCRIPTIONS_*, ...]
   */
  getSources(level: TerritoryLevel, theme: Theme, action?: string | null): SourceDef[] {
    const key = buildRegistryKey(level, theme, action);
    return this.byKey.get(key) ?? [];
  }

  /**
   * Retourne une source par son ID.
   * @throws Error si l'ID n'existe pas.
   */
  getSource(sourceId: string): SourceDef {
    const source = this.byId.get(sourceId);
    if (!source) {
      throw new Error(`[registry] Source inconnue : "${sourceId}"`);
    }
    return source;
  }

  /**
   * Retourne une source par son ID, ou null si inexistante.
   */
  findSource(sourceId: string): SourceDef | null {
    return this.byId.get(sourceId) ?? null;
  }

  // -----------------------------------------------------------------------
  // Navigation — thèmes et actions disponibles
  // -----------------------------------------------------------------------

  /**
   * Retourne les thèmes disponibles pour un niveau territorial.
   * Filtre ceux qui ont au moins une source dans le registre.
   *
   * @example
   *   registry.getThemes("commune")
   *   → ["identite", "urbanisme", "cadastre", "risques", ...]
   */
  getThemes(level: TerritoryLevel): Theme[] {
    const allowed = THEMES_BY_LEVEL[level];
    return allowed.filter((theme) => {
      const key = buildRegistryKey(level, theme);
      return this.byKey.has(key);
    });
  }

  /**
   * Retourne les actions disponibles pour un (level, theme).
   * Déduplique les actions (plusieurs sources peuvent partager la même action).
   *
   * @example
   *   registry.getActions("commune", "urbanisme")
   *   → ["document", "zonages", "prescriptions", "servitudes"]
   */
  getActions(level: TerritoryLevel, theme: Theme): string[] {
    const key = buildRegistryKey(level, theme);
    const sources = this.byKey.get(key) ?? [];

    const actions = new Set<string>();
    for (const source of sources) {
      if (source.action) {
        actions.add(source.action);
      }
    }

    return Array.from(actions);
  }

  /**
   * Retourne les labels et descriptions des actions pour le tool `action`.
   *
   * @example
   *   registry.getActionDefs("commune", "urbanisme")
   *   → [
   *       { id: "document", label: "Document d'urbanisme", description: "PLU/PLUi/POS..." },
   *       { id: "zonages", label: "Zonages PLU", description: "Zones U/AU/A/N..." },
   *       ...
   *     ]
   */
  getActionDefs(
    level: TerritoryLevel,
    theme: Theme,
  ): Array<{ id: string; label: string; description: string }> {
    const key = buildRegistryKey(level, theme);
    const sources = this.byKey.get(key) ?? [];

    const seen = new Set<string>();
    const defs: Array<{ id: string; label: string; description: string }> = [];

    for (const source of sources) {
      if (source.action && !seen.has(source.action)) {
        seen.add(source.action);
        defs.push({
          id: source.action,
          label: source.label,
          description: source.description,
        });
      }
    }

    return defs;
  }

  // -----------------------------------------------------------------------
  // Accès global
  // -----------------------------------------------------------------------

  /**
   * Retourne toutes les sources du registre.
   */
  getAllSources(): readonly SourceDef[] {
    return this.sources;
  }

  /**
   * Nombre total de sources.
   */
  get size(): number {
    return this.sources.length;
  }

  /**
   * Nombre d'entrées dans l'index (clés uniques level.theme.action).
   */
  get indexSize(): number {
    return this.byKey.size;
  }
}

// ==========================================================================
// Singleton — instance par défaut
// ==========================================================================

/**
 * Instance singleton du registre, initialisée avec toutes les sources.
 * Utilisée par le serveur MCP et la session.
 *
 * @throws RegistryValidationError si une source est mal configurée (au boot)
 */
export const registry = new Registry();
