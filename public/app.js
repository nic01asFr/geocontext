/**
 * App — point d'entrée de l'interface web geocontext.
 *
 * Architecture :
 *   - Navigation (panel, carte, search) → appels MCP directs, résultats dans l'UI
 *   - Chat = assistant optionnel, découplé de la navigation
 *   - Les commandes MCP sont invisibles pour l'utilisateur
 */

(async function () {
  const statusEl = document.getElementById("status-indicator");
  const searchInput = document.getElementById("search-input");
  const searchBtn = document.getElementById("search-btn");

  // ================================================================
  // 1. Initialiser les composants UI
  // ================================================================

  GeoMap.init();
  ContextPanel.init();
  DataPanel.init();

  // Couche de contexte admin — suit le niveau navigué
  GeoState.on("context-layer-update", ({ level, bbox, parent }) => {
    GeoFetcher.loadContextLayer(level, bbox, parent);
  });

  // ================================================================
  // 2. Connexion MCP
  // ================================================================

  const client = new McpClient("/mcp");

  // Exposer le client pour le chat (qui en a besoin séparément)
  window._mcpClient = client;

  statusEl.className = "status loading";
  statusEl.title = "Connexion…";

  try {
    await client.initialize();
    statusEl.className = "status online";
    statusEl.title = "Connecté";
    await GeoState.refreshAll(client);
    Chat.init(client);
  } catch (e) {
    statusEl.className = "status offline";
    statusEl.title = `Erreur : ${e.message}`;
    console.error("[app] Connexion MCP échouée:", e);
  }

  client.onToolsChanged = async () => {
    await GeoState.refreshAll(client);
  };

  // ================================================================
  // 3. Helpers
  // ================================================================

  function extractText(result) {
    if (!result?.content) return "";
    return result.content
      .filter((c) => {
        if (c.type !== "text") return false;
        try {
          const parsed = JSON.parse(c.text);
          if (parsed._type === "layerSpecs") return false;
        } catch {}
        return true;
      })
      .map((c) => c.text)
      .join("\n")
      .replace(/\n?🗺.*?http:\/\/localhost:\d+\s*/g, "")
      .trim();
  }

  // ================================================================
  // 4. Navigation — autonome, sans passer par le chat
  // ================================================================

  async function doNavigate(target) {
    statusEl.className = "status loading";
    try {
      GeoMap.clearLayers();
      GeoMap.clearBoundary();
      GeoMap._navContext = { _navigating: true };
      GeoState.resetActionCounts();
      DataPanel.hide();
      ContextPanel.setLoading(true);

      const result = await client.callTool("navigate", { target });
      await GeoState.refreshAll(client);

      // Charger le contour du territoire + couche contexte enfants
      const ctx = GeoState.context;
      if (ctx.level && ctx.code) {
        GeoFetcher.loadTerritoryBoundary(ctx);
        GeoMap.setNavigationContext(ctx);
      } else {
        GeoMap.resetContextLayer();
      }
    } catch (e) {
      console.error("[app] navigate:", e);
    } finally {
      statusEl.className = "status online";
      ContextPanel.setLoading(false);
    }
  }

  /**
   * Exécute une action thématique — autonome, résultats dans carte + data-panel.
   */
  async function doAction(action) {
    statusEl.className = "status loading";
    GeoMap.clearLayers();
    DataPanel.showLoading(action);
    ContextPanel.setActionLoading(action, true);

    try {
      const result = await client.callTool("action", { action });
      const text = extractText(result);

      const specs = GeoFetcher.extractLayerSpecs(result);
      if (specs) {
        const layers = await GeoFetcher.loadLayers(specs);

        if (layers && layers.length > 0) {
          const allFeatures = layers.flatMap((l) => l.features || []);
          GeoState.setActionCount(action, allFeatures.length);
          if (allFeatures.length > 0) {
            const firstSpecKey = Object.keys(specs)[0];
            const firstSpec = specs[firstSpecKey];
            const meta = {
              sourceId: firstSpecKey,
              filters: firstSpec?.filters || [],
              fields: firstSpec?.fields || [],
              primaryFields: firstSpec?.primaryFields || [],
            };
            DataPanel.render(action, text, allFeatures, meta);
          } else {
            DataPanel.render(action, text);
          }
        } else {
          DataPanel.render(action, text);
        }
      } else {
        DataPanel.render(action, text);
      }

      await GeoState.refreshAll(client);
    } catch (e) {
      console.error("[app] action:", e);
      DataPanel.hide();
    } finally {
      statusEl.className = "status online";
      ContextPanel.setActionLoading(action, false);
    }
  }

  // ================================================================
  // 5. Recherche (barre supérieure)
  // ================================================================

  async function doSearch() {
    const text = searchInput.value.trim();
    if (!text) return;
    searchInput.value = "";
    await doNavigate(text);
  }

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  // ================================================================
  // 6. Événements émis par les composants
  // ================================================================

  // Clic fond carte → navigate
  GeoState.on("map-click", async ({ lon, lat }) => {
    await doNavigate(`${lon.toFixed(5)},${lat.toFixed(5)}`);
  });

  // Clic feature → highlight data-panel
  GeoState.on("feature-click", ({ feature }) => {
    const idx = feature.id;
    if (idx !== undefined) GeoState.emit("feature-hover", idx);
  });

  // Clic hiérarchie ou entité carte → navigate
  GeoState.on("navigate-request", async (target) => {
    if (typeof target === "object" && target.code) {
      await doNavigate(target.code);
    } else {
      await doNavigate(target);
    }
  });

  // Clic thème/action → charger les données sur la carte
  // Le serveur résout implicitement le thème parent si nécessaire
  GeoState.on("action-request", async (payload) => {
    const action = (typeof payload === "object" && payload.action) ? payload.action : payload;
    await doAction(action);
  });
})();
