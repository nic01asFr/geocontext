/**
 * Chat — panneau de conversation.
 *
 * Deux modes :
 *   - "direct" : les messages appellent directement les tools MCP (sans LLM)
 *   - "agent"  : les messages passent par l'API Claude (nécessite une clé API)
 *
 * Le mode direct fonctionne toujours. Le mode agent est optionnel.
 */

const Chat = {
  _client: null,

  init(mcpClient) {
    this._client = mcpClient;

    const input = document.getElementById("chat-input");
    const sendBtn = document.getElementById("chat-send");

    sendBtn.addEventListener("click", () => this._send());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });
  },

  /** Envoie le message de l'utilisateur. */
  async _send() {
    const input = document.getElementById("chat-input");
    const text = input.value.trim();
    if (!text) return;

    input.value = "";
    this.addMessage("user", text);

    try {
      await this._processInput(text);
    } catch (e) {
      this.addMessage("system", `Erreur : ${e.message}`);
    }
  },

  /**
   * Traite l'input utilisateur en mode direct.
   *
   * Heuristiques :
   *   - Commence par "/" → commande directe
   *   - Ressemble à un code INSEE/parcelle → navigate
   *   - Ressemble à un thème connu → action
   *   - Sinon → search puis navigate
   */
  async _processInput(text) {
    // Commande directe : /navigate, /action, /back, /search
    if (text.startsWith("/")) {
      return this._processCommand(text);
    }

    // "back" ou "retour"
    if (/^(back|retour)$/i.test(text)) {
      return this._callTool("back", {});
    }

    // Si un thème est mentionné et qu'on est sur un territoire
    if (GeoState.context.level) {
      const enums = GeoState.getActionEnums();
      const lower = text.toLowerCase();
      const matchedAction = enums.find(
        (a) => lower === a.toLowerCase() || lower.includes(a.toLowerCase()),
      );
      if (matchedAction) {
        return this._callTool("action", { action: matchedAction });
      }
    }

    // Coordonnées (lon,lat)
    const coordMatch = text.match(/^(-?\d+\.?\d*)\s*[,;\s]\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      return this._callTool("navigate", { target: text });
    }

    // Question ou phrase longue → mode direct n'a pas de LLM
    const isQuestion = text.includes("?") || /^(combien|comment|pourquoi|qu[ée]|quel|quels|quelle|quelles|est-ce|y a-t-il|where|what|how|why)\b/i.test(text);
    if (isQuestion || text.split(" ").length > 4) {
      return this.addMessage("system",
        "Le chat est en mode direct (commandes MCP uniquement).\n" +
        "Utilisez /navigate <lieu>, /action <thème>, /back, /search <terme>.\n" +
        "Exemple : /navigate Besançon → puis cliquez un thème."
      );
    }

    // Code INSEE ou texte court → navigate
    return this._callTool("navigate", { target: text });
  },

  /** Traite une commande /xxx. */
  async _processCommand(text) {
    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    switch (cmd) {
      case "navigate":
      case "nav":
      case "go":
        return this._callTool("navigate", { target: arg });
      case "action":
      case "act":
        return this._callTool("action", { action: arg });
      case "search":
        return this._callTool("search", { query: arg });
      case "back":
        return this._callTool("back", {});
      case "map":
        return this._callTool("map", this._parseMapArgs(arg));
      case "context":
      case "ctx":
        return this._showContext();
      case "help":
        return this.addMessage("system",
          "Commandes : /navigate <lieu>, /action <thème>, /back, " +
          "/search <terme>, /map <opération>, /context, /help",
        );
      default:
        return this.addMessage("system", `Commande inconnue : /${cmd}. Tapez /help.`);
    }
  },

  /** Parse les arguments de /map. */
  _parseMapArgs(arg) {
    const parts = arg.split(/\s+/);
    return { operation: parts[0] || "", layer: parts[1] || "" };
  },

  /** Appelle un tool MCP et affiche le résultat. */
  async _callTool(name, args) {
    this.addMessage("tool-call", `${name}(${JSON.stringify(args)})`);

    const result = await this._client.callTool(name, args);

    // Extraire le texte humain (ignorer les blocs layerSpecs JSON)
    const content = result?.content ?? [];
    const textParts = content.filter((c) => {
      if (c.type !== "text") return false;
      try {
        const parsed = JSON.parse(c.text);
        if (parsed._type === "layerSpecs") return false;
      } catch {}
      return true;
    });
    // Supprimer le lien carte (redondant dans l'UI web, les couches chargent automatiquement)
    const text = textParts.map((c) => c.text)
      .join("\n")
      .replace(/\n?🗺.*?http:\/\/localhost:\d+\s*/g, "")
      .trim();

    if (text) {
      this.addMessage("assistant", text);
    }

    // Fetch les couches GeoJSON directement depuis Géoplateforme
    const specs = GeoFetcher.extractLayerSpecs(result);
    if (specs) {
      await GeoFetcher.loadLayers(specs);
    }

    // Rafraîchir l'état global
    await GeoState.refreshAll(this._client);

    return result;
  },

  /** Affiche le contexte courant. */
  async _showContext() {
    const ctx = await this._client.readResource("geocontext://context");
    this.addMessage("assistant",
      `**Contexte actuel**\n` +
      `Territoire : ${ctx.name || "aucun"} (${ctx.level || "—"})\n` +
      `Code : ${ctx.code || "—"}\n` +
      `Thème : ${ctx.theme || "aucun"}\n` +
      `Couches : ${ctx.layerCount}\n` +
      `Historique : ${ctx.historyDepth} entrée(s)`,
    );
  },

  /**
   * Ajoute un message dans le chat.
   * @param {"user"|"assistant"|"system"|"tool-call"} role
   * @param {string} text
   */
  addMessage(role, text) {
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = `msg ${role}`;

    if (role === "tool-call") {
      div.textContent = `→ ${text}`;
    } else {
      // assistant + system : formatage markdown avec échappement HTML
      div.innerHTML = this._formatMarkdown(text);
    }

    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
  },

  /** Formatage markdown minimal (avec échappement HTML préalable). */
  _formatMarkdown(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/\n/g, "<br>");
  },
};

window.Chat = Chat;
