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

    // Raccourcis de commandes
    document.querySelectorAll("#chat-chips .chip").forEach((chip) => {
      chip.addEventListener("click", () => { input.value = chip.dataset.cmd; this._send(); });
    });
    // Zone de saisie qui grandit avec le texte (4 lignes max)
    const ajuste = () => { input.style.height = "auto"; input.style.height = Math.min(input.scrollHeight, 96) + "px"; };
    input.addEventListener("input", ajuste);
    this._ajuste = ajuste;

    // Toggle chat panel
    if (toggleBtn) {
      toggleBtn.addEventListener("click", () => this.toggle());
    }

    this._chargerStatutAgent();
    document.getElementById("chat-reset")?.addEventListener("click", () => this._nouvelleConversation());
    document.getElementById("chat-send")?.addEventListener("click", (e) => { if (this._enCours) { e.stopImmediatePropagation(); this._arreter(); } }, true);

    // Démarrer avec le chat replié
    this._applyCollapsed();
  },

  /** Bascule ouvert/fermé le panneau chat. */
  toggle() {
    this._collapsed = !this._collapsed;
    if (!this._collapsed) document.getElementById("chat-toggle")?.classList.remove("has-new");
    this._applyCollapsed();
  },

  _applyCollapsed() {
    const panel = document.getElementById("panel-chat");
    const toggle = document.getElementById("chat-toggle");
    if (!panel) return;
    if (this._collapsed) {
      panel.classList.add("collapsed");
      if (toggle) toggle.title = "Ouvrir le panneau de commandes";
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
    this._ajuste?.();
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

    // Agent intégré : tout le reste lui revient (il opère la même session que la page)
    if (this._agent?.enabled) return this._demanderAgent(text);

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

    // Salutations / remerciements : ce n'est pas un lieu
    if (/^(bonjour|salut|bonsoir|hello|hey|merci|ok|coucou)\b[\s!.]*$/i.test(text)) {
      this.addMessage("assistant", "Bonjour. Je ne suis pas un agent conversationnel : je comprends un lieu (nom, code INSEE, coordonnées), le nom d'un thème ou d'une action du panneau, ou /help.");
      return;
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

    // Question ou phrase libre : aucun agent n'est branché, on le dit au lieu de répondre à côté
    const ctx = GeoState.context;
    this.addMessage("assistant",
      "Je ne peux pas répondre aux questions : aucun agent conversationnel n'est branché sur ce service.\n" +
      (ctx.level ? `Vous êtes sur **${ctx.name || "?"}** (${ctx.level}). ` : "") +
      "Ce que je comprends : un nom de lieu ou un code, le nom d'un thème ou d'une action du panneau, et les commandes /back, /context, /compare, /help.");
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

  // ── Agent intégré ────────────────────────────────────────────────
  _agent: null, _enCours: null,

  async _chargerStatutAgent() {
    const badge = document.getElementById("chat-mode"), titre = document.querySelector("#chat-header h3");
    try {
      const r = await fetch("/agent/status", { cache: "no-store" });
      this._agent = r.ok ? await r.json() : { enabled: false, reason: "HTTP " + r.status };
    } catch (e) { this._agent = { enabled: false, reason: "service injoignable : " + e.message }; }
    const on = !!this._agent.enabled;
    document.getElementById("panel-chat")?.classList.toggle("agent-on", on);
    if (badge) { badge.textContent = on ? "agent" : "sans agent"; badge.title = on ? `Modèle : ${this._agent.model}` : (this._agent.reason || "Aucun agent n'est branché"); }
    if (titre) titre.textContent = on ? "Agent" : "Commandes";
    const inp = document.getElementById("chat-input");
    if (inp) inp.placeholder = on ? "Demandez : « bâtiments de plus de 20 m à Cassis »…" : "Lieu, thème ou commande…";
    const accueil = document.querySelector("#chat-messages .msg.assistant");
    if (accueil && on && !this._accueilAgent) { this._accueilAgent = true; accueil.innerHTML = this._formatMarkdown("Je peux naviguer, charger des couches, les filtrer et lire les résultats **pour vous**, sur la carte que vous avez sous les yeux. Je ne donne que des chiffres relus à l'écran ou renvoyés par les outils."); }
  },

  async _nouvelleConversation() {
    this._arreter();
    try { await fetch("/agent/reset", { method: "POST", headers: { "mcp-session-id": this._client?.sessionId || "" } }); } catch (_) {}
    const box = document.getElementById("chat-messages"); if (!box) return;
    box.querySelectorAll(".msg:not(:first-child), .agent-steps").forEach((e) => e.remove());
  },

  _arreter() { try { this._enCours?.abort(); } catch (_) {} },

  _etatSaisie(occupe) {
    const send = document.getElementById("chat-send"), inp = document.getElementById("chat-input");
    if (send) { send.innerHTML = Icon(occupe ? "x" : "send", 17); send.title = occupe ? "Arrêter" : "Envoyer"; send.classList.toggle("stop", occupe); }
    if (inp) inp.disabled = !!occupe; if (!occupe) inp?.focus();
  },

  _etiquette(nom, args) {
    const a = args || {};
    switch (nom) {
      case "navigate": return `Navigation vers « ${a.target ?? "?"} »`;
      case "search": return `Recherche « ${a.query ?? a.text ?? ""} »`;
      case "action": return `Chargement : ${typeof libelleAction === "function" ? libelleAction(a.action) : a.action}`;
      case "map": {
        const op = { show: "Afficher", hide: "Masquer", filter: "Filtrer", clear_filter: "Retirer le filtre" }[a.operation] || a.operation;
        const det = a.field ? ` ${a.field}` + (a.values ? ` = ${[].concat(a.values).join(", ")}` : a.min != null || a.max != null ? ` ∈ [${a.min ?? "…"} ; ${a.max ?? "…"}]` : a.texte ? ` ~ « ${a.texte} »` : "") : "";
        return `${op}${a.layer ? " " + a.layer : ""}${det}`;
      }
      case "select": return "Ouverture d'une fiche";
      case "compare": return `Comparaison : ${a.theme ?? ""}`;
      default: return nom;
    }
  },

  async _demanderAgent(text) {
    const box = document.getElementById("chat-messages");
    const steps = document.createElement("div"); steps.className = "agent-steps";
    const bulle = document.createElement("div"); bulle.className = "msg assistant streaming"; bulle.hidden = true;
    box.append(steps, bulle); box.scrollTop = box.scrollHeight;
    if (this._collapsed) this.toggle();
    let brut = ""; const rows = new Map();
    const ctrl = new AbortController(); this._enCours = ctrl; this._etatSaisie(true);
    const defiler = () => { box.scrollTop = box.scrollHeight; };
    const erreurMsg = (m) => { const e = document.createElement("div"); e.className = "msg assistant erreur"; e.innerHTML = this._formatMarkdown(m); box.appendChild(e); defiler(); };
    let fini = false;
    try {
      const r = await fetch("/agent/chat", { method: "POST", signal: ctrl.signal, headers: { "Content-Type": "application/json", "mcp-session-id": this._client?.sessionId || "" }, body: JSON.stringify({ message: text }) });
      if (!r.ok) { let m = "HTTP " + r.status; try { m = (await r.json()).error || m; } catch (_) {} throw new Error(m); }
      const lecteur = r.body.getReader(), dec = new TextDecoder(); let reste = "";
      const traiter = async (ev) => {
        if (ev.type === "text") { brut += ev.delta; bulle.hidden = false; bulle.innerHTML = this._formatMarkdown(brut); defiler(); }
        else if (ev.type === "tool_start") {
          if (brut.trim()) { bulle.classList.remove("streaming"); const n = document.createElement("div"); n.className = "msg assistant"; n.innerHTML = bulle.innerHTML; steps.append(n); brut = ""; bulle.hidden = true; bulle.innerHTML = ""; }
          const row = document.createElement("div"); row.className = "agent-step run";
          row.innerHTML = `<span class="st-ico">${Icon("refresh", 14)}</span><span class="st-txt"></span>`; row.querySelector(".st-txt").textContent = this._etiquette(ev.name, ev.args);
          steps.append(row); rows.set(ev.id, row); defiler();
        } else if (ev.type === "tool_result") {
          const row = rows.get(ev.id);
          if (row && ev.texte) { const det = document.createElement("div"); det.className = "st-det"; det.textContent = ev.texte; row.append(det); row.classList.add("has-det"); row.onclick = () => row.classList.toggle("open"); }
          if (ev.callId) {
            let ack;
            try { ack = await window.GeoAgentBridge.appliquer(ev); } catch (e) { ack = { ok: false, erreur: "Erreur d'affichage : " + (e.message || e) }; }
            try { await fetch("/agent/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId: ev.callId, ...ack }) }); } catch (_) {}
            if (row && ack.note) { const nb = document.createElement("div"); nb.className = "st-note"; nb.textContent = ack.note; row.append(nb); }
            if (!ack.ok && row) { const nb = document.createElement("div"); nb.className = "st-note ko"; nb.textContent = ack.erreur || "affichage non confirmé"; row.append(nb); }
          }
        } else if (ev.type === "tool_done") {
          const row = rows.get(ev.id); if (row) { row.classList.remove("run"); row.classList.add(ev.erreur ? "ko" : "ok"); row.querySelector(".st-ico").innerHTML = Icon(ev.erreur ? "x" : "check", 14); }
        } else if (ev.type === "error") { throw new Error(ev.message); }
        else if (ev.type === "done") { fini = true; }
      };
      for (;;) {
        const { value, done } = await lecteur.read(); if (done) break;
        reste += dec.decode(value, { stream: true }); let i;
        while ((i = reste.indexOf("\n\n")) >= 0) {
          const bloc = reste.slice(0, i); reste = reste.slice(i + 2);
          const l = bloc.split("\n").find((x) => x.startsWith("data:")); if (!l) continue;
          let ev; try { ev = JSON.parse(l.slice(5)); } catch { continue; }
          await traiter(ev);
        }
      }
      if (!fini) throw new Error("La réponse de l'agent s'est interrompue avant la fin.");
    } catch (e) {
      if (e.name === "AbortError") erreurMsg("Interrompu. Les opérations déjà faites restent affichées.");
      else erreurMsg("**L'agent n'a pas pu terminer :** " + (e.message || e) + "\nReformulez ou réessayez : rien n'a été supposé.");
    } finally {
      bulle.classList.remove("streaming"); if (!bulle.innerHTML.trim()) bulle.remove();
      rows.forEach((row) => { if (row.classList.contains("run")) { row.classList.remove("run"); row.classList.add("ko"); row.querySelector(".st-ico").innerHTML = Icon("x", 14); } });
      this._enCours = null; this._etatSaisie(false);
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
      .replace(/\n?🗺[^\n]*/g, "")
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
    div.title = new Date().toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;

    // Auto-ouvrir le chat si un message assistant arrive et qu'il est fermé
    if (role === "assistant" && this._collapsed) {
      // petit écran : le tiroir recouvrirait la carte ; on signale seulement un message non lu sur le bouton
      if (window.innerWidth > 900) this.toggle();
      else document.getElementById("chat-toggle")?.classList.add("has-new");
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
