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

  /** Bannière d'état : toute erreur ou reprise est dite à l'écran, jamais seulement en console. */
  function banniere(msg, genre = "erreur", action) {
    let b = document.getElementById("app-banner");
    if (!b) { b = document.createElement("div"); b.id = "app-banner"; document.body.appendChild(b); }
    b.className = "app-banner " + genre; b.textContent = "";
    const t = document.createElement("span"); t.textContent = msg; b.appendChild(t);
    for (const ac of [].concat(action || [])) { const r = document.createElement("button"); r.textContent = ac.label; r.onclick = () => { b.remove(); ac.fn(); }; b.appendChild(r); }
    const x = document.createElement("button"); x.textContent = "×"; x.className = "fermer"; x.title = "Fermer"; x.onclick = () => b.remove(); b.appendChild(x);
  }
  window.GeoBanner = banniere;

  // Raccourci « / » : place le curseur dans la recherche (hors saisie)
  document.addEventListener("keydown", (e) => {
    if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
    const t = e.target && e.target.tagName;
    if (t === "INPUT" || t === "TEXTAREA" || t === "SELECT") return;
    e.preventDefault(); document.getElementById("search-input")?.focus();
  });

  // Thème clair / sombre : préférence mémorisée si le navigateur l'autorise, sinon réglage système
  (function themeToggle() {
    const root = document.documentElement;
    try { const t = localStorage.getItem("gc-theme"); if (t === "dark" || t === "light") root.dataset.theme = t; } catch (_) {}
    const btn = document.getElementById("theme-toggle");
    if (!btn) return;
    btn.onclick = () => {
      const sombre = root.dataset.theme ? root.dataset.theme === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
      root.dataset.theme = sombre ? "light" : "dark";
      try { localStorage.setItem("gc-theme", root.dataset.theme); } catch (_) {}
    };
  })();
  let derniereCible = null;

  GeoMap.init();
  ContextPanel.init();
  DataPanel.init();

  // Couche de contexte admin — suit le niveau navigué
  GeoState.on("context-layer-update", ({ level, bbox, parent, freres }) => {
    GeoFetcher.loadContextLayer(level, bbox, parent, freres);
  });

  // ================================================================
  // 2. Connexion MCP
  // ================================================================

  const client = new McpClient("/mcp");

  // Exposer le client pour le chat (qui en a besoin séparément)
  window._mcpClient = client;

  // Session serveur perdue (redémarrage, expiration) : le client l'a rouverte ; on rétablit le territoire puis on le dit.
  client.onSessionReset = async ({ methode }) => {
    let rest = "";
    if (derniereCible && methode !== "navigate") {
      try { await client.callTool("navigate", { target: derniereCible }); rest = ` Territoire rétabli : ${derniereCible}.`; }
      catch (e) { rest = ` Le territoire « ${derniereCible} » n'a pas pu être rétabli (${e.message}).`; }
    }
    banniere("La session avec le serveur avait été perdue ; elle a été rouverte." + rest + " Les couches déjà chargées restent affichées, mais relancez l'action si un résultat paraît ancien.", "info");
  };

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
      .replace(/\n?🗺[^\n]*/g, "")
      .trim();
  }

  // ================================================================
  // 4. Navigation — autonome, sans passer par le chat
  // ================================================================

  // Les navigations sont exécutées l'une après l'autre : deux demandes rapprochées ne doivent jamais s'entremêler
  // (sinon le contexte du serveur, le contour et le fil territorial peuvent désigner des lieux différents).
  // Une demande d'utilisateur périmée avant même de démarrer est abandonnée au profit de la plus récente.
  let _navChaine = Promise.resolve(), _navSeq = 0;
  function doNavigate(target, pre) {
    const n = ++_navSeq;
    const run = () => {
      if (!pre && n < _navSeq) return { ok: false, erreur: "navigation remplacée par une demande plus récente" };
      return doNavigateRaw(target, pre);
    };
    const p = _navChaine.then(run, run);
    _navChaine = p.catch(() => {});
    return p;
  }

  async function doNavigateRaw(target, pre) {
    let navErr = null;
    statusEl.className = "status loading";
    const jeton = GeoState.navToken = (GeoState.navToken || 0) + 1; // toute navigation plus récente rend caduc ce qui arrive encore de celle-ci
    try {
      GeoMap.clearLayers(true); DataPanel.reinitEpingles?.(); // nouveau territoire : les épingles du précédent ne s'appliquent plus
      GeoMap.clearBoundary();
      GeoMap._navContext = { _navigating: true };
      GeoState.resetActionCounts();
      DataPanel.hide();
      ContextPanel.setLoading(true);

      const result = pre || await client.callTool("navigate", { target });
      if (result?.isError) throw new Error(extractText(result) || "navigation refusée");
      derniereCible = target;
      document.querySelector("#app-banner.erreur")?.remove(); // erreur périmée : cette navigation a réussi
      await GeoState.refreshAll(client);
      if (jeton !== GeoState.navToken) return { ok: false, erreur: "navigation remplacée par une plus récente" };

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
      navErr = e;
      const msg = String(e.message || e);
      const choix = [...new Set([...msg.matchAll(/«\s*((?:region|departement|commune|epci):[\w]+)\s*»/g)].map((m) => m[1]))];
      const libelle = { region: "Région", departement: "Département", commune: "Commune", epci: "EPCI" };
      const actions = choix.length
        ? choix.map((c) => ({ label: `${libelle[c.split(":")[0]]} ${c.split(":")[1]}`, fn: () => doNavigate(c) }))
        : { label: "Réessayer", fn: () => doNavigate(target) };
      banniere(`Navigation vers « ${target} » impossible : ${msg}`, "erreur", actions);
    } finally {
      statusEl.className = navErr ? "status offline" : "status online";
      statusEl.title = navErr ? "Dernière opération en erreur" : "Connecté";
      ContextPanel.setLoading(false);
    }
    return navErr ? { ok: false, erreur: String(navErr.message || navErr) } : { ok: true };
  }

  /**
   * Exécute une action thématique — autonome, résultats dans carte + data-panel.
   */
  async function doAction(action, pre) {
    statusEl.className = "status loading";
    const bilan = { ok: true, couches: [], echecs: [], avertissements: [] };
    DataPanel.retirerEpingle?.(action); // relancer une action épinglée la recharge : l'ancienne épingle serait périmée
    GeoMap.clearLayers();
    DataPanel.showLoading(action);
    ContextPanel.setActionLoading(action, true);

    try {
      const result = pre || await client.callTool("action", { action });
      const text = extractText(result);

      const specs = GeoFetcher.extractLayerSpecs(result);
      if (specs) {
        const all = await GeoFetcher.loadLayers(specs);
        const layers = all.filter((l) => !l.error);
        const echecs = all.filter((l) => l.error);
        bilan.couches = layers.map((l) => ({ id: l.sourceId, label: l.label || l.sourceId, n: (l.features || []).length }));
        for (const l of layers) if (l.liens) { for (const e of l.liens.erreurs) bilan.avertissements.push(`${l.label} — lien INSEE : ${e}`); if (l.liens.sans.length) bilan.avertissements.push(`${l.label} — ${l.liens.sans.length} IRIS sans donnée INSEE`); for (const c of l.liens.controles) if (c.verdict !== "coherent") bilan.avertissements.push(`${l.label} — contrôle population ${c.commune} : écart ${c.ecart_pct} %`); }
        for (const l of layers) if (l.ecartees) bilan.avertissements.push(`${l.label} — ${l.ecartees.toLocaleString("fr-FR")} entité(s) sans position fiable (donnée source) : dans le tableau, pas sur la carte, jamais replacées.`);
        for (const l of layers) if (l.controle && !l.controle.fait) bilan.avertissements.push(`${l.label} — contrôle d'appartenance au contour du territoire NON effectué (${l.controle.erreur}) : les objets hors territoire n'ont pas été détectés.`);
        bilan.echecs = echecs.map((l) => ({ id: l.sourceId, label: l.label || l.sourceId, erreur: l.error }));

        if (layers.length > 0) {
          const allFeatures = layers.flatMap((l) => l.features || []);
          const panelFeatures = layers[0].features || [];  // le panneau suit UNE couche (ses lignes = ses entités sur la carte)
          GeoState.setActionCount(action, allFeatures.length);
          if (allFeatures.length > 0) {
            const firstSpecKey = layers[0].sourceId;
            const firstSpec = specs[firstSpecKey];
            const meta = {
              sourceId: firstSpecKey,
              filters: firstSpec?.filters || [],
              fields: firstSpec?.fields || [],
              primaryFields: firstSpec?.primaryFields || [],
              nLayers: layers.length, action, layerIds: layers.map((l) => l.sourceId),
              liens: layers[0].liens || null,
              ecartees: layers[0].ecartees || 0,
              anomalies: layers[0].anomalies || [],
              controle: layers[0].controle || null,
              sourceLabel: layers[0].label || layers[0].sourceId,
              retryLiens: () => doAction(action),
            };
            DataPanel.render(action, text, panelFeatures, meta);
          } else {
            DataPanel.render(action, text);
          }
        } else if (echecs.length === 0) {
          DataPanel.render(action, text);
        }
        // Une couche non chargée EN ENTIER n'est pas affichée : on le dit, avec la cause, et on propose de réessayer.
        if (echecs.length > 0) {
          if (layers.length === 0) DataPanel.render(action, "");
          DataPanel.showErrors(echecs, async () => { await doAction(action); });
        }
      } else {
        DataPanel.render(action, text);
      }

      await GeoState.refreshAll(client);
    } catch (e) {
      console.error("[app] action:", e);
      // jamais de panneau vide muet : on dit que l'action a échoué
      DataPanel.render(action, "");
      DataPanel.showErrors([{ label: action, error: e.message || String(e) }], async () => { await doAction(action); });
      bilan.ok = false; bilan.erreur = e.message || String(e);
    } finally {
      statusEl.className = "status online";
      ContextPanel.setActionLoading(action, false);
    }
    if (bilan.echecs.length) bilan.ok = false;
    return bilan;
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
    if (idx === undefined) return;
    GeoState.emit("feature-hover", idx);
    if (window.DataPanel && DataPanel.selectRow && !DataPanel.selectRow(idx)) window.GeoBanner && GeoBanner("L'élément sélectionné sur la carte est masqué dans le tableau par un filtre actif.", "info");
  });

  // ── Surface d'affichage : applique les opérations typées de l'outil `map` et en accuse l'état RÉEL ──
  async function appliquerOp(op) {
    if (op.operation === "filter" || op.operation === "clear_filter") return DataPanel.applyOp(op);
    if (op.operation === "show" || op.operation === "hide") {
      const id = op.layer, voulu = op.operation === "show";
      await GeoMap._settled();
      const aid = GeoMap._byGc?.get(id);
      if (!aid) return { ok: false, erreur: `Couche « ${id} » absente de la carte.` };
      const etat = await GeoMap.el.setLayerVisibility(aid, voulu);
      if (etat !== voulu) return { ok: false, erreur: `La carte n'a pas pris le changement : la couche « ${id} » est ${etat ? "affichée" : "masquée"}.` };
      return { ok: true, resume: `Couche « ${id} » ${etat ? "affichée" : "masquée"} (relu sur la carte).`, etat: { couche: id, visible: etat } };
    }
    return { ok: false, erreur: `Opération « ${op.operation} » non prise en charge par cette surface.` };
  }
  (async function boucleSurface() {
    for (;;) {
      try {
        const r = await client.callTool("ui_poll", {});
        const { ops } = JSON.parse(r.content[0].text);
        for (const { rev, op } of ops) {
          let ack; try { ack = await appliquerOp(op); } catch (e) { ack = { ok: false, erreur: `Erreur de la surface d'affichage : ${e.message || e}` }; }
          try { await client.callTool("ui_ack", { rev, ...ack }); } catch (e) { console.warn("[surface] accusé non transmis", e.message); }
        }
      } catch (e) { await new Promise((r) => setTimeout(r, 3000)); }
    }
  })();

  // ── Pont de l'agent intégré : applique à l'écran le résultat d'un outil déjà exécuté par le serveur, et dit ce qui est RÉELLEMENT affiché ──
  window.GeoAgentBridge = {
    async appliquer(ev) {
      const n = (x) => Number(x).toLocaleString("fr-FR");
      if (ev.name === "navigate") {
        const r = await doNavigate(String(ev.args?.target ?? ""), { isError: false });
        if (!r.ok) return { ok: false, erreur: r.erreur };
        const c = GeoState.context;
        return { ok: true, note: `territoire affiché : ${c.name} (${c.level} ${c.code}) ; aucune couche chargée.` };
      }
      if (ev.name === "action") {
        const action = String(ev.args?.action ?? "");
        const pre = { isError: false, content: [{ type: "text", text: ev.texte || "" }], ...(ev.layerSpecs ? { structuredContent: { layerSpecs: ev.layerSpecs } } : {}) };
        const b = await doAction(action, pre);
        const nv0 = DataPanel._verified;
        const lu = nv0 && nv0.compte != null; // la carte a-t-elle été relue ?
        const parts = b.couches.map((c) => lu ? `${c.label} : ${n(c.n)} éléments affichés` : `${c.label} : ${n(c.n)} éléments chargés dans le panneau et transmis à la carte`);
        if (b.echecs.length) parts.push("NON chargé(es) en entier : " + b.echecs.map((e) => `${e.label} (${e.erreur})`).join(" ; "));
        if (!parts.length) parts.push(b.erreur ? `échec : ${b.erreur}` : "aucune couche à afficher pour cette action");
        const nv = DataPanel._verified;
        if (nv && nv.compte != null) parts.push(`carte vérifiée ${n(nv.compte)} / ${n(nv.total)}`);
        else if (b.couches.length) parts.push("carte NON relue à l'instant (vérification absente ou en attente) : ne pas affirmer que la couche est visible");
        return b.ok ? { ok: true, note: parts.join(" ; ") + "." } : { ok: false, erreur: parts.join(" ; ") };
      }
      // select / compare : le serveur a répondu, rien de plus n'est dessiné par la page
      return { ok: true, note: "résultat transmis ; rien à dessiner côté page." };
    },
  };

  // L'état affiché (couche suivie, filtres validés, comptes relus) est transmis à la session : l'agent et l'interface partagent UN contexte
  let _tEtat = null;
  GeoState.on("surface-state", (etat) => {
    clearTimeout(_tEtat);
    _tEtat = setTimeout(() => { client.callTool("ui_state", { etat }).catch((e) => console.warn("[surface] état non transmis", e.message)); }, 300);
  });

  // Clic hiérarchie ou entité carte → navigate
  GeoState.on("navigate-request", async (target) => {
    if (typeof target === "object" && target.code) {
      await doNavigate(["region", "departement", "epci", "commune"].includes(target.level) ? `${target.level}:${target.code}` : target.code);
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

// ── Panneaux flottants repliables (clic ou clavier sur le titre) : un seul mécanisme, état mémorisé par visiteur, sans incidence si le stockage est indisponible
(function () {
  const lire = (k) => { try { return localStorage.getItem(k) === "1"; } catch { return false; } };
  const ecrire = (k, v) => { try { localStorage.setItem(k, v ? "1" : "0"); } catch { /* stockage indisponible */ } };
  const layout = document.getElementById("layout"), pc = document.getElementById("panel-context"), dp = document.getElementById("data-panel");
  const t1 = document.querySelector("#panel-context #themes > h3"), t2 = document.getElementById("data-title"), resume = document.getElementById("data-resume");
  const etroit = () => window.matchMedia("(max-width: 640px)").matches;
  const defs = [];
  function pose(panneau, titre, cle, corps, libelle, apres) {
    if (!panneau || !titre) return null;
    titre.setAttribute("role", "button"); titre.tabIndex = 0; titre.title = libelle; titre.setAttribute("aria-controls", corps);
    const maj = (c, memo) => {
      panneau.classList.toggle("collapsed", c); titre.setAttribute("aria-expanded", String(!c));
      if (apres) apres(c); if (memo) ecrire(cle, c);
    };
    const bas = () => maj(!panneau.classList.contains("collapsed"), true);
    titre.addEventListener("click", bas);
    titre.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); bas(); } });
    const o = { maj, est: () => panneau.classList.contains("collapsed") }; defs.push(o); return o;
  }
  const P = pose(pc, t1, "gc.pc.collapsed", "themes-list", "Replier / déplier le panneau", (c) => layout.classList.toggle("pc-collapsed", c));
  const D = pose(dp, t2, "gc.dp.collapsed", "data-content", "Replier / déplier le tableau", null);
  if (P) P.maj(lire("gc.pc.collapsed"), false);
  if (D) D.maj(lire("gc.dp.collapsed"), false);
  if (window.GeoState) {
    // de nouvelles données rouvrent le tableau ; sur écran étroit, le panneau se range pour lui laisser la place
    GeoState.on("data-shown", () => { if (D) D.maj(false, false); if (P && etroit()) P.maj(true, false); });
    // résumé visible quand le tableau est replié : l'essentiel reste lisible sans le déplier
    GeoState.on("surface-state", (e) => {
      if (!resume) return;
      if (!e) { resume.textContent = ""; return; }
      const f = (n) => Number(n).toLocaleString("fr-FR");
      resume.textContent = e.dansZoneVisible != null ? `${f(e.dansZoneVisible)} dans la zone · ${f(e.retenus)} retenus sur ${f(e.total)}` : e.retenus === e.total ? `${f(e.total)} éléments` : `${f(e.retenus)} sur ${f(e.total)} éléments`;
    });
  }
  // écran étroit : déplier le panneau range le tableau, et inversement (deux volets ouverts ne laisseraient plus de carte)
  if (P && D) {
    t1.addEventListener("click", () => { if (etroit() && !P.est() && !D.est()) D.maj(true, false); });
    t2.addEventListener("click", () => { if (etroit() && !D.est() && !P.est()) P.maj(true, false); });
  }
  // Échap sur un titre de panneau le replie
  [[t1, P], [t2, D]].forEach(([t, o]) => { if (t && o) t.addEventListener("keydown", (e) => { if (e.key === "Escape" && !o.est()) { o.maj(true, true); } }); });
})();

