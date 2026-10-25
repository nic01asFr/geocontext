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

/** URI de la ressource UI carte (MCP Apps). */
const MAP_UI_RESOURCE = "ui://geocontext-map";

import { registry } from "./registry/index.js";
import { buildActionDescription, buildActionEnums, THEME_META } from "./registry/tree.js";
import { executeSource, executeSources, countSource } from "./executors/executor.js";
import { formatFeatureAsText, extractPrimaryFields } from "./registry/fields.js";
import { resolveTerritory } from "./navigate.js";
import { wfsClient } from "../gpf/wfs.js";
import type { SourceDef, SourceResult, AttributeWithFallbackPivot } from "./registry/types.js";
import {
  createEmptyContext,
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

  /** État de l'affichage tel que la page le déclare (filtres validés, comptes relus) ; informatif, jamais une preuve. */
  private surface: Record<string, any> | null = null;
  getSurface(): Record<string, any> | null { return this.surface; }

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
        result = await this.handleMap(args);
        break;
      case "ui_poll":
        result = await this.handleUiPoll();
        break;
      case "ui_state": {
        const e = (args as any).etat;
        const taille = e ? JSON.stringify(e).length : 0;
        if (taille > 40000) { result = { content: [{ type: "text", text: "État d'affichage trop volumineux." }], isError: true }; break; }
        this.surface = e && typeof e === "object" ? e : null;
        result = { content: [{ type: "text", text: "ok" }] };
        break;
      }
      case "ui_ack":
        result = this.handleUiAck(args);
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
          isError: true,
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
      return errorResult("Veuillez préciser une cible de navigation.");
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
      return errorResult(result.error);
    }

    // Sauvegarder dans l'historique
    this.pushHistory();

    // Mettre à jour le contexte
    this.ctx.level = result.level;
    this.ctx.code = result.code;
    this.ctx.name = result.name;
    this.ctx.bbox = result.bbox;
    this.ctx.geometry = result.geometry ?? null;
    this.ctx.hierarchy = result.hierarchy;
    this.ctx.theme = null;
    this.ctx.data = {};
    this.ctx.pivotCache = {};
    this.ctx.counts = {};
    this.ctx.layers = [];

    const themes = registry.getThemes(result.level);
    const themeLabels = themes.map((t) => THEME_META[t].label);

    // Pré-comptage en background — enrichit les descriptions pour le prochain appel
    this.launchBackgroundCounts(result.level, result.code);

    return textResult(
      `Navigué vers ${result.name} (${result.level}, ${result.code}).\n` +
      (result.note ? `${result.note}\n` : "") +
      `Thèmes disponibles : ${themeLabels.join(", ")}.`,
      this.ctx,
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
      return errorResult("Aucun territoire sélectionné. Utilisez navigate d'abord.");
    }

    const themes = registry.getThemes(this.ctx.level);

    // Cas 1 : action = un thème → changer de thème + charger vue d'ensemble
    if (themes.includes(action as Theme)) {
      // Sauvegarder le contexte avant changement de thème (back granulaire)
      if (this.ctx.theme && this.ctx.theme !== action) {
        this.pushHistory("theme");
      }
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
        cachePivotResults(this.ctx, sourcesToLoad, results);
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
    // Chercher d'abord dans le thème courant, puis résoudre le thème parent implicitement
    let targetTheme = this.ctx.theme;
    let sources = targetTheme
      ? registry.getSources(this.ctx.level, targetTheme, action)
      : [];

    // Résolution implicite : si l'action n'est pas dans le thème courant,
    // chercher dans tous les thèmes et activer le bon automatiquement
    if (sources.length === 0) {
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

    if (sources.length === 0 || !targetTheme) {
      const hint = this.ctx.theme
        ? `Actions dans ${THEME_META[this.ctx.theme].label} : ${registry.getActions(this.ctx.level, this.ctx.theme).join(", ")}. Autres thèmes : ${themes.filter((t) => t !== this.ctx.theme).join(", ")}.`
        : `Thèmes disponibles : ${themes.join(", ")}.`;
      return errorResult(`Action "${action}" inconnue. ${hint}`);
    }

    // Changer de thème si résolution implicite
    if (targetTheme !== this.ctx.theme) {
      if (this.ctx.theme) this.pushHistory("theme");
      this.ctx.theme = targetTheme;
    }

    const results = await executeSources(sources, this.ctx, userFilters);
    cachePivotResults(this.ctx, sources, results);
    this.ctx.data[`${this.ctx.theme}.${action}`] = results;

    // Mettre à jour les couches géographiques — remplacer si déjà présentes
    const newSourceIds = results.map((r) => r.sourceId);
    this.ctx.layers = this.ctx.layers.filter((l) => !newSourceIds.includes(l.name));

    const layerSpecs: Record<string, import("./registry/types.js").LayerSpec> = {};
    for (const r of results) {
      if (r.layerSpec && r.success) {
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
    return richResult(breadcrumb + formatSourceResults(results, this.ctx), layerSpecs, this.ctx);
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
      return errorResult("Veuillez préciser un terme de recherche.");
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
    // les couches vivent dans la page, qui les recharge à la demande : on ne ressuscite pas une liste que l'affichage n'a plus
    this.ctx = { ...prev, layers: [], history: currentHistory };

    let label: string;
    if (prev.snapshotType === "theme" && this.ctx.theme && this.ctx.name) {
      label = `Retour à ${THEME_META[this.ctx.theme].label} · ${this.ctx.name}.`;
    } else if (this.ctx.name) {
      label = `Retour à ${this.ctx.name} (${this.ctx.level}).`;
    } else {
      label = "Retour au contexte initial.";
    }

    return textResult(label, this.ctx);
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
  /**
   * Retrouve une couche par son nom exact, par son préfixe thématique
   * (ex. « batiments » → bati_bdtopo_commune) ou, s'il n'y en a qu'une, par défaut.
   */
  private resolveLayer(name: string): LayerState | undefined {
    const layers = this.ctx.layers;
    const exact = layers.find((l) => l.name === name);
    if (exact) return exact;
    if (!name) return layers.length === 1 ? layers[0] : undefined;
    const n = name.toLowerCase();
    const cands = layers.filter((l) => {
      const ln = l.name.toLowerCase();
      const head = ln.split("_")[0];
      return ln.includes(n) || (head.length >= 3 && n.startsWith(head));
    });
    return cands.length === 1 ? cands[0] : undefined;
  }

  // ========================================================================
  // map -- operations typees sur l'affichage, avec accuse de la surface
  //
  // Le serveur ne connait pas l'etat reel de la carte : seule la surface d'affichage (page web, App MCP)
  // le connait. Une operation est donc validee, mise en file, appliquee PAR LA SURFACE qui relit l'etat
  // reel et l'accuse (ui_ack). `map` ne renvoie un succes qu'avec cet accuse ; sinon une erreur explicite.
  // ========================================================================

  private surfaceVueLe = 0;
  private revOp = 0;
  private opsEnFile: Array<{ rev: number; op: Record<string, unknown> }> = [];
  private opsAttente = new Map<number, (r: Record<string, unknown>) => void>();

  /** La surface interroge ici (outil non annonce aux agents) : renvoie les operations en attente. */
  private async handleUiPoll(): Promise<CallToolResult> {
    this.surfaceVueLe = Date.now();
    const fin = Date.now() + 2000;
    while (this.opsEnFile.length === 0 && Date.now() < fin) await new Promise((r) => setTimeout(r, 100));
    this.surfaceVueLe = Date.now();
    const ops = this.opsEnFile.splice(0);
    return { content: [{ type: "text", text: JSON.stringify({ ops }) }] };
  }

  /** La surface accuse une operation : etat reellement relu, ou erreur. */
  private handleUiAck(args: Record<string, unknown>): CallToolResult {
    this.surfaceVueLe = Date.now();
    const rev = Number(args.rev);
    const fin = this.opsAttente.get(rev);
    if (!fin) return errorResult(`Operation ${rev} inconnue ou deja expiree.`);
    this.opsAttente.delete(rev);
    fin(args);
    return { content: [{ type: "text", text: "ok" }] };
  }

  private async handleMap(args: Record<string, unknown>): Promise<CallToolResult> {
    const operation = String(args.operation ?? "");
    const OPS = ["show", "hide", "filter", "clear_filter"];
    if (!OPS.includes(operation)) {
      return errorResult(`Operation inconnue : "${operation}". Operations reellement prises en charge : ${OPS.join(", ")}.`);
    }
    const layer = this.resolveLayer(String(args.layer ?? ""));
    if (!layer) {
      const n = String(args.layer ?? "");
      return errorResult(
        (n ? `Couche "${n}" introuvable. ` : "Precisez une couche. ") +
        (this.ctx.layers.length ? `Couches disponibles : ${this.ctx.layers.map((l) => l.name).join(", ")}.` : "Aucune couche chargee : executez d'abord une action thematique."),
      );
    }
    const op: Record<string, unknown> = { operation, layer: layer.name };
    if (operation === "filter") {
      const field = String(args.field ?? "").trim();
      if (!field) return errorResult("filter : precisez `field` (nom du champ).");
      const forme = ["values", "min", "max", "texte"].filter((k) => args[k] !== undefined && args[k] !== null && !(k === "values" && Array.isArray(args[k]) && (args[k] as unknown[]).length === 0));
      if (forme.length === 0) return errorResult("filter : precisez `values` (liste), ou `min`/`max` (nombres), ou `texte`.");
      if (forme.includes("values") && (forme.includes("min") || forme.includes("max") || forme.includes("texte"))) return errorResult("filter : `values` ne se combine pas avec min/max/texte ; un filtre par appel et par champ.");
      op.field = field;
      if (forme.includes("values")) {
        if (!Array.isArray(args.values)) return errorResult("filter : `values` doit etre une liste de valeurs.");
        op.values = (args.values as unknown[]).map(String);
      }
      for (const k of ["min", "max"]) if (args[k] !== undefined && args[k] !== null) {
        const x = Number(args[k]); if (!Number.isFinite(x)) return errorResult(`filter : \`${k}\` doit etre un nombre (recu : ${JSON.stringify(args[k])}).`);
        op[k] = x;
      }
      if (typeof op.min === "number" && typeof op.max === "number" && op.min > op.max) return errorResult(`filter : min (${op.min}) superieur a max (${op.max}).`);
      if (args.texte !== undefined && args.texte !== null) op.texte = String(args.texte);
    }
    if (operation === "clear_filter" && args.field) op.field = String(args.field);

    // Une surface d'affichage doit etre connectee a CETTE session, sinon rien n'est affiche
    if (Date.now() - this.surfaceVueLe > 6000) {
      return errorResult("Aucune surface d'affichage n'est connectee a cette session (page web ou App MCP) : rien n'a ete applique ni affiche.");
    }
    const rev = ++this.revOp;
    const accuse = await new Promise<Record<string, unknown> | null>((resolve) => {
      const t = setTimeout(() => { this.opsAttente.delete(rev); this.opsEnFile = this.opsEnFile.filter((o) => o.rev !== rev); resolve(null); }, 20000);
      this.opsAttente.set(rev, (r) => { clearTimeout(t); resolve(r); });
      this.opsEnFile.push({ rev, op });
    });
    if (!accuse) return errorResult("La surface d'affichage n'a pas confirme l'operation dans les 20 s : l'etat de la carte n'est pas garanti. Relisez l'etat avant de continuer.");
    if (accuse.ok !== true) return errorResult(String(accuse.erreur ?? "Operation refusee par la surface d'affichage."));
    if (operation === "show" || operation === "hide") layer.visible = operation === "show";
    return { content: [{ type: "text", text: String(accuse.resume ?? "Operation appliquee.") }], structuredContent: { etat: accuse.etat ?? null } } as CallToolResult;
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
      return errorResult("Veuillez préciser l'identifiant de la feature.");
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
      return errorResult("Un thème doit être actif pour comparer.");
    }

    if (!theme2 || theme2 === this.ctx.theme) {
      return errorResult(
        `Précisez un thème différent à comparer avec ${THEME_META[this.ctx.theme].label}.`,
      );
    }

    const themes = registry.getThemes(this.ctx.level);
    if (!themes.includes(theme2 as Theme)) {
      return errorResult(
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
      this.ctx,
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
    } else if (prev.snapshotType === "theme" && prev.theme && prev.name) {
      description = `Retour à ${THEME_META[prev.theme].label} · ${prev.name}.`;
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
      _meta: { ui: { resourceUri: MAP_UI_RESOURCE } },
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
      _meta: { ui: { resourceUri: MAP_UI_RESOURCE } },
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
      ? `Carte -- couches actives : ${layerNames.join(", ")}. Operations : show, hide, filter (champ + values | min/max | texte), clear_filter. Le resultat est l'etat REELLEMENT affiche (compte, total) relu par la carte ; une erreur est renvoyee si la carte ne confirme pas.`
      : "Gerer les couches cartographiques. ? Aucune couche active -- executez une action thematique d'abord.";

    return {
      name: "map",
      description,
      inputSchema: {
        type: "object",
        properties: {
          operation: { type: "string", enum: ["show", "hide", "filter", "clear_filter"], description: "Operation a effectuer" },
          layer: { type: "string", ...(layerNames.length > 0 ? { enum: layerNames } : {}), description: "Nom de la couche" },
          field: { type: "string", description: "filter / clear_filter : nom du champ (tel que dans le panneau de donnees)" },
          values: { type: "array", items: { type: "string" }, description: "filter : valeurs retenues d'un champ a categories (vide = (sans valeur) avec \"\")" },
          min: { type: "number", description: "filter : borne basse incluse d'un champ numerique" },
          max: { type: "number", description: "filter : borne haute incluse d'un champ numerique" },
          texte: { type: "string", description: "filter : texte contenu (sans accent ni casse) dans un champ texte" },
        },
        required: ["operation", "layer"],
      },
      annotations: { title: "Carte", readOnlyHint: false, idempotentHint: true },
      _meta: { ui: { resourceUri: MAP_UI_RESOURCE } },
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
      _meta: { ui: { resourceUri: MAP_UI_RESOURCE } },
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
      _meta: { ui: { resourceUri: MAP_UI_RESOURCE } },
    };
  }

  // ========================================================================
  // Pré-comptage background
  // ========================================================================

  /**
   * Lance des requêtes hits (count-only) en parallèle pour toutes les
   * sources required de tous les thèmes au niveau courant.
   * Non-bloquant : les compteurs alimentent ctx.counts pour enrichir
   * les descriptions des outils au prochain tour.
   */
  private launchBackgroundCounts(level: TerritoryLevel, code: string): void {
    const themes = registry.getThemes(level);
    const sources = themes.flatMap((t) =>
      registry.getSources(level, t).filter((s) => s.priority === "required" && s.action),
    );

    // Dédupliquer par sourceId
    const seen = new Set<string>();
    const unique = sources.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    Promise.all(
      unique.map(async (s) => {
        try {
          const count = await countSource(s, this.ctx);
          // Vérifier que le contexte n'a pas changé entre-temps
          if (this.ctx.code === code && count >= 0) {
            this.ctx.counts[s.id] = count;
          }
        } catch {
          // Non-bloquant — on ignore les erreurs de comptage
        }
      }),
    ).then(() => {
      // Notifier le client que les tools ont des descriptions enrichies
      if (this.ctx.code === code) {
        this.server.sendToolListChanged().catch(() => {});
      }
    });
  }

  // ========================================================================
  // Historique
  // ========================================================================

  /**
   * Sauvegarde le contexte courant dans la pile d'historique.
   * @param snapshotType — "navigate" pour changement de territoire, "theme" pour changement de thème
   */
  private pushHistory(snapshotType: import("./types.js").SnapshotType = "navigate"): void {
    // Plafonner la pile à 20 entrées
    if (this.ctx.history.length >= 20) {
      this.ctx.history.shift();
    }
    const snapshot: ContextSnapshot = {
      level: this.ctx.level,
      code: this.ctx.code,
      name: this.ctx.name,
      bbox: this.ctx.bbox,
      geometry: this.ctx.geometry ?? null,
      hierarchy: { ...this.ctx.hierarchy },
      theme: this.ctx.theme,
      data: { ...this.ctx.data },
      pivotCache: { ...this.ctx.pivotCache },
      counts: { ...this.ctx.counts },
      layers: this.ctx.layers.map((l) => ({ ...l })),
      snapshotType,
    };
    this.ctx.history.push(snapshot);
  }
}

// ==========================================================================
// Pivot cache — écriture centralisée dans la session
// ==========================================================================

/**
 * Met à jour le pivotCache du contexte à partir des résultats d'exécution.
 * Les partitions résolues (ex: PLU communal vs PLUi) sont cachées ici,
 * et non dans l'executor, pour garder l'executor pur (sans mutation de contexte).
 */
function cachePivotResults(
  ctx: NavigationContext,
  sources: SourceDef[],
  results: SourceResult[],
): void {
  for (const r of results) {
    if (!r.resolvedPartition) continue;
    const source = sources.find((s) => s.id === r.sourceId);
    if (source?.pivot.strategy === "attribute_with_fallback") {
      const cacheKey = (source.pivot as AttributeWithFallbackPivot).cacheKey;
      ctx.pivotCache[cacheKey] = r.resolvedPartition;
    }
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
      if (r.truncated) summary += ` (RÉSULTAT PARTIEL : ${r.features.length} renvoyés sur un total de ${r.totalCount ?? "?"} ; ne pas en tirer de comptes ni de conclusions ; la lecture s'arrête à la limite de pages de la source : précisez un territoire plus fin ou un filtre)`;
      if (r.sansPosition) summary += ` ; ${r.sansPosition} entité(s) sans position fiable (donnée source, hors d'un rayon de 50 km autour des autres) : dans le tableau et le total, pas sur la carte, jamais replacées`;
      lines.push(summary);
    }
  }

  return lines.join("\n");
}

// ==========================================================================
// Utilitaires
// ==========================================================================

function errorResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

function textResult(text: string, ctx?: NavigationContext): CallToolResult {
  const result: CallToolResult = { content: [{ type: "text", text }] };
  if (ctx) {
    (result as any)._meta = { ui: { data: buildUIData(ctx) } };
  }
  return result;
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
const WEB_UI_URL: string | null =
  process.env.PUBLIC_BASE_URL?.replace(/\/+$/, "") ||
  (process.env.TRANSPORT_TYPE === "http"
    ? `http://localhost:${process.env.PORT ?? "3000"}`
    : null);

function richResult(
  text: string,
  layerSpecs: Record<string, import("./registry/types.js").LayerSpec>,
  ctx?: NavigationContext,
): CallToolResult {
  const content: CallToolResult["content"] = [{ type: "text", text }];

  if (Object.keys(layerSpecs).length > 0) {

    // Orienter l'utilisateur vers l'interface cartographique si disponible
    if (WEB_UI_URL) {
      content.push({
        type: "text",
        text: `🗺 Visualisez ces données sur la carte : ${WEB_UI_URL}`,
      });
    }
  }

  const result: CallToolResult = { content };
  if (Object.keys(layerSpecs).length > 0) {
    // Contrat : les layerSpecs voyagent en données structurées, pas dans le texte du LLM
    (result as any).structuredContent = { layerSpecs };
  }

  // Données UI pour MCP Apps (iframe carte intégrée)
  if (ctx) {
    (result as any)._meta = {
      ui: { data: { ...buildUIData(ctx), layerSpecs } },
    };
  }

  return result;
}

/**
 * Construit les données UI envoyées au composant carte MCP Apps.
 * Ces données sont transmises via _meta.ui.data dans les résultats tools,
 * puis relayées à l'iframe via postMessage par le client MCP.
 */
function buildUIData(ctx: NavigationContext): Record<string, unknown> {
  return {
    level: ctx.level,
    code: ctx.code,
    name: ctx.name,
    bbox: ctx.bbox,
    hierarchy: ctx.hierarchy,
    theme: ctx.theme,
    layers: ctx.layers.map((l) => ({ name: l.name, visible: l.visible, featureCount: l.featureCount })),
  };
}
