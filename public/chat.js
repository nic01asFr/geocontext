/**
 * Chat — assistant optionnel découplé de la navigation.
 *
 * Le chat est un espace conversationnel. La navigation se fait
 * via le panneau gauche, la barre de recherche et la carte.
 *
 * Le chat sert à :
 *   - Poser des questions sur le territoire / les données
 *   - Obtenir de l'aide sur l'utilisation
 *   - Commandes avancées (/back, /context, /compare)
 *
 * Les commandes MCP internes sont masquées — l'utilisateur
 * ne voit que les résultats en langage naturel.
 */

const Chat = {
  _client: null,
  _collapsed: true,

  init(mcpClient) {
    this._client = mcpClient;

    const input = document.getElementById("chat-input");
    const sendBtn = document.getElementById("chat-send");
    const toggleBtn = document.getElementById("chat-toggle");

    sendBtn.addEventListener("click", () => this._send());
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this._send();
      }
    });

    // Toggle chat panel
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => this.toggle());
    }

    // Démarrer avec le chat replié
    this._applyCollapsed();
  },

  /** Bascule ouvert/fermé le panneau chat. */
  toggle() {
    this._collapsed = !this._collapsed;
    this._applyCollapsed();
  },

  _applyCollapsed() {
    const panel = document.getElementById("panel-chat");
    const toggle = document.getElementById("chat-toggle");
    if (!panel) return;
    if (this._collapsed) {
      panel.classList.add("collapsed");
      if (toggle) toggle.title = "Ouvrir l'assistant";
    } else {
      panel.classList.remove("collapsed");
      if (toggle) toggle.title = "Fermer l'assistant";
      // Focus input
      document.getElementById("chat-input")?.focus();
    }
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
      this.addMessage("assistant", `Désolé, une erreur est survenue.`);
      console.error("[chat]", e);
    }
  },

  /**
   * Traite l'input — redirige les navigations vers l'UI,
   * garde les commandes avancées dans le chat.
   */
  async _processInput(text) {
    // Commandes slash avancées
    if (text.startsWith("/")) {
      return this._processCommand(text);
    }

    // "back" ou "retour" — commande chat légitime
    if (/^(back|retour)$/i.test(text)) {
      const result = await this._callToolSilent("back", {});
      if (result) {
        const msg = this._extractText(result);
        this.addMessage("assistant", msg || "Retour effectué.");
        await GeoState.refreshAll(this._client);
      }
      return;
    }

    // Si territoire actif et texte = thème/action connu → rediriger vers le panel
    if (GeoState.context.level) {
      const enums = GeoState.getActionEnums();
      const lower = text.toLowerCase();
      const match = enums.find((a) => lower === a.toLowerCase());
      if (match) {
        this.addMessage("assistant",
          `J'exécute "${match}" — les résultats s'affichent sur la carte et le panneau de données.`);
        GeoState.emit("action-request", match);
        return;
      }
    }

    // Coordonnées → rediriger vers navigate
    const coordMatch = text.match(/^(-?\d+\.?\d*)\s*[,;\s]\s*(-?\d+\.?\d*)$/);
    if (coordMatch) {
      this.addMessage("assistant", "Navigation en cours…");
      GeoState.emit("navigate-request", text);
      return;
    }

    // Lieu (texte court sans ?) → rediriger vers la barre de recherche
    const isQuestion = text.includes("?") || /^(combien|comment|pourquoi|qu[ée]|quel|est-ce|y a-t-il|donne|montre|liste|where|what|how|why)\b/i.test(text);

    if (!isQuestion && text.split(" ").length <= 3) {
      this.addMessage("assistant", `Navigation vers "${text}"…`);
      GeoState.emit("navigate-request", text);
      return;
    }

    // Question ou phrase → résumé contextuel
    if (isQuestion && GeoState.context.level) {
      // Utiliser le contexte pour répondre
      const ctx = GeoState.context;
      const desc = GeoState.getActionDescription();
      this.addMessage("assistant",
        `Vous êtes sur **${ctx.name || "?"}** (${ctx.level}).\n${desc}\n\n` +
        `Utilisez le panneau de gauche pour explorer les thèmes, ` +
        `ou tapez un nom de lieu pour naviguer.`);
      return;
    }

    // Fallback — aide
    this.addMessage("assistant",
      "Tapez un **nom de lieu** pour naviguer, ou posez une question.\n" +
      "Commandes : /back, /context, /help");
  },

  /** Commandes slash. */
  async _processCommand(text) {
    const parts = text.slice(1).split(/\s+/);
    const cmd = parts[0].toLowerCase();
    const arg = parts.slice(1).join(" ");

    switch (cmd) {
      case "back":
      case "retour": {
        const result = await this._callToolSilent("back", {});
        const msg = result ? this._extractText(result) : "Historique vide.";
        this.addMessage("assistant", msg);
        await GeoState.refreshAll(this._client);
        return;
      }
      case "context":
      case "ctx":
        return this._showContext();
      case "compare": {
        if (!arg) return this.addMessage("assistant", "Usage : /compare <thème>");
        const result = await this._callToolSilent("compare", { theme: arg });
        const msg = result ? this._extractText(result) : "Comparaison impossible.";
        this.addMessage("assistant", msg);
        // Charger les layerSpecs éventuels
        const specs = GeoFetcher.extractLayerSpecs(result);
        if (specs) await GeoFetcher.loadLayers(specs);
        await GeoState.refreshAll(this._client);
        return;
      }
      case "help":
        return this.addMessage("assistant",
          "**Commandes disponibles :**\n" +
          "- /back — retour en arrière\n" +
          "- /context — afficher le contexte actuel\n" +
          "- /compare <thème> — comparer deux thèmes\n\n" +
          "**Navigation :** utilisez la barre de recherche, le panneau de gauche, ou cliquez sur la carte.");
      default:
        // Commande inconnue → peut-être un lieu ?
        this.addMessage("assistant", `Navigation vers "${cmd} ${arg}"…`);
        GeoState.emit("navigate-request", `${cmd} ${arg}`.trim());
    }
  },

  /** Appelle un tool MCP sans rien afficher dans le chat. */
  async _callToolSilent(name, args) {
    try {
      return await this._client.callTool(name, args);
    } catch (e) {
      console.error(`[chat] tool ${name}:`, e);
      return null;
    }
  },

  /** Extrait le texte humain d'un résultat MCP (masque layerSpecs + liens carte). */
  _extractText(result) {
    if (!result?.content) return "";
    return result.content
      .filter((c) => {
        if (c.type !== "text") return false;
        try {
          if (JSON.parse(c.text)._type === "layerSpecs") return false;
        } catch {}
        return true;
      })
      .map((c) => c.text)
      .join("\n")
      .replace(/\n?🗺.*?http:\/\/localhost:\d+\s*/g, "")
      .trim();
  },

  /** Affiche le contexte courant. */
  async _showContext() {
    try {
      const ctx = await this._client.readResource("geocontext://context");
      this.addMessage("assistant",
        `**${ctx.name || "Aucun territoire"}** (${ctx.level || "—"})\n` +
        `Code : ${ctx.code || "—"}\n` +
        `Thème actif : ${ctx.theme || "aucun"}\n` +
        `Couches : ${ctx.layerCount}\n` +
        `Historique : ${ctx.historyDepth} entrée(s)`);
    } catch {
      this.addMessage("assistant", "Impossible de lire le contexte.");
    }
  },

  /**
   * Ajoute un message dans le chat.
   * @param {"user"|"assistant"|"system"} role
   * @param {string} text
   */
  addMessage(role, text) {
    const container = document.getElementById("chat-messages");
    const div = document.createElement("div");
    div.className = `msg ${role}`;
    div.innerHTML = this._formatMarkdown(text);
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    // Auto-ouvrir le chat si un message assistant arrive et qu'il est fermé
    if (role === "assistant" && this._collapsed) {
      this.toggle();
    }
  },

  /** Formatage markdown minimal. */
  _formatMarkdown(text) {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/`(.+?)`/g, "<code>$1</code>")
      .replace(/^- (.+)/gm, "• $1")
      .replace(/\n/g, "<br>");
  },
};

window.Chat = Chat;
