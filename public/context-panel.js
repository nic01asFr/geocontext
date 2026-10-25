/**
 * Panneau contexte — hiérarchie territoriale + thèmes + actions.
 *
 * Interactions :
 *   - Clic en-tête thème → charge le thème (action MCP) + ouvre l'accordéon
 *   - Clic sous-action  → charge l'action (action MCP)
 *   - Clic hiérarchie   → navigate vers le territoire
 *
 * Les résultats sont rendus sur la carte + data-panel, jamais dans le chat.
 */

const THEME_ICONS = {
  "info": "info", "building": "building", "map-pin": "grid", "alert-triangle": "alert-triangle",
  "leaf": "leaf", "truck": "truck", "droplets": "droplets", "briefcase": "briefcase",
  "home": "home", "zap": "zap", "layers": "layers", "bar-chart": "bar-chart",
};

/** Libellés lisibles des actions (l'identifiant reste la clé envoyée au serveur). */
const ACTION_LABELS = {
  iris: "IRIS", document: "Document d'urbanisme", zonages: "Zonages", prescriptions: "Prescriptions",
  servitudes: "Servitudes", parcelles: "Parcelles cadastrales", sections: "Sections cadastrales",
  radon: "Radon", catnat: "Catastrophes naturelles", cavites: "Cavités souterraines",
  argiles: "Retrait-gonflement des argiles", icpe: "Installations classées (ICPE)", ppr: "Plans de prévention (PPR)",
  znieff: "ZNIEFF", natura2000: "Natura 2000", pnr: "Parcs naturels régionaux", rnn: "Réserves naturelles nationales",
  pn: "Parcs nationaux", routes: "Routes", ferroviaire: "Réseau ferroviaire", cours_eau: "Cours d'eau",
  plans_eau: "Plans d'eau", nappes: "Nappes", batiments: "Bâtiments (BD TOPO)", rnb: "Bâtiments (RNB)", dpe_commune: "Diagnostics énergétiques (DPE)", dpe_detail: "DPE du bâtiment",
  entreprises: "Entreprises", transactions: "Transactions immobilières",
};
const libelleAction = (a) => ACTION_LABELS[a] || (String(a).replace(/_/g, " ").replace(/^./, (x) => x.toUpperCase()));

