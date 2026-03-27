/**
 * App — point d'entrée de l'interface web geocontext.
 *
 * Initialise tous les composants et orchestre les interactions.
 * Gère le flux : UI event → MCP tool call → layerSpecs → fetch GeoJSON → carte.
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

  // Écouter les notifications tools/list_changed
  client.onToolsChanged = async () => {
    await GeoState.refreshAll(client);
  };

  // ================================================================
  // 3. Helpers
  // ================================================================

  /**
   * Extrait le texte humain d'un résultat MCP (ignore les blocs JSON layerSpecs).
   */
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

  /**
   * Traite les layerSpecs d'un résultat MCP :
   * fetch le GeoJSON directement depuis Géoplateforme et l'affiche sur la carte.
   */
  async function processLayerSpecs(result) {
    const specs = GeoFetcher.extractLayerSpecs(result);
    if (specs) {
      await GeoFetcher.loadLayers(specs);
    }
  }

  /**
   * Gère une navigation : efface les anciennes couches, appelle navigate,
   * rafraîchit l'état et affiche le résultat.
   */
  async function doNavigate(target) {
    statusEl.className = "status loading";
    try {
      // Effacer les couches de l'ancien territoire
      GeoMap.clearLayers();
      DataPanel.hide();

      const result = await client.callTool("navigate", { target });
      const msg = extractText(result);
      if (msg) Chat.addMessage("assistant", msg);

      await GeoState.refreshAll(client);
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

  // Clic carte → navigate par coordonnées
  GeoState.on("map-click", async ({ lon, lat }) => {
    await doNavigate(`${lon.toFixed(5)},${lat.toFixed(5)}`);
  });

  // Clic hiérarchie → navigate
  GeoState.on("navigate-request", async (code) => {
    await doNavigate(code);
  });

  // Clic thème/action → action + fetch GeoJSON direct
  GeoState.on("action-request", async (action) => {
    statusEl.className = "status loading";
    DataPanel.showLoading(action);
    try {
      const result = await client.callTool("action", { action });
      const text = extractText(result);
      if (text) {
        Chat.addMessage("assistant", text);
        DataPanel.render(action, text);
      }

      // Fetch les couches GeoJSON directement depuis Géoplateforme
      await processLayerSpecs(result);

      await GeoState.refreshAll(client);
    } catch (e) {
      Chat.addMessage("system", `Erreur : ${e.message}`);
      DataPanel.hide();
    } finally {
      statusEl.className = "status online";
    }
  });
})();
