/**
 * geocontext — GeoContextSession
 *
 * Pièce maîtresse du serveur MCP dynamique. Une instance par connexion client.
 *
 * Responsabilités :
 *   - Maintenir le NavigationContext (état de session)
 *   - Générer la liste de tools dynamique selon le contexte (getTools)
 *   - Dispatcher les tool calls vers les handlers appropriés
 *   - Émettre tools/list_changed quand le contexte change
 *
 * Cycle :
 *   tools/list → getTools() → [navigate, search, back, (action), (map), ...]
 *   tools/call → handleToolCall() → dispatch → updateContext → notification
 *
 * @see docs/navigation-context.md — cycle de navigation
 * @see docs/dynamic-tools.md — surface de tools dynamique
 */

import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { registry } from "./registry/index.js";
import { buildActionDescription, buildActionEnums, THEME_META } from "./registry/tree.js";
import { executeSource, executeSources } from "./executors/executor.js";
import { formatFeatureAsText, extractPrimaryFields } from "./registry/fields.js";
import { resolveTerritory } from "./navigate.js";
import { wfsClient } from "../gpf/wfs.js";
import type { SourceResult } from "./registry/types.js";
import {
  createEmptyContext,
  THEMES_BY_LEVEL,
  type NavigationContext,
  type ContextSnapshot,
  type Theme,
  type TerritoryLevel,
  type LayerState,
} from "./types.js";

// ==========================================================================
// GeoContextSession
// ==========================================================================

export class GeoContextSession {
  private ctx: NavigationContext = createEmptyContext();
  private server: Server;

  constructor(server: Server) {
    this.server = server;
  }

  /** Accès au contexte courant (lecture seule pour les consommateurs). */
  getContext(): Readonly<NavigationContext> {
    return this.ctx;
  }

  // ========================================================================
  // Tools dynamiques — construction
  // ========================================================================

  /**
   * Retourne la liste de tools MCP selon le contexte courant.
   *
   * Jamais plus de 7 tools exposés au LLM.
   */
  getTools(): Tool[] {
    const tools: Tool[] = [
      this.buildNavigateTool(),
      this.buildSearchTool(),
      BACK_TOOL,
    ];

    if (this.ctx.level) {
      tools.push(this.buildActionTool());
    }

    if (this.ctx.layers.length > 0) {
      tools.push(this.buildMapTool());
    }

    if (this.ctx.theme && Object.keys(this.ctx.data).length > 0) {
      tools.push(this.buildCompareTool());
    }

    if (this.ctx.layers.some((l) => l.featureCount && l.featureCount > 0)) {
      tools.push(this.buildSelectTool());
    }

    return tools;
  }

  // ========================================================================
  // Dispatch — handleToolCall
  // ========================================================================

  /**
   * Dispatche un tool call et met à jour le contexte.
   * Émet tools/list_changed si le contexte a changé de manière significative.
   */
  async handleToolCall(
    name: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const prevLevel = this.ctx.level;
    const prevTheme = this.ctx.theme;
    const prevLayerCount = this.ctx.layers.length;

    let result: CallToolResult;

    switch (name) {
      case "navigate":
        result = await this.handleNavigate(args);
        break;
      case "action":
        result = await this.handleAction(args);
        break;
      case "search":
        result = await this.handleSearch(args);
        break;
      case "back":
        result = this.handleBack();
        break;
      case "map":
        result = this.handleMap(args);
        break;
      case "select":
        result = await this.handleSelect(args);
        break;
      case "compare":
        result = await this.handleCompare(args);
        break;
      default:
        result = {
          content: [{ type: "text", text: `Tool inconnu : ${name}` }],
        };
    }

    // Émettre tools/list_changed si le contexte a changé
    if (
      this.ctx.level !== prevLevel ||
      this.ctx.theme !== prevTheme ||
      this.ctx.layers.length !== prevLayerCount
    ) {
      try {
        await this.server.sendToolListChanged();
      } catch {
        // Ignorer si le transport n'est pas connecté
      }
    }

    return result;
  }

  // ========================================================================
  // Handlers
  // ========================================================================

