/**
 * App — point d'entrée de l'interface web geocontext.
 *
 * Flux :
 *   navigate → contour territoire + carte de contexte
 *   action   → efface les anciennes couches thématiques → carte thématique
 *   clic feature → popup (pas de navigate)
 *   clic fond carte → navigate par coordonnées
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

  // ================================================================
  // 2. Connexion MCP
  // ================================================================

  const client = new McpClient("/mcp");
  Chat.init(client);

  statusEl.className = "status loading";
  statusEl.title = "Connexion…";

  try {
    await client.initialize();
    statusEl.className = "status online";
    statusEl.title = "Connecté";
    Chat.addMessage("system", "Connecté au serveur geocontext.");
    await GeoState.refreshAll(client);
  } catch (e) {
    statusEl.className = "status offline";
    statusEl.title = `Erreur : ${e.message}`;
    Chat.addMessage("system", `Connexion impossible : ${e.message}`);
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
      .join("\n");
  }

  async function processLayerSpecs(result) {
    const specs = GeoFetcher.extractLayerSpecs(result);
    if (specs) await GeoFetcher.loadLayers(specs);
  }

  /**
   * Navigate vers un territoire :
   *   1. Effacer toutes les couches (thématiques + boundary)
   *   2. Appeler navigate
   *   3. Charger le contour du nouveau territoire
   */
  async function doNavigate(target) {
    statusEl.className = "status loading";
    try {
      GeoMap.clearLayers();
      GeoMap.clearBoundary();
      GeoState.resetActionCounts();
      DataPanel.hide();

      const result = await client.callTool("navigate", { target });
      const msg = extractText(result);
      if (msg) Chat.addMessage("assistant", msg);

      await GeoState.refreshAll(client);

      // Charger le contour du territoire
      const ctx = GeoState.context;
      if (ctx.level && ctx.code) {
        GeoFetcher.loadTerritoryBoundary(ctx); // async, pas bloquant
      }
    } catch (e) {
      Chat.addMessage("system", `Erreur : ${e.message}`);
    } finally {
      statusEl.className = "status online";
    }
  }

  // ================================================================
  // 4. Recherche (barre supérieure)
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
  // 5. Événements émis par les composants
  // ================================================================

  // Clic fond carte → navigate
  GeoState.on("map-click", async ({ lon, lat }) => {
    await doNavigate(`${lon.toFixed(5)},${lat.toFixed(5)}`);
  });

  // Clic feature → le popup est géré dans map.js, on peut aussi
  // mettre en évidence la ligne dans le data-panel si disponible
  GeoState.on("feature-click", ({ feature, meta }) => {
    // Highlight optionnel dans le DataPanel (si la feature a un index)
    const idx = feature.id;
    if (idx !== undefined) GeoState.emit("feature-hover", idx);
  });

  // Clic hiérarchie → navigate
  GeoState.on("navigate-request", async (code) => {
    await doNavigate(code);
  });

  // Clic thème/action → effacer les couches thématiques, charger les nouvelles
  GeoState.on("action-request", async (action) => {
    statusEl.className = "status loading";
    // Effacer les couches thématiques (pas la limite territoire)
    GeoMap.clearLayers();
    DataPanel.showLoading(action);
    try {
      const result = await client.callTool("action", { action });
      const text = extractText(result);
      if (text) {
        Chat.addMessage("assistant", text);
        DataPanel.render(action, text);
      }

      const specs = GeoFetcher.extractLayerSpecs(result);
      if (specs) {
        const total = Object.values(specs).reduce((s, sp) => s + (sp.featureCount || 0), 0);
        GeoState.setActionCount(action, total);

        const layers = await GeoFetcher.loadLayers(specs);

        // Afficher le détail des features dans le DataPanel
        if (layers && layers.length > 0) {
          const allFeatures = layers.flatMap(l => l.features || []);
          if (allFeatures.length > 0) {
            DataPanel.render(action, text, allFeatures);
          }
        }
      }

      await GeoState.refreshAll(client);
    } catch (e) {
      Chat.addMessage("system", `Erreur : ${e.message}`);
      DataPanel.hide();
    } finally {
      statusEl.className = "status online";
    }
  });
})();
