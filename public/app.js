/**
 * App — point d'entrée de l'interface web geocontext.
 *
 * Initialise tous les composants et orchestre les interactions.
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

    // Charger l'état initial
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
  // 3. Recherche (barre supérieure)
  // ================================================================

  async function doSearch() {
    const text = searchInput.value.trim();
    if (!text) return;

    statusEl.className = "status loading";
    try {
      const result = await client.callTool("navigate", { target: text });
      const content = result?.content ?? [];
      const msg = content.map((c) => c.text || "").join("\n");
      if (msg) Chat.addMessage("assistant", msg);

      await GeoState.refreshAll(client);
      searchInput.value = "";
    } catch (e) {
      Chat.addMessage("system", `Erreur : ${e.message}`);
    } finally {
      statusEl.className = "status online";
    }
  }

  searchBtn.addEventListener("click", doSearch);
  searchInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") doSearch();
  });

  // ================================================================
  // 4. Événements émis par les composants
  // ================================================================

  // Clic carte → navigate par coordonnées
  GeoState.on("map-click", async ({ lon, lat }) => {
    statusEl.className = "status loading";
    try {
      const target = `${lon.toFixed(5)},${lat.toFixed(5)}`;
      const result = await client.callTool("navigate", { target });
      const content = result?.content ?? [];
      const msg = content.map((c) => c.text || "").join("\n");
      if (msg) Chat.addMessage("assistant", msg);

      await GeoState.refreshAll(client);
    } catch (e) {
      Chat.addMessage("system", `Erreur : ${e.message}`);
    } finally {
      statusEl.className = "status online";
    }
  });

  // Clic hiérarchie → navigate
  GeoState.on("navigate-request", async (code) => {
    statusEl.className = "status loading";
    try {
      const result = await client.callTool("navigate", { target: code });
      const content = result?.content ?? [];
      const msg = content.map((c) => c.text || "").join("\n");
      if (msg) Chat.addMessage("assistant", msg);

      await GeoState.refreshAll(client);
    } catch (e) {
      Chat.addMessage("system", `Erreur : ${e.message}`);
    } finally {
      statusEl.className = "status online";
    }
  });

  // Clic thème/action → action
  GeoState.on("action-request", async (action) => {
    statusEl.className = "status loading";
    try {
      const result = await client.callTool("action", { action });
      const content = result?.content ?? [];
      const text = content.map((c) => c.text || "").join("\n");
      if (text) {
        Chat.addMessage("assistant", text);
        DataPanel.render(action, text);
      }

      await GeoState.refreshAll(client);
    } catch (e) {
      Chat.addMessage("system", `Erreur : ${e.message}`);
    } finally {
      statusEl.className = "status online";
    }
  });
})();