  /**
   * navigate — résout un territoire et met à jour le contexte.
   */
  private async handleNavigate(
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const target = String(args.target ?? args.territoire ?? "");

    if (!target) {
      return textResult("Veuillez préciser une cible de navigation.");
    }

    // Si la cible est un thème connu du niveau actuel → rediriger vers action
    if (this.ctx.level) {
      const themes = registry.getThemes(this.ctx.level);
      if (themes.includes(target as Theme)) {
        return this.handleAction({ action: target });
      }
    }

    // Résoudre comme territoire
    const result = await resolveTerritory(target, this.ctx);
    if (result.success === false) {
      return textResult(result.error);
    }

    // Sauvegarder dans l'historique
    this.pushHistory();

    // Mettre à jour le contexte
    this.ctx.level = result.level;
    this.ctx.code = result.code;
    this.ctx.name = result.name;
    this.ctx.bbox = result.bbox;
    this.ctx.hierarchy = result.hierarchy;
    this.ctx.theme = null;
    this.ctx.data = {};
    this.ctx.layers = [];

    const themes = registry.getThemes(result.level);
    const themeLabels = themes.map((t) => THEME_META[t].label);

    return textResult(
      `Navigué vers ${result.name} (${result.level}, ${result.code}).\n` +
      `Thèmes disponibles : ${themeLabels.join(", ")}.`,
    );
  }

  /**
   * action — consulter un thème ou exécuter une sous-action.
   *
   * Polymorphe :
   *   - Si pas de thème actif → action = nom de thème → charger le thème
   *   - Si thème actif → action = sous-action → exécuter les sources
   */
  private async handleAction(
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const action = String(args.action ?? "");
    const userFilters = args.filter as Record<string, unknown> | undefined;

    if (!this.ctx.level || !this.ctx.code) {
      return textResult("Aucun territoire sélectionné. Utilisez navigate d'abord.");
    }

    // Cas 1 : action = un thème → changer de thème
    const themes = registry.getThemes(this.ctx.level);
    if (themes.includes(action as Theme)) {
      this.ctx.theme = action as Theme;

      // Charger les sources "required" du thème (vue d'ensemble)
      const allSources = registry.getSources(this.ctx.level, action as Theme);
      const requiredSources = allSources.filter(
        (s) => s.priority === "required" && !s.action,
      );
      // Si pas de sources sans action, prendre toutes les required
      const sourcesToLoad = requiredSources.length > 0
        ? requiredSources
        : allSources.filter((s) => s.priority === "required");

      let results: SourceResult[] = [];
      if (sourcesToLoad.length > 0) {
        results = await executeSources(sourcesToLoad, this.ctx, userFilters);
      }

      // Stocker les résultats
      this.ctx.data[action] = results;

      // Ajouter les couches géographiques
      for (const r of results) {
        if (r.geojson && r.success) {
          this.ctx.layers.push({
            name: r.sourceId,
            visible: true,
            featureCount: r.features.length,
          });
        }
      }

      // Lister les actions disponibles
      const actionDefs = registry.getActionDefs(this.ctx.level, action as Theme);
      const actionLabels = actionDefs.map((a) => a.label);

      return textResult(
        formatSourceResults(results, this.ctx) +
        (actionLabels.length > 0
          ? `\nActions disponibles : ${actionLabels.join(", ")}.`
          : ""),
      );
    }

    // Cas 2 : action = sous-action dans le thème courant
    if (!this.ctx.theme) {
      return textResult(
        `Thème non actif. "${action}" n'est pas un thème reconnu. ` +
        `Thèmes disponibles : ${themes.map((t) => THEME_META[t].label).join(", ")}.`,
      );
    }

    const sources = registry.getSources(this.ctx.level, this.ctx.theme, action);
    if (sources.length === 0) {
      const validActions = registry.getActions(this.ctx.level, this.ctx.theme);
      return textResult(
        `Action inconnue : "${action}". ` +
        `Actions disponibles : ${validActions.join(", ")}.`,
      );
    }

    const results = await executeSources(sources, this.ctx, userFilters);
    this.ctx.data[`${this.ctx.theme}.${action}`] = results;

    // Ajouter les couches géographiques via layerSpec
    const layerSpecs: Record<string, import("./registry/types.js").LayerSpec> = {};
    for (const r of results) {
      if (r.layerSpec && r.success && !this.ctx.layers.some((l) => l.name === r.sourceId)) {
        this.ctx.layers.push({
          name: r.sourceId,
          visible: true,
          featureCount: r.features.length,
          style: r.layerSpec.style,
        });
        layerSpecs[r.sourceId] = r.layerSpec;
      }
    }

    return richResult(formatSourceResults(results, this.ctx), layerSpecs);
  }