// ── Le panneau flottant n'apparaît qu'une fois un territoire choisi
(function () {
  const pc = document.getElementById("panel-context"), layout = document.getElementById("layout");
  if (!pc || !window.GeoState) return;
  const maj = (ctx) => { const a = !!(ctx && ctx.level && ctx.code); pc.classList.toggle("has-territory", a); layout.classList.toggle("has-territory", a); };
  GeoState.on("context-changed", maj); maj(GeoState.context);
})();

// ── Largeur réelle du panneau → position du fil territorial (alignement sans valeur codée en dur)
(function () {
  const pc = document.getElementById("panel-context"), layout = document.getElementById("layout");
  if (!pc || !layout || !window.ResizeObserver) return;
  new ResizeObserver(() => layout.style.setProperty("--pc-w", pc.offsetWidth + "px")).observe(pc);
})();

// ── Clavier : Échap referme le tiroir de commandes et les menus ouverts
document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  document.querySelectorAll("#territory-badge .fil-menu:not([hidden])").forEach((m) => { m.hidden = true; });
  if (window.Chat && Chat._collapsed === false && !e.defaultPrevented && document.activeElement?.id !== "chat-input") Chat.toggle();
});

// ── Le panneau de thèmes ne recouvre jamais le tableau : la place occupée par le tableau (mesurée) est retirée de la hauteur permise au panneau
(function () {
  const layout = document.getElementById("layout"), pc = document.getElementById("panel-context"), dp = document.getElementById("data-panel");
  if (!layout || !pc || !dp || !window.ResizeObserver) return;
  const maj = () => {
    const vis = getComputedStyle(dp).display !== "none" && !dp.classList.contains("hidden") && dp.offsetHeight > 0;
    layout.style.setProperty("--dp-space", vis ? dp.offsetHeight + 12 + "px" : "0px");
    layout.style.setProperty("--pc-top", pc.offsetTop + "px");
    // hauteur permise au panneau = place libre au-dessus du tableau (fixée ici : plus fiable qu'un calcul CSS face aux règles responsives empilées)
    const libre = layout.clientHeight - pc.offsetTop - (vis ? dp.offsetHeight + 12 : 0) - 12;
    pc.style.setProperty("max-height", Math.max(96, libre) + "px", "important");
  };
  new ResizeObserver(maj).observe(dp); new ResizeObserver(maj).observe(layout);
  new MutationObserver(maj).observe(dp, { attributes: true, attributeFilter: ["class"] });
  maj();
})();

