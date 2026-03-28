/**
 * geocontext — GeoContextSession
 *
 * Pièce maîtresse du serveur MCP. Une instance par connexion client.
 *
 * Responsabilités :
 *   - Maintenir le NavigationContext (état de session)
 *   - Générer la surface de tools adaptée au contexte (getTools)
 *   - Dispatcher les tool calls vers les handlers appropriés
 *   - Émettre tools/list_changed quand le contexte change
 *
 * ## Surface de tools — stratégie "toujours exposé"
 *
 * Les 7 tools (navigate, search, back, action, map, compare, select) sont
 * TOUJOURS retournés par getTools(), quelle que soit l'étape de navigation.
 *
 * La contextualisation se fait via les descriptions et les `enum` des params :
 *
 *   - Sans territoire  → action() : description "naviguez d'abord", sans enum
 *   - Avec territoire  → action() : enum = thèmes disponibles
 *   - Avec thème actif → action() : enum = sous-actions du thème
 *   - Sans couches     → map()    : description "chargez des données d'abord"
 *   - Avec couches     → map()    : enum = noms des couches actives
 *
 * Cette approche est plus robuste que l'ajout/suppression de tools car les
 * clients MCP (Claude Code, Claude Desktop) ne re-fetche pas tools/list entre
 * deux messages d'une même conversation, même après réception d'une
 * notification tools/list_changed via SSE.
 *
 * Cycle :
 *   tools/list → getTools() → 7 tools (descriptions + enums contextuels)
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
   * Retourne les 7 tools MCP, toujours tous présents.
   *
   * Chaque builder adapte description et enum au contexte courant :
   *   - état vide    → messages d'orientation ("naviguez d'abord…")
   *   - avec contexte → enums contraints aux valeurs valides
   *
   * Pourquoi toujours 7 et non un nombre variable ?
   * Les clients MCP ne re-fetche pas tools/list entre deux messages,
   * même après réception d'une notification tools/list_changed via SSE.
   * Exposer tous les tools dès le départ garantit que le LLM les voit
   * à chaque tour, sans dépendre du mécanisme de notification.
   */
  getTools(): Tool[] {
    return [
      this.buildNavigateTool(),
      this.buildSearchTool(),
      this.buildBackTool(),
      this.buildActionTool(),
      this.buildMapTool(),
      this.buildCompareTool(),
      this.buildSelectTool(),
    ];
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
   * Polymorphe avec résolution cross-thème :
   *   1. Si action = nom de thème → changer de thème + charger sources required
   *   2. Si action = sous-action du thème courant → exécuter
   *   3. Si action non trouvée dans le thème courant → chercher dans tous les
   *      thèmes et changer silencieusement (ex: action("radon") sans avoir
   *      fait action("risques") d'abord → résolution automatique)
   */
  private async handleAction(
    args: Record<string, unknown>,
  ): Promise<CallToolResult> {
    const action = String(args.action ?? "");
    const userFilters = args.filter as Record<string, unknown> | undefined;

    if (!this.ctx.level || !this.ctx.code) {
      return textResult("Aucun territoire sélectionné. Utilisez navigate d'abord.");
    }

    const themes = registry.getThemes(this.ctx.level);

    // Cas 1 : action = un thème → changer de thème + charger vue d'ensemble
    if (themes.includes(action as Theme)) {
      this.ctx.theme = action as Theme;

      // Charger les sources "required" du thème (vue d'ensemble)
      const allSources = registry.getSources(this.ctx.level, action as Theme);
      const requiredSources = allSources.filter(
        (s) => s.priority === "required" && !s.action,
      );
      const sourcesToLoad = requiredSources.length > 0
        ? requiredSources
        : allSources.filter((s) => s.priority === "required");

      let results: SourceResult[] = [];
      if (sourcesToLoad.length > 0) {
        results = await executeSources(sourcesToLoad, this.ctx, userFilters);
      }

      this.ctx.data[action] = results;

      // Ajouter les couches géographiques (sources d'overview avec géométrie)
      for (const r of results) {
        if (r.layerSpec && r.success && !this.ctx.layers.some((l) => l.name === r.sourceId)) {
          this.ctx.layers.push({
            name: r.sourceId,
            visible: true,
            featureCount: r.features.length,
            style: r.layerSpec.style,
          });
        }
      }

      // Lister les actions avec leurs IDs (utiles pour le prochain appel)
      const actionDefs = registry.getActionDefs(this.ctx.level, action as Theme);

      const breadcrumb = formatBreadcrumb(this.ctx);
      return textResult(
        breadcrumb +
        formatSourceResults(results, this.ctx) +
        (actionDefs.length > 0
          ? `\nActions disponibles : ${actionDefs.map((a) => `${a.id} (${a.label})`).join(", ")}.`
          : ""),
      );
    }

    // Cas 2 : action = sous-action
    // Chercher d'abord dans le thème courant, puis dans tous les thèmes (cross-thème)
    let targetTheme = this.ctx.theme;
    let sources = targetTheme
      ? registry.getSources(this.ctx.level, targetTheme, action)
      : [];

    if (sources.length === 0) {
      // Résolution cross-thème : chercher dans tous les thèmes disponibles
      for (const t of themes) {
        if (t === targetTheme) continue;
        const s = registry.getSources(this.ctx.level, t, action);
        if (s.length > 0) {
          targetTheme = t;
          sources = s;
          break;
        }
      }
    }

    // Aucune action trouvée nulle part
    if (sources.length === 0 || !targetTheme) {
      const hint = this.ctx.theme
        ? `Actions dans ${THEME_META[this.ctx.theme].label} : ${registry.getActions(this.ctx.level, this.ctx.theme).join(", ")}. Thèmes disponibles : ${themes.join(", ")}.`
        : `Thèmes disponibles : ${themes.join(", ")}.`;
      return textResult(`Action inconnue : "${action}". ${hint}`);
    }

    // Changer de thème si résolution cross-thème
    if (targetTheme !== this.ctx.theme) {
      this.ctx.theme = targetTheme;
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

    const breadcrumb = formatBreadcrumb(this.ctx);
    return richResult(breadcrumb + formatSourceResults(results, this.ctx), layerSpecs);
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
   * Tool back — dynamique : affiche la destination dans la description.
   */
  private buildBackTool(): Tool {
    const prev = this.ctx.history.length > 0
      ? this.ctx.history[this.ctx.history.length - 1]
      : null;

    let description: string;
    if (!prev) {
      description = "Remonter dans la navigation (historique vide).";
    } else if (prev.name) {
      const themePart = prev.theme ? ` · ${THEME_META[prev.theme].label}` : "";
      description = `Retour à ${prev.name}${themePart}.`;
    } else {
      description = "Retour au contexte initial.";
    }

    return {
      name: "back",
      description,
      inputSchema: { type: "object" as const, properties: {} },
      annotations: { title: "Retour", readOnlyHint: false, idempotentHint: false },
    };
  }

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
      annotations: { title: "Naviguer", openWorldHint: true },
    };
  }

  /**
   * Tool action — polymorphe selon le contexte, toujours exposé.
   *
   * Sans territoire : description invite à naviguer d'abord.
   * Avec territoire : enum = thèmes disponibles.
   * Avec thème actif : enum = actions du thème.
   */
  private buildActionTool(): Tool {
    if (!this.ctx.level) {
      return {
        name: "action",
        description: "Consulter des données thématiques. ⚠ Naviguez d'abord vers un territoire avec navigate().",
        inputSchema: {
          type: "object" as const,
          properties: {
            action: { type: "string", description: "Thème ou action (naviguez d'abord)" },
          },
          required: ["action"],
        },
      };
    }

    const description = buildActionDescription(this.ctx, registry);
    const enums = buildActionEnums(this.ctx, registry);

    const properties: Record<string, any> = {
      action: {
        type: "string",
        description: "Thème ou action à exécuter",
        ...(enums.length > 0 ? { enum: enums } : {}),
      },
    };

    // Ajouter filter si le thème actif expose des filtres utilisateur
    if (this.ctx.theme && this.ctx.level) {
      const sources = registry.getSources(this.ctx.level, this.ctx.theme);
      const filterDefs = sources.flatMap((s) => s.userFilters ?? [])
        .filter((f, i, arr) => arr.findIndex((x) => x.key === f.key) === i);
      if (filterDefs.length > 0) {
        properties.filter = {
          type: "object",
          description: `Filtres disponibles : ${filterDefs.map((f) => `${f.key} (${f.label})`).join(", ")}`,
          additionalProperties: true,
        };
      }
    }

    return {
      name: "action",
      description,
      inputSchema: { type: "object" as const, properties, required: ["action"] },
      annotations: { title: "Action thématique", openWorldHint: true },
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
      annotations: { title: "Recherche", readOnlyHint: true, openWorldHint: true },
    };
  }

  /**
   * Tool map — toujours exposé, enum des couches adapté au contexte.
   *
   * Sans couches actives : description invite à charger des données d'abord.
   * Avec couches : enum = noms des couches disponibles.
   */
  private buildMapTool(): Tool {
    const layerNames = this.ctx.layers.map((l) => l.name);

    const description = layerNames.length > 0
      ? `Carte — couches actives : ${layerNames.join(", ")}. Opérations : show, hide, highlight, filter, thematic.`
      : "Gérer les couches cartographiques. ⚠ Aucune couche active — exécutez une action thématique d'abord.";

    return {
      name: "map",
      description,
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
            ...(layerNames.length > 0 ? { enum: layerNames } : {}),
            description: "Nom de la couche",
          },
        },
        required: ["operation", "layer"],
      },
      annotations: { title: "Carte", readOnlyHint: false, idempotentHint: true },
    };
  }

  /**
   * Tool compare — toujours exposé, enum des thèmes adapté au contexte.
   *
   * Sans thème actif : description invite à sélectionner un thème d'abord.
   * Avec thème actif : enum = autres thèmes disponibles (exclut le courant).
   */
  private buildCompareTool(): Tool {
    if (!this.ctx.theme) {
      return {
        name: "compare",
        description: "Comparer deux thèmes sur le territoire courant. ⚠ Sélectionnez d'abord un thème avec action().",
        inputSchema: {
          type: "object",
          properties: {
            theme: { type: "string", description: "Thème à comparer" },
          },
          required: ["theme"],
        },
      };
    }

    const otherThemes = this.ctx.level
      ? registry.getThemes(this.ctx.level).filter((t) => t !== this.ctx.theme)
      : [];

    return {
      name: "compare",
      description: `Comparer ${THEME_META[this.ctx.theme].label} avec un autre thème sur ${this.ctx.name ?? "le territoire courant"}.`,
      inputSchema: {
        type: "object",
        properties: {
          theme: {
            type: "string",
            ...(otherThemes.length > 0 ? { enum: otherThemes } : {}),
            description: "Thème à comparer",
          },
        },
        required: ["theme"],
      },
      annotations: { title: "Comparer", openWorldHint: true },
    };
  }

  /**
   * Tool select — toujours exposé.
   *
   * Sans features chargées : description indique qu'il faut d'abord
   * charger des données via action().
   */
  private buildSelectTool(): Tool {
    const hasFeatures = this.ctx.layers.some((l) => l.featureCount && l.featureCount > 0);

    return {
      name: "select",
      description: hasFeatures
        ? "Sélectionner une feature visible pour naviguer dedans (parcelle, bâtiment…)."
        : "Sélectionner une feature pour naviguer dedans. ⚠ Aucune feature disponible — chargez des données avec action() d'abord.",
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
      annotations: { title: "Sélectionner", openWorldHint: true },
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
      const source = registry.findSource(r.sourceId);
      const label = source?.label ?? r.sourceId;
      lines.push(`⚠ ${label} : ${makeFriendlyError(r.error ?? "Erreur inconnue")}`);
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
 * Génère un breadcrumb contextuel : "📍 Nom · Thème\n"
 * Préfixe les réponses action/compare pour orienter le LLM.
 */
function formatBreadcrumb(ctx: NavigationContext): string {
  const parts: string[] = [];
  if (ctx.name) parts.push(ctx.name);
  if (ctx.theme) parts.push(THEME_META[ctx.theme].label);
  return parts.length > 0 ? `📍 ${parts.join(" · ")}\n` : "";
}

/**
 * Transforme une erreur technique en message fonctionnel compréhensible.
 * Évite d'exposer les URLs, codes HTTP et noms d'endpoint au LLM.
 */
function makeFriendlyError(error: string): string {
  if (/HTTP 400/.test(error)) return "non disponible pour ce territoire (requête invalide)";
  if (/HTTP 403/.test(error)) return "accès refusé";
  if (/HTTP 404/.test(error)) return "source introuvable sur ce serveur";
  if (/HTTP 50[0-9]/.test(error)) return "service temporairement indisponible";
  if (/Timeout/.test(error)) return "délai d'attente dépassé";
  if (/Contexte insuffisant/.test(error)) return "données contextuelles manquantes";
  if (/Bbox|géométrie manquante/.test(error)) return "emprise géographique manquante";
  if (/0 résultats/.test(error)) return "aucun résultat";
  return error;
}

/**
 * Résultat riche : texte pour le LLM + layerSpecs JSON pour le frontend.
 *
 * Le frontend parse les blocs content[] et détecte le JSON layerSpecs
 * pour déclencher le fetch GeoJSON direct depuis Géoplateforme.
 */
/**
 * URL de l'interface web (HTTP mode seulement).
 * Permet au LLM d'orienter l'utilisateur vers la carte.
 */
const WEB_UI_URL = process.env.TRANSPORT_TYPE === "http"
  ? `http://localhost:${process.env.PORT ?? "3000"}`
  : null;

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

    // Orienter l'utilisateur vers l'interface cartographique si disponible
    if (WEB_UI_URL) {
      content.push({
        type: "text",
        text: `🗺 Visualisez ces données sur la carte : ${WEB_UI_URL}`,
      });
    }
  }

  return { content };
}