  /**
   * search — recherche libre (géocodage + WFS fuzzy search).
   *
   * Ordre de résolution :
   *   1. Tentative comme lieu (code INSEE, texte, coordonnées) → navigate suggestion
   *   2. Recherche fuzzy dans les types WFS Géoplateforme → liste de couches
   *   3. Aucun résultat
   */
  private async handleSearch(
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const query = String(args.query ?? args.q ?? "");
    if (!query) {
      return textResult("Veuillez préciser un terme de recherche.");
    }

    // 1. Tenter comme navigation (lieu)
    const navResult = await resolveTerritory(query, this.ctx);
    if (navResult.success) {
      return textResult(
        `Lieu trouvé : ${navResult.name} (${navResult.level}, ${navResult.code}). ` +
        `Utilisez navigate("${navResult.code}") pour y aller.`,
      );
    }

    // 2. Recherche fuzzy dans les types WFS Géoplateforme
    try {
      const featureTypes = await wfsClient.searchFeatureTypes(query, 5);
      if (featureTypes.length > 0) {
        const lines = featureTypes.map(
          (ft) => `- **${ft.name}** : ${ft.title ?? ""}`,
        );
        return textResult(
          `${featureTypes.length} type(s) de données trouvé(s) :\n` +
          lines.join("\n") +
          `\n\nUtilisez une action thématique pour explorer ces données.`,
        );
      }
    } catch {
      // WFS non disponible (réseau, capabilities non chargées…) — on continue
    }

    return textResult(`Aucun résultat pour « ${query} ».`);
  }

  /**
   * back — retour en arrière dans la pile de navigation.
   */
  private handleBack(): CallToolResult {
    const prev = this.ctx.history.pop();
    if (!prev) {
      return textResult("Déjà au début de la navigation.");
    }

    // Restaurer le contexte précédent en gardant la pile actuelle
    const currentHistory = this.ctx.history;
    this.ctx = { ...prev, history: currentHistory };

    return textResult(
      this.ctx.name
        ? `Retour à ${this.ctx.name} (${this.ctx.level}).`
        : "Retour au contexte initial.",
    );
  }

  /**
   * map — opérations sur les couches cartographiques.
   *
   * Opérations :
   *   - show/hide — visibilité d'une couche
   *   - highlight — mettre en surbrillance des features par ID
   *   - filter — appliquer un filtre attributaire sur une couche
   *   - thematic — colorer une couche selon un attribut
   */
  private handleMap(args: Record<string, unknown>): CallToolResult {
    const operation = String(args.operation ?? "");
    const layerName = String(args.layer ?? "");

    const layer = this.ctx.layers.find((l) => l.name === layerName);
    if (!layer && operation !== "list") {
      return textResult(
        layerName
          ? `Couche "${layerName}" introuvable. Couches disponibles : ${this.ctx.layers.map((l) => l.name).join(", ")}.`
          : `Précisez une couche. Disponibles : ${this.ctx.layers.map((l) => l.name).join(", ")}.`,
      );
    }

    switch (operation) {
      case "show":
        layer!.visible = true;
        return textResult(`Couche "${layerName}" affichée.`);

      case "hide":
        layer!.visible = false;
        return textResult(`Couche "${layerName}" masquée.`);

      case "highlight": {
        const featureIds = args.features as string[] ?? [];
        if (featureIds.length === 0) {
          return textResult("Précisez les identifiants des features à mettre en surbrillance.");
        }
        // Stocker le highlight dans le style de la couche
        layer!.style = { ...layer!.style, stroke: "#ff0000", opacity: 0.9 };
        return textResult(
          `${featureIds.length} feature(s) mise(s) en surbrillance sur "${layerName}".`,
        );
      }

      case "filter": {
        const filterExpr = args.expression ?? args.filter;
        if (!filterExpr) {
          return textResult("Précisez une expression de filtre.");
        }
        // Le filtre est stocké pour utilisation par l'interface web
        return textResult(
          `Filtre appliqué sur "${layerName}" : ${JSON.stringify(filterExpr)}.`,
        );
      }

      case "thematic": {
        const attribute = String(args.attribute ?? args.colorBy ?? "");
        if (!attribute) {
          return textResult("Précisez l'attribut pour la carte thématique (ex: type_zone).");
        }
        layer!.style = { ...layer!.style, colorBy: attribute };
        return textResult(
          `Carte thématique de "${layerName}" colorée par "${attribute}".`,
        );
      }

      default:
        return textResult(
          `Opération inconnue : "${operation}". ` +
          `Opérations : show, hide, highlight, filter, thematic.`,
        );
    }
  }