// ── Fiche « élu et mairie » du territoire courant : chargée à la demande (ouverture du volet), jamais complétée par déduction
(function () {
  const zone = document.getElementById("themes"), liste = document.getElementById("themes-list");
  if (!zone || !liste || !window.GeoState) return;
  const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const lien = (u) => (/^https?:\/\//i.test(u) ? `<a href="${esc(u)}" target="_blank" rel="noopener noreferrer">${esc(u.replace(/^https?:\/\/(www\.)?/i, "").replace(/\/$/, ""))}</a>` : esc(u));
  const date = (iso) => (/^\d{4}-\d{2}-\d{2}/.test(iso || "") ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : iso || "");
  const NOM = { commune: "Maire et mairie", departement: "Président du département", region: "Président de la région", epci: "Intercommunalité (BANATIC)" };
  let det = null, jeton = 0, charge = null;
  async function appelle(url) {
    const r = await fetch(url); const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erreur || "HTTP " + r.status);
    return j;
  }
  async function remplirEpci(ctx) {
    const corps = det.querySelector(".fiche-corps"), mon = ++jeton, cle = ctx.level + ":" + ctx.code;
    corps.innerHTML = '<span class="loading-spinner"></span> Chargement…';
    let j; try { j = await appelle("/liens/epci?siren=" + encodeURIComponent(ctx.code)); } catch (err) {
      if (mon !== jeton) return;
      corps.innerHTML = `<p class="fiche-ko"><b>Fiche indisponible :</b> ${esc(err.message)}</p>`;
      const b = document.createElement("button"); b.type = "button"; b.className = "dp-btn"; b.textContent = "Réessayer"; b.onclick = () => remplirEpci(ctx); corps.append(b); return;
    }
    if (mon !== jeton) return;
    const n = (v) => Number(v).toLocaleString("fr-FR"), bloc = [];
    if (j.etat !== "ok") bloc.push(`<p class="fiche-vide">${esc(j.message)}</p>`);
    else {
      bloc.push(`<p><b>${esc(j.nom)}</b><br><small>${esc([j.nature, j.financement, j.siege && "siège : " + j.siege].filter(Boolean).join(" · "))}</small></p>`);
      const l = [j.president && "Président(e) : " + esc(j.president), j.population != null && "Population : " + n(j.population), j.membres != null && n(j.membres) + " communes membres", j.competences != null && n(j.competences) + " compétences exercées", j.cree_le && "Créé le " + esc(j.cree_le), j.telephone && esc(j.telephone), j.courriel ? `<a href="mailto:${esc(j.courriel)}">${esc(j.courriel)}</a>` : "<span class='fiche-vide'>courriel non renseigné</span>", j.site ? lien(j.site) : "<span class='fiche-vide'>site internet non renseigné</span>"].filter(Boolean);
      bloc.push(`<ul class="fiche-liste">${l.map((t) => `<li>${t}</li>`).join("")}</ul>`);
      const c = j.concordance;
      if (c.verdict === "identique") bloc.push(`<p class="fiche-ok">Composition contrôlée : les ${n(c.banatic)} communes de BANATIC sont exactement celles d'ADMIN EXPRESS ✓</p>`);
      else if (c.verdict === "ecart") bloc.push(`<p class="fiche-ko"><b>Écart de composition :</b> ${n(c.banatic)} communes dans BANATIC, ${n(c.admin_express)} dans ADMIN EXPRESS.${c.seulement_admin_express.length ? " Seulement dans ADMIN EXPRESS : " + esc(c.seulement_admin_express.join(", ")) + "." : ""}${c.seulement_banatic.length ? " Seulement dans BANATIC : " + esc(c.seulement_banatic.map((x) => x.nom + " (" + x.code + ")").join(", ")) + "." : ""}</p>`);
      else bloc.push(`<p class="fiche-vide">${esc(c.raison || "Composition non contrôlée.")}</p>`);
      bloc.push(`<small class="fiche-src">${esc(j.source.nom)}, fichier du ${esc(date(j.source.maj || ""))}</small>`);
    }
    corps.innerHTML = bloc.join(""); charge = cle;
  }
  async function remplir(ctx) {
    if (ctx.level === "epci") return remplirEpci(ctx);
    const corps = det.querySelector(".fiche-corps"), mon = ++jeton, cle = ctx.level + ":" + ctx.code;
    corps.innerHTML = '<span class="loading-spinner"></span> Chargement…';
    const [e, m] = await Promise.allSettled([
      appelle(`/liens/elus?niveau=${encodeURIComponent(ctx.level)}&code=${encodeURIComponent(ctx.code)}`),
      ctx.level === "commune" ? appelle(`/liens/mairie?commune=${encodeURIComponent(ctx.code)}`) : Promise.resolve(null),
    ]);
    if (mon !== jeton) return;
    const bloc = [];
    const echec = (t, r) => `<p class="fiche-ko"><b>${t} indisponible :</b> ${esc(r.reason?.message || r.reason)}</p>`;
    if (e.status === "rejected") bloc.push(echec("Élu", e));
    else if (e.value.etat === "ok") { const x = e.value.elu; bloc.push(`<p><b>${esc(x.prenom)} ${esc(x.nom)}</b><br><small>${esc(x.fonction)}${x.debut_fonction ? ", en fonction depuis le " + esc(date(x.debut_fonction)) : ""}</small></p><small class="fiche-src">${esc(e.value.source.nom)}, version du ${esc(date(e.value.source.millesime))}</small>`); }
    else bloc.push(`<p class="fiche-vide">${esc(e.value.message)}</p>`);
    if (ctx.level === "commune") {
      if (m.status === "rejected") bloc.push(echec("Mairie", m));
      else if (m.value.etat === "absente") bloc.push(`<p class="fiche-vide">${esc(m.value.message)}</p>`);
      else for (const x of m.value.mairies) {
        const l = [x.adresse && esc(x.adresse), x.telephones.length && esc(x.telephones.join(" · ")), x.courriel && `<a href="mailto:${esc(x.courriel)}">${esc(x.courriel)}</a>`, x.sites.length && x.sites.map(lien).join(" · ")].filter(Boolean);
        bloc.push(`<p><b>${esc(x.nom || "Mairie")}</b></p><ul class="fiche-liste">${l.map((t) => `<li>${t}</li>`).join("")}${x.courriel ? "" : "<li class='fiche-vide'>courriel non renseigné</li>"}${x.sites.length ? "" : "<li class='fiche-vide'>site internet non renseigné</li>"}</ul><small class="fiche-src">Annuaire de l'administration, fiche modifiée le ${esc(x.modifie_le || "date inconnue")}</small>`);
        if (m.value.etat === "plusieurs") break;
      }
      if (m.status === "fulfilled" && m.value.etat === "plusieurs") bloc.push(`<p class="fiche-vide">${m.value.total} fiches « mairie » trouvées pour ce code : la première est affichée.</p>`);
      if (m.status === "fulfilled") for (const a of m.value.avertissements) bloc.push(`<p class="fiche-vide">${esc(a)}</p>`);
    }
    corps.innerHTML = bloc.join("");
    if (e.status === "rejected" || (ctx.level === "commune" && m.status === "rejected")) {
      const b = document.createElement("button"); b.type = "button"; b.className = "dp-btn"; b.textContent = "Réessayer"; b.onclick = () => remplir(ctx); corps.append(b);
    } else charge = cle;
  }
  // la fiche vit dans la rubrique Identité (ouverte avec elle) ; la liste des thèmes est réécrite à chaque rendu, on la replace donc à chaque fois
  function placer() {
    if (!det) return;
    const corps = liste.querySelector('.theme-accordion[data-theme-id="identite"] .theme-accordion-body');
    if (corps) { if (det.parentNode !== corps) corps.prepend(det); det.hidden = false; }
    else { det.hidden = true; if (det.parentNode !== zone) zone.insertBefore(det, liste); }
  }
  new MutationObserver(() => placer()).observe(liste, { childList: true });
  function maj(ctx) {
    if (det) { det.remove(); det = null; }
    charge = null; jeton++;
    if (!ctx || !NOM[ctx.level] || !ctx.code) return;
    det = document.createElement("details"); det.className = "fiche-elu";
    det.innerHTML = `<summary>${esc(NOM[ctx.level])}</summary><div class="fiche-corps"></div>`;
    placer();
    det.addEventListener("toggle", () => { if (det.open && charge !== ctx.level + ":" + ctx.code) remplir(ctx); });
  }
  GeoState.on("context-changed", maj); maj(GeoState.context);
})();