const ContextPanel = {
  _openThemes: new Set(),
  _loadingAction: null,

  init() {
    GeoState.on("context-changed", (ctx) => this.renderHierarchy(ctx));
    GeoState.on("themes-changed", (themes) => this.renderThemes(themes));
    GeoState.on("action-counts-changed", () => this.renderThemes(GeoState.context.themes || []));
  },

  /** Affiche/masque un spinner global sur le panel. */
  setLoading(loading) {
    const el = document.getElementById("panel-context");
    if (loading) {
      el.classList.add("is-loading");
    } else {
      el.classList.remove("is-loading");
    }
  },

  /** Marque un bouton d'action comme en chargement. */
  setActionLoading(action, loading) {
    this._loadingAction = loading ? action : null;
    // Re-render pour mettre à jour les visuels
    this.renderThemes(GeoState.context.themes || []);
  },

  // ================================================================
  // Hiérarchie
  // ================================================================

  renderHierarchy(ctx) {
    const el = document.getElementById("territory-badge");
    if (!el) return;
    el.textContent = "";
    if (!ctx || !ctx.level || !ctx.code) { el.classList.add("hidden"); return; }
    const h = ctx.hierarchy || {};
    const NAV = ["region", "departement", "epci", "commune"];
    const aller = (niveau, code) => GeoState.emit("navigate-request", NAV.includes(niveau) ? `${niveau}:${code}` : code);
    const etiquette = { region: "Région", departement: "Département", epci: "Intercommunalité (EPCI)", commune: "Commune", parcelle: "Parcelle", batiment: "Bâtiment" };
    const maillon = (niveau, entree) => {
      // parcelle : { idpar } ; bâtiment : { id } — pas de « code » ni de « name » dans ces maillons
      entree = { ...entree, code: entree.code ?? entree.idpar ?? entree.id };
      const nom = entree.name || entree.code;
      if (niveau === ctx.level) {
        const s = document.createElement("span"); s.className = "fil-cur"; s.setAttribute("aria-current", "location"); s.title = etiquette[niveau] || niveau;
        s.append(nom); const k = document.createElement("span"); k.className = "code"; k.textContent = entree.code; s.append(k); return s;
      }
      const b = document.createElement("button"); b.type = "button"; b.className = "fil-lien"; b.textContent = nom; b.title = `${etiquette[niveau] || niveau} — aller à ${nom}`;
      b.onclick = () => aller(niveau, entree.code); return b;
    };
    // Chaîne administrative emboîtée (région › département › commune › parcelle › bâtiment). L'EPCI est transversal : il est séparé.
    const chaine = [];
    const parents = GeoState.epciParents && GeoState.epciParents.epci === ctx.code ? GeoState.epciParents : null;
    if (ctx.level === "epci" && parents) {
      if (parents.region) chaine.push(maillon("region", parents.region));
      if (parents.departements.length === 1) chaine.push(maillon("departement", parents.departements[0]));
      else if (parents.departements.length > 1) {
        // EPCI à cheval sur plusieurs départements : un seul maillon « N départements » qui déplie la liste cliquable
        const g = document.createElement("span"); g.className = "fil-groupe";
        const b = document.createElement("button"); b.type = "button"; b.className = "fil-lien"; b.setAttribute("aria-haspopup", "true"); b.setAttribute("aria-expanded", "false");
        b.textContent = parents.departements.length + " départements ▾"; b.title = "L'EPCI s'étend sur plusieurs départements : cliquer pour choisir";
        // le menu est posé sur <body> en position fixe : le fil territorial a overflow:hidden et couperait un menu déroulant
        const m = document.createElement("div"); m.className = "fil-menu-flottant"; m.hidden = true; m.setAttribute("role", "menu");
        const fermer = () => { m.hidden = true; b.setAttribute("aria-expanded", "false"); };
        parents.departements.forEach((d) => { const i = document.createElement("button"); i.type = "button"; i.className = "fil-lien"; i.setAttribute("role", "menuitem"); i.textContent = d.name || d.code; i.onclick = () => { fermer(); aller("departement", d.code); }; m.append(i); });
        b.onclick = (e) => {
          e.stopPropagation(); if (!m.hidden) { fermer(); return; }
          document.body.append(m); const r = b.getBoundingClientRect();
          m.style.top = Math.round(r.bottom + 4) + "px"; m.style.left = Math.max(8, Math.min(Math.round(r.left), window.innerWidth - 200)) + "px";
          m.hidden = false; b.setAttribute("aria-expanded", "true"); m.querySelector("button")?.focus();
        };
        const dehors = (e) => { if (!b.isConnected) { document.removeEventListener("click", dehors); document.removeEventListener("keydown", touche); m.remove(); return; } if (!m.contains(e.target)) fermer(); };
        const touche = (e) => { if (e.key === "Escape" && !m.hidden) { fermer(); b.focus(); } };
        document.addEventListener("click", dehors); document.addEventListener("keydown", touche);
        g.append(b); chaine.push(g);
      }
    }
    // L'EPCI s'insère dans la chaîne entre département et commune (hors niveau EPCI, où il est le dernier maillon)
    for (const niveau of ["region", "departement", "epci", "commune", "parcelle", "batiment"]) {
      if (niveau === "epci" && ctx.level === "epci") continue;
      if (h[niveau]) chaine.push(maillon(niveau, niveau === "epci" ? { ...h.epci, code: h.epci.siren || h.epci.code } : h[niveau]));
    }
    if (ctx.level === "epci") chaine.push(maillon("epci", { code: ctx.code, name: ctx.name }));
    const ol = document.createElement("span"); ol.className = "fil-chaine";
    chaine.forEach((n, i) => { if (i) { const sep = document.createElement("span"); sep.className = "fil-sep"; sep.setAttribute("aria-hidden", "true"); sep.textContent = "›"; ol.append(sep); } ol.append(n); });
    el.append(ol);
    el.classList.remove("hidden");
  },

  _levelLabel(level) {
    const labels = {
      region: "RÉG", departement: "DÉP", epci: "EPCI",
      commune: "COM", parcelle: "PAR", batiment: "BÂT",
    };
    return labels[level] || level.toUpperCase().slice(0, 3);
  },

  // ================================================================
  // Thèmes en accordéon
  // ================================================================

  renderThemes(themes) {
    const el = document.getElementById("themes-list");
    const actionsSection = document.getElementById("actions-section");
    if (actionsSection) actionsSection.classList.add("hidden");

    if (!themes || themes.length === 0) {
      el.innerHTML = GeoState.context && GeoState.context.level ? "" : '<p class="placeholder">Recherchez un lieu pour commencer.</p>';
      return;
    }

    const ctx = GeoState.context;
    const counts = GeoState.actionCounts || {};
    const actifAvant = this._lastActive; this._lastActive = ctx.theme || null;
    const etroit = window.matchMedia && matchMedia("(max-width: 640px)").matches;
    void actifAvant;

    el.innerHTML = themes.map((t) => {
      const isActive = ctx.theme === t.id;
      // un thème qui vient de devenir actif s'ouvre ; ensuite l'utilisateur peut le replier sans le décharger
      if (isActive && this._lastActive !== t.id) (this._ferme || (this._ferme = new Set())).delete(t.id);
      const isOpen = this._openThemes.has(t.id) || (isActive && !(this._ferme && this._ferme.has(t.id)));
      const icon = Icon(THEME_ICONS[t.icon] || t.id, 18);
      const actions = t.actions || [];

      const actionsHtml = actions.map((a) => {
        const count = counts[a];
        const isLoading = this._loadingAction === a;
        const badge = isLoading
          ? '<span class="action-spinner"></span>'
          : count !== undefined
            ? `<span class="action-count">${count}</span>`
            : "";
        const cls = `action-btn${isLoading ? " loading" : ""}`;
        return `<button class="${cls}" data-action="${a}" title="${libelleAction(a)}"><span class="action-label">${libelleAction(a)}</span>${badge}</button>`;
      }).join("");

      return `
        <div class="theme-accordion${isActive ? " active-theme" : ""}" data-theme-id="${t.id}">
          <button class="theme-accordion-header${isActive ? " active" : ""}${isOpen ? " open" : ""}"
                  data-theme="${t.id}" aria-expanded="${isOpen}" aria-controls="theme-body-${t.id}">
            <span class="icon">${icon}</span>
            <span class="label">${t.label}</span><span class="n-actions">${actions.length || ""}</span>
            <span class="chevron">${Icon("chevron-down", 16)}</span>
          </button>
          <div class="theme-accordion-body${isOpen ? " open" : ""}" id="theme-body-${t.id}" role="region">
            ${actionsHtml || '<span class="placeholder">Chargement…</span>'}
          </div>
        </div>
      `;
    }).join("");

    // Clics en-tête de thème → charge le thème via action MCP
    el.querySelectorAll(".theme-accordion-header").forEach((btn) => {
      btn.addEventListener("click", () => {
        const themeId = btn.dataset.theme;
        const ouvert = btn.classList.contains("open"), isActive = ctx.theme === themeId;
        const ferme = this._ferme || (this._ferme = new Set());
        if (ouvert) {
          // replier : le thème reste chargé sur la carte, seule sa liste d'actions se range
          this._openThemes.delete(themeId); ferme.add(themeId);
          this.renderThemes(GeoState.context.themes || []);
        } else {
          ferme.delete(themeId); this._openThemes.add(themeId);
          // écran étroit : un seul thème ouvert à la fois pour garder la place
          if (etroit) for (const id of [...this._openThemes]) if (id !== themeId) { this._openThemes.delete(id); ferme.add(id); }
          if (!isActive) GeoState.emit("action-request", themeId);
          else this.renderThemes(GeoState.context.themes || []);
        }
      });
    });

    // Clics sous-actions → charger l'action (le serveur résout le thème implicitement)
    el.querySelectorAll(".action-btn").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        GeoState.emit("action-request", btn.dataset.action);
      });
    });
  },
};

window.ContextPanel = ContextPanel;