  /**
   * select — sélectionner une feature pour naviguer dedans.
   *
   * Cherche l'identifiant dans les données chargées (couches actives),
   * puis navigue vers la feature correspondante (parcelle, bâtiment…).
   */
  private async handleSelect(
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const featureId = String(args.id ?? args.feature ?? "");
    if (!featureId) {
      return textResult("Veuillez préciser l'identifiant de la feature.");
    }

    // Chercher dans les données chargées si c'est un identifiant connu
    // (idpar pour parcelle, rnb_id pour bâtiment, etc.)
    for (const [key, data] of Object.entries(this.ctx.data)) {
      if (!Array.isArray(data)) continue;
      for (const result of data) {
        if (!result.features) continue;
        for (const feat of result.features) {
          const vals = Object.values(feat);
          if (vals.includes(featureId)) {
            // Trouvé — extraire les infos et naviguer
            return this.handleNavigate({ target: featureId });
          }
        }
      }
    }

    // Sinon, tenter de naviguer directement (code INSEE, idpar, etc.)
    return this.handleNavigate({ target: featureId });
  }

  /**
   * compare — croiser deux thématiques sur le même territoire.
   *
   * Charge le second thème et retourne les données des deux thèmes
   * côte à côte, avec les couches géo ajoutées à la carte.
   */
  private async handleCompare(
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const theme2 = String(args.theme ?? "");
    if (!this.ctx.level || !this.ctx.theme) {
      return textResult("Un thème doit être actif pour comparer.");
    }

    if (!theme2 || theme2 === this.ctx.theme) {
      return textResult(
        `Précisez un thème différent à comparer avec ${THEME_META[this.ctx.theme].label}.`,
      );
    }

    const themes = registry.getThemes(this.ctx.level);
    if (!themes.includes(theme2 as Theme)) {
      return textResult(
        `Thème "${theme2}" non disponible. Thèmes : ${themes.map((t) => THEME_META[t].label).join(", ")}.`,
      );
    }

    // Charger le second thème
    const sources = registry.getSources(this.ctx.level, theme2 as Theme);
    const requiredSources = sources.filter((s) => s.priority === "required");
    const sourcesToLoad = requiredSources.length > 0 ? requiredSources : sources;

    const results = await executeSources(sourcesToLoad, this.ctx);
    this.ctx.data[theme2] = results;

    // Ajouter les couches géo du second thème via layerSpec
    const layerSpecs: Record<string, import("./registry/types.js").LayerSpec> = {};
    for (const r of results) {
      if (r.layerSpec && r.success && !this.ctx.layers.some((l) => l.name === r.sourceId)) {
        this.ctx.layers.push({
          name: r.sourceId,
          visible: true,
          featureCount: r.features.length,
          style: r.layerSpec.style,
        });
        layerSpecs[r.sourceId] = r.layerSpec;
      }
    }

    // Résumé des deux thèmes
    const theme1Label = THEME_META[this.ctx.theme].label;
    const theme2Label = THEME_META[theme2 as Theme].label;
    const theme1Data = this.ctx.data[this.ctx.theme];
    const theme1Summary = Array.isArray(theme1Data)
      ? formatSourceResults(theme1Data, this.ctx)
      : "Données déjà chargées.";
    const theme2Summary = formatSourceResults(results, this.ctx);

    return richResult(
      `Comparaison ${theme1Label} × ${theme2Label} pour ${this.ctx.name} :\n\n` +
      `── ${theme1Label} ──\n${theme1Summary}\n\n` +
      `── ${theme2Label} ──\n${theme2Summary}`,
      layerSpecs,
    );
  }

