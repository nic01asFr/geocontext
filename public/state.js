/**
 * État global de l'interface web geocontext.
 *
 * Centralise l'état UI et synchronise avec le serveur MCP.
 * Utilise un pattern pub/sub léger pour propager les changements.
 */

const GeoState = {
  // ── État courant (miroir du contexte MCP) ──
  context: {
    level: null,
    code: null,
    name: null,
    bbox: null,
    hierarchy: {},
    theme: null,
    themes: [],
    layerCount: 0,
    dataKeys: [],
    historyDepth: 0,
  },

  // ── Tools MCP disponibles ──
  tools: [],

  // ── Données thématiques chargées ──
  themeData: null,

  // ── Couches cartographiques ──
  layers: [],

  // ── Compteurs de features par action ──
  actionCounts: {},

  // ── Listeners ──
  _listeners: {},

  /** S'abonner à un événement. */
  on(event, fn) {
    if (!this._listeners[event]) this._listeners[event] = [];
    this._listeners[event].push(fn);
  },

  /** Émettre un événement. */
  emit(event, data) {
    const fns = this._listeners[event] || [];
    for (const fn of fns) {
      try { fn(data); } catch (e) { console.error(`[state] ${event}:`, e); }
    }
  },

  // ================================================================
  // Synchronisation avec le serveur MCP
  // ================================================================

  /** Rafraîchit le contexte depuis la resource MCP. */
  async refreshContext(client) {
    try {
      const ctx = await client.readResource("geocontext://context");
      if (ctx) {
        this.context = ctx;
        this.emit("context-changed", ctx);
      }
    } catch (e) {
      console.warn("[state] Impossible de lire le contexte:", e.message);
    }
  },

  /** Rafraîchit la liste des tools. */
  async refreshTools(client) {
    try {
      this.tools = await client.listTools();
      this.emit("tools-changed", this.tools);
    } catch (e) {
      console.warn("[state] Impossible de lire les tools:", e.message);
    }
  },

  /** Rafraîchit les thèmes disponibles. */
  async refreshThemes(client) {
    if (!this.context.level) return;
    try {
      const data = await client.readResource(`geocontext://themes/${this.context.level}`);
      if (data?.themes) {
        this.context.themes = data.themes;
        this.emit("themes-changed", data.themes);
      }
    } catch (e) {
      console.warn("[state] Impossible de lire les thèmes:", e.message);
    }
  },

  /** Rafraîchit les couches. */
  async refreshLayers(client) {
    try {
      const data = await client.readResource("geocontext://layers");
      if (data?.layers) {
        this.layers = data.layers;
        this.emit("layers-changed", data.layers);
      }
    } catch {
      this.layers = [];
    }
  },

  /** Rafraîchit tout après un changement de contexte. */
  async refreshAll(client) {
    await this.refreshContext(client);
    await this.refreshTools(client);
    if (this.context.level) {
      await this.refreshThemes(client);
    }
    if (this.context.layerCount > 0) {
      await this.refreshLayers(client);
    }
  },

  // ================================================================
  // Helpers
  // ================================================================

  /** Met à jour le compteur d'une action et notifie. */
  setActionCount(action, count) {
    this.actionCounts[action] = count;
    this.emit("action-counts-changed", this.actionCounts);
  },

  /** Réinitialise les compteurs (nouveau territoire). */
  resetActionCounts() {
    this.actionCounts = {};
    this.emit("action-counts-changed", {});
  },

  /** Le tool action est-il disponible ? */
  hasAction() {
    return this.tools.some((t) => t.name === "action");
  },

  /** Le tool map est-il disponible ? */
  hasMap() {
    return this.tools.some((t) => t.name === "map");
  },

  /** Retourne les enums de l'action tool. */
  getActionEnums() {
    const action = this.tools.find((t) => t.name === "action");
    if (!action) return [];
    return action.inputSchema?.properties?.action?.enum ?? [];
  },

  /** Retourne la description de l'action tool. */
  getActionDescription() {
    const action = this.tools.find((t) => t.name === "action");
    return action?.description ?? "";
  },
};

window.GeoState = GeoState;