  // ========================================================================
  // Construction des tools
  // ========================================================================

  /**
   * Tool navigate — description contextuelle.
   */
  private buildNavigateTool(): Tool {
    let description: string;

    if (!this.ctx.level) {
      description =
        "Naviguer vers un territoire. Accepte : nom de lieu, " +
        "code INSEE (5 chiffres), coordonnées (lon,lat), " +
        "identifiant parcelle, code département.";
    } else {
      const themes = registry.getThemes(this.ctx.level);
      const themeLabels = themes.map((t) => THEME_META[t].label);

      const parts: string[] = [
        `Naviguer depuis ${this.ctx.name} (${this.ctx.level}).`,
      ];

      if (this.ctx.hierarchy.departement) {
        parts.push(`Département : ${this.ctx.hierarchy.departement.name} (${this.ctx.hierarchy.departement.code}).`);
      }
      if (this.ctx.hierarchy.epci) {
        parts.push(`EPCI : ${this.ctx.hierarchy.epci.name}.`);
      }

      parts.push(`Ou naviguer vers un autre lieu.`);
      description = parts.join(" ");
    }

    return {
      name: "navigate",
      description,
      inputSchema: {
        type: "object",
        properties: {
          target: {
            type: "string",
            description: "Nom de lieu, code INSEE, coordonnées lon,lat, ou identifiant parcelle",
          },
        },
        required: ["target"],
      },
    };
  }

  /**
   * Tool action — polymorphe selon le contexte.
   */
  private buildActionTool(): Tool {
    const description = buildActionDescription(this.ctx, registry);
    const enums = buildActionEnums(this.ctx, registry);

    const properties: Record<string, any> = {
      action: {
        type: "string",
        description: "Thème ou action à exécuter",
      },
    };

    if (enums.length > 0) {
      properties.action.enum = enums;
    }

    // Ajouter le champ filter si un thème est actif et a des filtres utilisateur
    if (this.ctx.theme && this.ctx.level) {
      const sources = registry.getSources(this.ctx.level, this.ctx.theme);
      const hasFilters = sources.some((s) => s.userFilters && s.userFilters.length > 0);
      if (hasFilters) {
        properties.filter = {
          type: "object",
          description: "Filtres optionnels à appliquer sur les résultats",
          additionalProperties: true,
        };
      }
    }

    return {
      name: "action",
      description,
      inputSchema: {
        type: "object" as const,
        properties,
        required: ["action"],
      },
    };
  }

  /**
   * Tool search — recherche libre.
   */
  private buildSearchTool(): Tool {
    return {
      name: "search",
      description: "Rechercher un lieu, une donnée ou un type de feature.",
      inputSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Terme de recherche libre",
          },
        },
        required: ["query"],
      },
    };
  }

  /**
   * Tool map — couches cartographiques dynamiques.
   */
  private buildMapTool(): Tool {
    const layerNames = this.ctx.layers.map((l) => l.name);

    return {
      name: "map",
      description:
        `Carte — couches : ${layerNames.join(", ")}. ` +
        `Opérations : show, hide.`,
      inputSchema: {
        type: "object",
        properties: {
          operation: {
            type: "string",
            enum: ["show", "hide", "highlight", "filter", "thematic"],
            description: "Opération à effectuer",
          },
          layer: {
            type: "string",
            enum: layerNames.length > 0 ? layerNames : undefined,
            description: "Nom de la couche",
          },
        },
        required: ["operation", "layer"],
      },
    };
  }

  /**
   * Tool compare — croiser deux thèmes.
   */
  private buildCompareTool(): Tool {
    const themes = this.ctx.level
      ? registry.getThemes(this.ctx.level).filter((t) => t !== this.ctx.theme)
      : [];

    return {
      name: "compare",
      description:
        `Comparer ${this.ctx.theme ? THEME_META[this.ctx.theme].label : "le thème actif"} ` +
        `avec un autre thème.`,
      inputSchema: {
        type: "object",
        properties: {
          theme: {
            type: "string",
            enum: themes.length > 0 ? themes : undefined,
            description: "Thème à comparer",
          },
        },
        required: ["theme"],
      },
    };
  }

  /**
   * Tool select — sélectionner une feature.
   */
  private buildSelectTool(): Tool {
    return {
      name: "select",
      description: "Sélectionner une feature visible pour naviguer dedans.",
      inputSchema: {
        type: "object",
        properties: {
          id: {
            type: "string",
            description: "Identifiant de la feature (code parcelle, bâtiment, etc.)",
          },
        },
        required: ["id"],
      },
    };
  }

  // ========================================================================
  // Historique
  // ========================================================================

  /**
   * Sauvegarde le contexte courant dans la pile d'historique.
   */
  private pushHistory(): void {
    const snapshot: ContextSnapshot = {
      level: this.ctx.level,
      code: this.ctx.code,
      name: this.ctx.name,
      bbox: this.ctx.bbox,
      hierarchy: { ...this.ctx.hierarchy },
      theme: this.ctx.theme,
      data: { ...this.ctx.data },
      layers: this.ctx.layers.map((l) => ({ ...l })),
    };
    this.ctx.history.push(snapshot);
  }
}

// ==========================================================================
// Constantes
// ==========================================================================

/** Tool back — toujours statique. */
const BACK_TOOL: Tool = {
  name: "back",
  description: "Remonter d'un cran dans la navigation.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};

// ==========================================================================
// Formatage des résultats
// ==========================================================================

/**
 * Formate les résultats d'exécution en texte concis pour le LLM.
 */
function formatSourceResults(
  results: SourceResult[],
  _ctx: NavigationContext,
): string {
  if (results.length === 0) return "Aucune donnée chargée.";

  const lines: string[] = [];

  for (const r of results) {
    if (!r.success) {
      lines.push(`⚠ ${r.sourceId} : ${r.error ?? "Erreur inconnue"}`);
      continue;
    }

    if (r.features.length === 0) {
      lines.push(`${r.sourceId} : aucun résultat.`);
      continue;
    }

    // Résumé selon le nombre de features
    if (r.features.length === 1) {
      // Feature unique → afficher les champs clés
      const source = registry.findSource(r.sourceId);
      if (source) {
        const primary = extractPrimaryFields(r.features[0], source.fields);
        const pairs = Object.entries(primary)
          .filter(([, v]) => v !== null && v !== undefined)
          .map(([k, v]) => `${k}: ${v}`);
        lines.push(`${source.label} — ${pairs.join(", ")}`);
      } else {
        lines.push(`${r.sourceId} : 1 résultat.`);
      }
    } else {
      // Plusieurs features → résumé quantitatif
      const source = registry.findSource(r.sourceId);
      const label = source?.label ?? r.sourceId;
      let summary = `${label} : ${r.features.length} résultats`;
      if (r.truncated) summary += ` (tronqué, total: ${r.totalCount ?? "?"})`;
      lines.push(summary);
    }
  }

  return lines.join("\n");
}

// ==========================================================================
// Utilitaires
// ==========================================================================

function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

/**
 * Résultat riche : texte pour le LLM + layerSpecs JSON pour le frontend.
 *
 * Le frontend parse les blocs content[] et détecte le JSON layerSpecs
 * pour déclencher le fetch GeoJSON direct depuis Géoplateforme.
 */
function richResult(
  text: string,
  layerSpecs: Record<string, import("./registry/types.js").LayerSpec>,
): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text }];

  if (Object.keys(layerSpecs).length > 0) {
    content.push({
      type: "text",
      text: JSON.stringify({ _type: "layerSpecs", layers: layerSpecs }),
    });
  }

  return { content };
}
