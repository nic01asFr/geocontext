/**
 * Carte geocontext sur le composant <atlas-bi> (Atlas, contrat « carte BI 0.3 »).
 * Même interface que map.js (window.GeoMap) : geo-fetcher, app, data-panel n'ont pas à changer.
 *
 * Correspondances :
 *   addGeoJsonLayer(styleRecipe) -> couche du manifeste (single / categorized / graduated) + bulle d'objet
 *   addContextLayer              -> couche polygone discrète, bulle avec action « Naviguer »
 *   addTerritoryBoundary         -> couche polygone, contour pointillé
 *   légende                      -> légende native d'Atlas (interface.legende)
 *   clic dans le vide            -> mode « Pointer » (calque hôte + caméra reçue), Atlas n'émet pas de coordonnées
 */
const ATLAS_SRC = "https://nic01asfr.github.io/Widgets-Grist/atlas/index.html";
const ATLAS_ELEMENT = "https://nic01asfr.github.io/Widgets-Grist/atlas/lib/bi/atlas-bi-element.js";
const CTX_PREFIX = "_ctx_";
const LEVEL_DEFS = {
  region: { label: "RÉG", color: "#7a8abd", level: "region" },
  departement: { label: "DÉP", color: "#6a9aad", level: "departement" },
  epci: { label: "EPCI", color: "#5aadad", level: "epci" },
  commune: { label: "COM", color: "#4aad8a", level: "commune" },
};
const CHILD_LEVEL = { region: "departement", departement: "epci", epci: "commune", commune: null };
const ZOOM_TO_LEVEL = [
  { minZoom: 0, maxZoom: 6.5, level: "region" }, { minZoom: 6.5, maxZoom: 8.5, level: "departement" },
  { minZoom: 8.5, maxZoom: 10.5, level: "epci" }, { minZoom: 10.5, maxZoom: 25, level: "commune" },
];
const safeId = (s) => "l_" + String(s).replace(/[^A-Za-z0-9_]/g, "_");

const GeoMap = {
  el: null, ready: null, cam: { center: [2.5, 46.8], zoom: 5.2, bearing: 0, pitch: 0 },
  _layers: new Map(),      // atlasId -> { id, kind, geom, features, base, meta, def, dirty }
  _byGc: new Map(),        // id geocontext -> atlasId
  _nextBase: 1, _structure: false, _timer: null, _navContext: null, _ctxCurrentLevel: null,
  _ctxDebounce: null, _pickOn: false,

  init() {
    const host = document.getElementById("map");
    host.innerHTML = "";
    this._host = host; this._echecs = 0;
    this._start();
    this._buildPick(host);
    GeoState.on("context-changed", (ctx) => { if (ctx.bbox) this.fitBbox(ctx.bbox); this._updateBadge(ctx); });
    this.ready.then(() => this._observeInsets());
    GeoState.on("feature-hover", (idx) => this._hoverFromPanel(idx));
    GeoState.on("feature-select", (idx) => this._selectFromPanel(idx));
    // Atlas ne démarre pas dans un onglet masqué (page ouverte en arrière-plan) : on relance dès que la page est visible
    this._suivreTheme();
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && this._failed) this._restart(); });
  },

  /** Crée le composant Atlas et lance son démarrage ; `_failed` reste vrai tant qu'il n'a pas répondu. */
  _start() {
    const el = document.createElement("atlas-bi");
    el.setAttribute("src", ATLAS_SRC); // profil complet par défaut (même manifeste BI qu'en carte nue : comptes et commandes identiques, mesuré) ; ?atlas=nu pour la carte nue
    const complet = new URLSearchParams(location.search).get("atlas") !== "nu"; this._profil = complet ? "complet" : "nu";
    if (complet) el.setAttribute("profil", "complet");
    el.setAttribute("delai", complet ? "90000" : "30000"); if (complet) el.setAttribute("delai-connexion", "90000"); el.setAttribute("evenements-api", ""); el.setAttribute("charte", "herite"); // la carte lit les jetons --atlas-* de la page et suit le thème clair/sombre
    el.style.cssText = "display:block;width:100%;height:100%";
    this._host.appendChild(el); this.el = el; this._failed = true;
    for (const t of ["select", "action", "camera", "error"]) el.addEventListener("atlas-bi-" + t, (e) => this[t === "error" ? "_on_error" : "_on_" + t](e.detail?.charge ?? e.detail, e.detail?.origine));
    this.ready = (async () => {
      await import(ATLAS_ELEMENT);
      await el.pret;
      await el.setScene({ layers: [], interface: { legende: false } }, {});
      await this._appliquerFond();
      await el.flyTo({ center: [2.5, 46.8], zoom: 5.2, bearing: 0, pitch: 0, duration: 0 }).catch(() => {});
      this._failed = false;
      this._updateContextLayer();
    })().catch((e) => { this._failed = true; this._echecs = (this._echecs || 0) + 1; console.warn("[map-atlas] init:", e.message); if (window.GeoBanner) { const abandon = !(document.visibilityState === "visible" && this._echecs < 3); GeoBanner("La carte n'a pas démarré (" + e.message + "). " + (abandon ? (document.visibilityState === "visible" ? "Les affichages de cette page ne sont pas à jour sur la carte." : "Elle redémarrera dès que cette page sera visible.") : "Nouvelle tentative…"), "erreur", abandon ? { label: "Relancer la carte", fn: () => { this._echecs = 0; this._restart(); } } : undefined); } if (document.visibilityState === "visible" && this._echecs < 3) setTimeout(() => this._restart(), 1500); });
  },

  /** Thème sombre actif (réglage explicite de la page, sinon réglage système). */
  _sombre() {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : matchMedia("(prefers-color-scheme: dark)").matches;
  },

  /** Fond de plan : plan IGN en clair ; plan vectoriel aux couleurs de la charte en sombre (le plan IGN est clair). */
  async _appliquerFond() {
    const mode = this._sombre() ? "plan" : "plan-ign";
    try { await this.el.setFond(mode); this._fond = mode; }
    catch (e) { if (mode === "plan") { await this.el.setFond("plan-ign"); this._fond = "plan-ign"; } else await this.el.setFond("plan"); }
  },

  /** Suit les changements de thème de la page (bouton, réglage système). */
  _suivreTheme() {
    if (this._themeObs) return;
    // Le plan dépend de la charte : on attend que la carte ait relu le thème de la page (événement « herite », 4 s au plus) avant de choisir le fond
    const maj = async () => {
      if (this._failed || !this.el) return;
      await new Promise((ok) => { const f = () => { this.el.removeEventListener("atlas-bi-herite", f); ok(); }; this.el.addEventListener("atlas-bi-herite", f); setTimeout(f, 4000); });
      this._appliquerFond().catch((e) => window.GeoBanner && GeoBanner("Le fond de carte n'a pas suivi le thème : " + e.message, "erreur")); };
    this._themeObs = new MutationObserver(maj);
    this._themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", maj);
  },

  /** Redémarre Atlas et renvoie toutes les couches de l'hôte (l'état des filtres est rejoué par l'envoi de scène). */
  _restart() {
    if (this._restarting) return; this._restarting = true;
    try { this.el?.remove(); } catch {}
    this._start();
    this.ready.then(() => {
      this._restarting = false;
      if (this._failed) return;
      for (const l of this._layers.values()) l.dirty = true;
      this._structure = true; this._schedule(50);
      document.getElementById("app-banner")?.remove();
    });
  },

  // ── caméra ──────────────────────────────────────────────────────
  // Zone de carte réellement libre : on retranche ce que masquent le panneau, le fil territorial et le volet du bas
  _insets() {
    const r = this.el.getBoundingClientRect(), g = 12, vis = (id) => {
      const e = document.getElementById(id); if (!e) return null;
      const cs = getComputedStyle(e); if (cs.display === "none" || cs.visibility === "hidden") return null;
      const b = e.getBoundingClientRect(); return b.width && b.height ? b : null;
    };
    const pc = vis("panel-context"), bc = vis("territory-badge"), dp = vis("data-panel"), mobile = r.width <= 640;
    const I = { L: 0, T: 0, R: 0, B: 0 };
    if (pc) { if (mobile) I.T = Math.max(I.T, pc.bottom - r.top + g); else I.L = Math.max(I.L, pc.right - r.left + g); }
    if (bc) I.T = Math.max(I.T, bc.bottom - r.top + g);
    if (dp) I.B = Math.max(I.B, r.bottom - dp.top + g);
    // si la zone libre devient trop petite (mobile, panneau ouvert), on ne s'y fie pas : mieux vaut cadrer sur toute la carte
    if (r.width - I.L - I.R < r.width * 0.3 || r.height - I.T - I.B < r.height * 0.3) return { L: 0, T: bc ? Math.max(0, bc.bottom - r.top + g) : 0, R: 0, B: 0, r, reduit: true };
    return { ...I, r };
  },
  /**
   * Emprise [ouest, sud, est, nord] de la zone LIBRE de la carte (hors panneaux flottants), calculée depuis la caméra (même convention
   * Mercator 512 px que fitBbox). Vue pivotée ou inclinée : l'emprise n'est plus un rectangle, on refuse plutôt que d'approcher.
   */
  zoneVisible() {
    if (!this.el || !this.cam) return { erreur: "la caméra de la carte n'est pas encore connue" };
    const c = this.cam;
    if (Math.abs(c.bearing || 0) > 0.5 || Math.abs(c.pitch || 0) > 0.5) return { erreur: "la vue est pivotée ou inclinée : la zone visible n'est pas un rectangle, remettre le nord en haut et la vue à plat" };
    const I = this._insets(), r = I.r, S = 512 * 2 ** c.zoom;
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const cx = ((c.center[0] + 180) / 360) * S, cy = (0.5 - mercY(c.center[1]) / (2 * Math.PI)) * S;
    const lon = (x) => (x / S) * 360 - 180, lat = (y) => (Math.atan(Math.sinh(Math.PI * (1 - 2 * (y / S)))) * 180) / Math.PI;
    const x0 = cx + I.L - r.width / 2, x1 = cx + (r.width - I.R) - r.width / 2, y0 = cy + I.T - r.height / 2, y1 = cy + (r.height - I.B) - r.height / 2;
    return { bbox: [lon(x0), lat(y1), lon(x1), lat(y0)], reduit: !!I.reduit };
  },
  fitBbox(bbox, duree = 800) {
    if (!bbox || bbox.length !== 4 || !this.el) return;
    this._focusBbox = bbox; this._userMoved = false;
    const I = this._insets(), r = I.r, pad = 24;
    const fw = Math.max(r.width - I.L - I.R - 2 * pad, 50), fh = Math.max(r.height - I.T - I.B - 2 * pad, 50);
    const mercY = (lat) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));
    const spanX = Math.max((bbox[2] - bbox[0]) / 360, 1e-9), spanY = Math.max((mercY(bbox[3]) - mercY(bbox[1])) / (2 * Math.PI), 1e-9);
    const zoom = Math.min(Math.log2(fw / (512 * spanX)), Math.log2(fh / (512 * spanY)), 19);
    // centre de la carte tel que le centre de l'emprise tombe au centre de la zone libre
    const S = 512 * 2 ** zoom, wx = (lon) => ((lon + 180) / 360) * S, wy = (lat) => (0.5 - mercY(lat) / (2 * Math.PI)) * S;
    const bx = (wx(bbox[0]) + wx(bbox[2])) / 2, by = (wy(bbox[1]) + wy(bbox[3])) / 2;
    const dx = I.L + (r.width - I.L - I.R) / 2 - r.width / 2, dy = I.T + (r.height - I.T - I.B) / 2 - r.height / 2;
    const cx = bx - dx, cy = by - dy;
    const lon = (cx / S) * 360 - 180, lat = (Math.atan(Math.sinh(Math.PI * (1 - 2 * (cy / S)))) * 180) / Math.PI;
    this.ready.then(() => this.el.flyTo({ center: [lon, lat], zoom, bearing: 0, pitch: 0, duration: duree })).catch(() => {});
  },
  // le cadrage suit la mise en page : ouverture/repli du panneau ou du volet BI, rotation, redimensionnement (sauf si l'utilisateur a déplacé la carte)
  _observeInsets() {
    if (this._insetObs || !window.ResizeObserver || !this.el) return;
    let t = 0; const rafraichir = () => { clearTimeout(t); t = setTimeout(() => { if (this._focusBbox && !this._userMoved) this.fitBbox(this._focusBbox, 400); }, 250); };
    this._insetObs = new ResizeObserver(rafraichir);
    ["panel-context", "territory-badge", "data-panel"].forEach((id) => { const e = document.getElementById(id); if (e) this._insetObs.observe(e); });
    this._insetObs.observe(this.el);
    const m = () => { this._userMoved = true; };
    this.el.addEventListener("pointerdown", m, { passive: true }); this.el.addEventListener("wheel", m, { passive: true });
  },

  // ── couches thématiques ─────────────────────────────────────────
  _geom(features, recipe) {
    // le type de la couche est contrôlé sur TOUS les objets (pas seulement le premier) : mélange ou type inconnu = refus explicite, jamais une couche amputée
    const fam = (t) => (t ? (t.includes("Polygon") ? "polygon" : t.includes("Line") ? "line" : t.includes("Point") ? "point" : "autre:" + t) : null);
    const types = new Set(features.map((f) => fam(f.geometry?.type)).filter(Boolean));
    if (types.size > 1 || [...types].some((x) => x.startsWith("autre"))) throw new Error(`couche à géométries mixtes ou non gérées (${[...types].join(", ")}) : non représentable sur la carte sans en écarter une partie`);
    const g = recipe?.geometryType || [...types][0] || "point";
    if (types.size && !types.has(g)) throw new Error(`type de géométrie annoncé « ${g} » différent des géométries reçues (${[...types].join(", ")})`);
    return g;
  },

  _declarative(recipe, style, theme) {
    const c = recipe?.classification;
    const base = (GeoStyles.forTheme(theme || style?.theme));
    if (c?.method === "categorical" && c.colorMap) {
      const lab = {}; for (const it of recipe.legend?.items || []) { const m = String(it.label).match(/\(([^)]+)\)$/); if (m) lab[m[1]] = it.label; }
      return { kind: "categorized", field: c.field, opacity: 0.55, stops: Object.entries(c.colorMap).map(([value, color]) => ({ value, label: lab[value] || value, color })) };
    }
    if (c?.method === "graduated" && c.breaks && c.colors) { const n = c.colors.length, b = c.breaks; if (b.length !== n + 1) return { kind: "single", color: c.colors[0], opacity: 0.6 };
      return { kind: "graduated", field: c.field, opacity: 0.6, stops: c.colors.map((color, i) => ({ lower: i === 0 ? null : b[i], upper: i === n - 1 ? null : b[i + 1], color, label: `${b[i]} – ${b[i + 1]}` })) }; }
    return { kind: "single", color: c?.color || base.color, opacity: Math.max(base.opacity || 0.5, 0.35) };
  },
  addGeoJsonLayer(id, geojson, style = {}, meta = {}) {
    const features = geojson.features || [];
    const geom = this._geom(features, meta.styleRecipe);
    const aid = safeId(id), prev = this._layers.get(aid);
    const base = prev?.base ?? this._nextBase; if (!prev) this._nextBase += features.length + 100000;
    const fields = (meta.primaryFields || []).slice(0, 4);
    const tpl = meta.styleRecipe?.labelTemplate;
    const def = { id: aid, name: meta.label || id, geometry_type: geom, style: { declarative: this._declarative(meta.styleRecipe, style, meta.theme) },
      ...(geom === "polygon" ? { visuel: { contour: { couleur: "#3d5560", largeur: 0.6 } } } : {}),
      bulle: { titre: tpl ? tpl.replace(/\{([^}]+)\}/g, "{$1}") : (fields[0] ? `{${fields[0]}}` : meta.label || id), champs: fields.map((f) => ({ champ: f, libelle: f })) } };
    this._layers.set(aid, { id: aid, gc: id, kind: "thematic", geom, features, base, meta, def, dirty: true });
    this._byGc.set(id, aid); this._structure = this._structure || !prev; this._schedule(prev ? 700 : 80);
  },
  updateGeoJsonSource(id, geojson) {
    const l = this._layers.get(safeId(id)); if (!l) return;
    l.features = geojson.features || []; l.dirty = true;
    // chargement progressif : un renvoi complet coûte O(n) côté Atlas -> on n'envoie qu'à chaque doublement, puis une fois la fin des pages passée
    if (l.features.length >= 2 * (l.sent || 1000)) this._schedule(50); else this._schedule(2500);
  },
  /** Contrôles de filtre d'une couche (définitions) : renvoie la scène seulement si la couche est déjà partie. */
  setFilterControls(id, controls) {
    const l = this._layers.get(safeId(id)); if (!l) return;
    l.def.controls = controls; l.filterState = {};
    if (l.sent) { l.dirty = true; this._structure = true; this._schedule(50); }
  },
  async _settled() { while (this._timer || this._flushing) await new Promise((r) => setTimeout(r, 40)); await this.ready; },
  /** setFilter d'un contrôle, une fois la scène envoyée ; renvoie {layer, compte, total} d'Atlas. */
  async applyFilter(id, controlId, value) {
    const l = this._layers.get(safeId(id)); if (!l) throw new Error("couche inconnue");
    await this._settled();
    l.filterState = l.filterState || {}; l.filterState[controlId] = value;
    const r = await this.el.setFilter(controlId, value);
    this._renderLegend(); // la légende (comptes par classe) suit le filtre : jamais de comptes périmés à l'écran
    return r;
  },
  /**
   * Colorie une couche par classes décidées par l'HÔTE (spec = { champ: propriété texte portant le nom de classe, categories:[{value,label,color}] }) : Atlas ne classe pas lui-même (ses bornes numériques et ses valeurs absentes ont une sémantique propre, mesurée : borne haute incluse, absent compté comme 0) ; spec nul = style d'origine.
   * Renvoie la légende LUE sur la carte (classes + comptes) : l'appelant la compare à ses propres comptes avant de conclure.
   */
  async colorerPar(id, spec) {
    const l = this._layers.get(safeId(id)); if (!l) throw new Error("couche inconnue");
    if (!l.declBase) l.declBase = l.def.style.declarative;
    l.def.style.declarative = spec ? { kind: "categorized", field: spec.champ, opacity: 0.7, stops: spec.categories } : l.declBase;
    l.spec = spec || null; l.dirty = true; this._structure = true; this._schedule(30);
    await this._settled();
    return this.el.getLegend(l.id);
  },
  /** Forme de représentation d'une couche de POINTS (cercles, proportionnel, heat, hex, grille) : setVisual d'Atlas, erreur remontée telle quelle. */
  async formeVisuelle(id, visuel) {
    const l = this._layers.get(safeId(id)); if (!l) throw new Error("couche inconnue");
    if (l.geom !== "point") throw new Error("cette représentation ne s'applique qu'à des points (couche de type " + l.geom + ")");
    await this._settled();
    l.visuel = visuel || null;
    const r = await this.el.setVisual(l.id, visuel || { type: "cercles" });
    this._renderLegend();
    return r;
  },
  /** Rampe séquentielle de la charte d'Atlas (celle des couches sans rampe propre) : lue une fois. */
  async _lireRampe() {
    if (this._rampeTheme) return this._rampeTheme;
    const t = await this.el.getTheme(), d = t?.charte?.donnees;
    const r = d?.sequentielles?.[d?.sequentielleDefaut || "principale"];
    if (!Array.isArray(r) || !r.length) throw new Error("rampe séquentielle introuvable dans la charte d'Atlas");
    return (this._rampeTheme = r);
  },
  /**
   * Rampe PROPRE À UNE COUCHE (chaleur, hexagones, grille) : surcharge de couche d'Atlas (`style.charte`, niveau le plus fort de la résolution de charte),
   * donc sans effet sur les autres couches. couleurs = liste du plus bas au plus haut ; null = rampe de la charte.
   */
  async setRampe(id, couleurs) {
    const l = this._layers.get(safeId(id)); if (!l) throw new Error("couche inconnue");
    await this.ready; await this._lireRampe();
    if (couleurs) l.def.style.charte = { donnees: { sequentielles: { principale: couleurs } } }; else delete l.def.style.charte;
    l.rampe = couleurs || null; l.dirty = true; this._structure = true; this._avert = null; this._schedule(30);
    await this._settled();
    const refus = this._avert?.[l.id]; // Atlas dit ce qu'il ignore : jamais une palette annoncée mais non appliquée
    if (couleurs && refus && JSON.stringify(refus).includes("charte")) { delete l.def.style.charte; l.rampe = null; l.dirty = true; this._structure = true; this._schedule(30); throw new Error("Atlas a ignoré la palette de la couche : " + JSON.stringify(refus)); }
    this._renderLegend(); return couleurs || await this._lireRampe();
  },
  /** Légende d'une couche en chaleur / hexagones / grille : une rampe continue, pas des classes (les classes de surface ne sont pas ce qui est dessiné). */
  async _legendeRampe(box, vt, g, l) {
    let R; try { R = l?.rampe || await this._lireRampe(); } catch { R = null; }
    const note = (txt) => { const n = document.createElement("div"); n.className = "legend-note"; n.textContent = txt; box.appendChild(n); };
    if (!R) { note("Échelle de couleurs indisponible (charte d'Atlas illisible)."); return; }
    const bar = document.createElement("div"); bar.className = "legend-ramp"; bar.style.background = `linear-gradient(to right, ${R.join(",")})`; box.appendChild(bar);
    const ends = document.createElement("div"); ends.className = "legend-ramp-ends"; box.appendChild(ends);
    const lo = document.createElement("span"), hi = document.createElement("span"); ends.append(lo, hi);
    if (vt === "heat") { lo.textContent = "faible"; hi.textContent = "forte"; note("Densité de points, non pondérée : pas d'échelle chiffrée."); return; }
    const ag = g?.agregat;
    if (!ag) { lo.textContent = "?"; hi.textContent = "?"; note("Échelle de la maille indisponible : Atlas n'a pas renvoyé l'agrégat."); return; }
    const fr0 = (x) => Number(x).toLocaleString("fr-FR");
    if (ag.metrique === "n") { lo.textContent = "1"; hi.textContent = fr0(ag.nMax); note(`Nombre de points par case de ${fr0(ag.tailleMetres)} m (${fr0(ag.cases)} cases non vides).`); }
    else { lo.textContent = "faible"; hi.textContent = ag.valeurMax != null ? fr0(ag.valeurMax) : "max"; note(`${ag.metrique} par case de ${fr0(ag.tailleMetres)} m (${fr0(ag.cases)} cases non vides).`); }
  },
  /** Agrégat (hex/grille) tel que LU sur la carte : cases, maximum, seuils. null si la couche n'est pas agrégée. */
  async agregat(id) {
    const l = this._layers.get(safeId(id)); if (!l) throw new Error("couche inconnue");
    await this._settled();
    const g = await this.el.getLegend(l.id);
    return g?.agregat || null;
  },
  /** Inclinaison de la caméra (le relief 3D ne se lit qu'incliné). */
  async incliner(pitch, bearing) {
    await this.ready;
    return this.el.flyTo({ pitch, bearing, duration: 500 });
  },
  geomDe(id) { return this._layers.get(safeId(id))?.geom || null; },
  removeLayer(id) { this._pinned.delete(safeId(id)); if (this._layers.delete(safeId(id))) { this._structure = true; this._schedule(50); } },
  _pinned: new Set(), // couches épinglées : conservées par clearLayers() (sauf demande explicite « tout »)
  epingler(ids) { for (const i of ids) this._pinned.add(safeId(i)); },
  desepingler(ids) { for (const i of ids) this._pinned.delete(safeId(i)); },
  estEpinglee(id) { return this._pinned.has(safeId(id)); },
  clearLayers(tout) {
    if (tout) this._pinned.clear();
    for (const [k, l] of this._layers) if (l.kind === "thematic" && !this._pinned.has(k)) this._layers.delete(k);
    this._structure = true; this._schedule(50);
  },
  toggleLayer(id, visible) { this.ready.then(() => this.el.setLayerVisibility(safeId(id), !!visible)).catch(() => {}); },

  // ── contexte & contour ──────────────────────────────────────────
  addTerritoryBoundary(geojson) {
    this._layers.set("l_boundary", { id: "l_boundary", kind: "boundary", geom: "polygon", features: geojson.features || [], base: 900000000, dirty: true,
      def: { id: "l_boundary", name: "Territoire", geometry_type: "polygon", style: { declarative: { kind: "single", color: "#4a90d9", opacity: 0.04 } }, visuel: { contour: { couleur: "#2a70b9", largeur: 2, tirets: [4, 3] } } } });
    this._structure = true; this._schedule(80);
  },
  clearBoundary() { if (this._layers.delete("l_boundary")) { this._structure = true; this._schedule(50); } },
  addContextLayer(id, geojson, levelDef) {
    this.clearContextLayer(true);
    if (!geojson.features?.length) return;
    this._layers.set("l_ctx", { id: "l_ctx", kind: "ctx", geom: "polygon", features: geojson.features, base: 800000000, dirty: true, levelDef,
      def: { id: "l_ctx", name: `Limites ${levelDef.label}`, geometry_type: "polygon", cle: "_code", style: { declarative: { kind: "single", color: levelDef.color, opacity: 0.1 } },
        visuel: { contour: { couleur: levelDef.color, largeur: 1.2 } },
        bulle: { titre: "{_nom}", champs: [{ champ: "_niveau", libelle: "Niveau" }, { champ: "_code", libelle: "Code" }], actions: [{ id: "naviguer", libelle: "→ Naviguer" }] } } });
    this._structure = true; this._schedule(80);
  },
  clearContextLayer(silent) { if (this._layers.delete("l_ctx") && !silent) { this._structure = true; this._schedule(50); } },
  setNavigationContext(ctx) { this._navContext = ctx; this.clearContextLayer(); this._ctxCurrentLevel = null; this._updateContextLayer(); },
  resetContextLayer() { this._navContext = null; this._ctxCurrentLevel = null; this._updateContextLayer(); },
  _updateContextLayer() {
    const c = this.cam, r = this.el?.getBoundingClientRect() || { width: 800, height: 600 };
    const dLon = (r.width / (512 * 2 ** c.zoom)) * 360 / 2, dLat = dLon * (r.height / r.width) * 0.75;
    const bbox = [c.center[0] - dLon, c.center[1] - dLat, c.center[0] + dLon, c.center[1] + dLat];
    if (this._navContext?.level) {
      const child = CHILD_LEVEL[this._navContext.level];
      if (!child) {
        const h = this._navContext.hierarchy || {};
        if (this._navContext.level === "commune" && (h.epci?.siren || h.departement?.code)) {
          if (this._ctxCurrentLevel === "commune:freres") return;
          this._ctxCurrentLevel = "commune:freres";
          const parent = h.epci?.siren ? { level: "epci", code: h.epci.siren, hierarchy: { epci: h.epci } } : { level: "departement", code: h.departement.code, hierarchy: { departement: h.departement } };
          GeoState.emit("context-layer-update", { level: "commune", bbox, parent, freres: this._navContext.code }); return;
        }
        this.clearContextLayer(); this._ctxCurrentLevel = null; return;
      }
      if (child === this._ctxCurrentLevel) return;
      this._ctxCurrentLevel = child;
      GeoState.emit("context-layer-update", { level: child, bbox, parent: this._navContext }); return;
    }
    if (this._navContext) return;
    const def = ZOOM_TO_LEVEL.find((z) => c.zoom >= z.minZoom && c.zoom < z.maxZoom) || ZOOM_TO_LEVEL[0];
    if (def.level === this._ctxCurrentLevel) return;
    this._ctxCurrentLevel = def.level;
    GeoState.emit("context-layer-update", { level: def.level, bbox });
  },

  /** Environnement de la carte ({ relief, soleil }) : renvoie la scène complète, Atlas ne garde pas un environnement absent d'une scène. */
  setEnvironnement(env) { this._env = env || {}; for (const l of this._layers.values()) l.dirty = true; this._structure = true; this._schedule(50); },
  // ── envoi vers Atlas ────────────────────────────────────────────
  _schedule(ms) { clearTimeout(this._timer); this._timer = setTimeout(() => this._flush(), ms); },
  _order: { boundary: 0, ctx: 1, thematic: 2 },
  _timer: null, _flushing: false,
  async _flush() {
    this._timer = null; this._flushing = true;
    try { await this._flushInner(); } finally { this._flushing = false; }
  },
  async _flushInner() {
    await this.ready; if (!this.el) return;
    const structure = this._structure; this._structure = false;
    const ls = [...this._layers.values()].filter((l) => structure || l.dirty).sort((a, b) => this._order[a.kind] - this._order[b.kind]);
    if (!ls.length && !structure) return;
    const data = {};
    for (const l of ls) {
      const fk = l.kind === "ctx" ? (f, i) => ({ ...f, id: l.base + i + 1, properties: { ...f.properties, _nom: f.properties?.nom_officiel || f.properties?.nom || "?", _code: f.properties?.code_insee || f.properties?.code_siren || f.properties?.nom || "", _niveau: l.levelDef.label } })
        : (f, i) => ({ ...f, id: l.base + i + 1 });
      data[l.id] = l.features.map(fk).filter((f) => f.geometry); l.dirty = false; l.sent = data[l.id].length; // sans géométrie = dans le tableau, pas sur la carte (identifiants = rang dans le tableau)
    }
    const manifest = { layers: ls.map((l) => l.def), interface: { legende: false } };
    if (!structure) manifest.fusion = true; else if (this._env && Object.keys(this._env).length) manifest.environnement = this._env; // relief / soleil : rejoués à chaque scène complète
    try { const r = await this.el.setScene(manifest, data); this._avert = r?._avertissements || null; if (r?._erreurs) console.warn("[map-atlas] _erreurs", r._erreurs); }
    catch (e) { console.warn("[map-atlas] setScene:", e.message); }
    // un renvoi de scène remet les filtres à zéro côté Atlas : on rejoue l'état connu de l'hôte
    for (const l of ls) for (const [ctl, val] of Object.entries(l.filterState || {})) { if (val == null) continue; try { await this.el.setFilter(ctl, val); } catch (e) { console.warn("[map-atlas] setFilter (rejeu):", e.message); } }
    for (const l of ls) if (l.visuel) { try { await this.el.setVisual(l.id, l.visuel); } catch (e) { console.warn("[map-atlas] setVisual (rejeu):", e.message); } }
    this._renderLegend();
  },
  /** Légende hôte (couches thématiques seulement), d'après getLegend d'Atlas : pastille, libellé, compte. */
  async _renderLegend() {
    const mon = (this._legTok = (this._legTok || 0) + 1);
    document.getElementById("map-legend")?.remove();
    const th = [...this._layers.values()].filter((l) => l.kind === "thematic"); if (!th.length) return;
    const box = document.createElement("div"); box.id = "map-legend"; box.className = "map-legend";
    let any = false;
    for (const l of th) {
      let g; try { g = await this.el.getLegend(l.id); } catch { continue; }
      if (!g?.classes?.length) continue; any = true;
      const titre = l.meta?.styleRecipe?.legend?.title || g.titre || l.meta?.label;
      if (g.classes.length === 1) { // une seule classe : une seule ligne (pastille, libellé, compte), sans titre redondant
        const c = g.classes[0], row = document.createElement("div"); row.className = "legend-item legend-seule";
        const sw = document.createElement("span"); sw.className = "legend-swatch"; sw.style.background = c.couleur; row.appendChild(sw);
        const lb = document.createElement("span"); lb.className = "legend-label"; lb.textContent = titre; lb.title = titre; row.appendChild(lb);
        if (typeof c.compte === "number") { const n = document.createElement("span"); n.className = "legend-count"; n.textContent = c.compte.toLocaleString("fr-FR"); row.appendChild(n); }
        box.appendChild(row); continue;
      }
      const t = document.createElement("div"); t.className = "legend-title"; t.title = titre;
      const nTot = Number(g.total ?? l.features.length).toLocaleString("fr-FR");
      const ecart = window.DataPanel && l.id.endsWith(window.DataPanel._sourceId || "\u0000") ? Number(window.DataPanel._meta?.ecartees || 0) : 0;
      const tt = document.createElement("span"); tt.className = "legend-t"; tt.textContent = titre;
      const tn = document.createElement("span"); tn.className = "legend-n"; tn.textContent = ecart ? `${nTot} sur la carte` : nTot;
      t.append(tt, tn);
      t.setAttribute("role", "button"); t.tabIndex = 0; t.title = "Replier / déplier la légende";
      t.onclick = () => box.classList.toggle("repliee"); t.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t.click(); } };
      box.appendChild(t);
      const vt = l.visuel?.type;
      if (vt === "heat" || vt === "hex" || vt === "grille") { await this._legendeRampe(box, vt, g, l); continue; }
      for (const c of g.classes) {
        const row = document.createElement("div"); row.className = "legend-item";
        const sw = document.createElement("span"); sw.className = "legend-swatch"; sw.style.background = c.couleur; row.appendChild(sw);
        const lb = document.createElement("span"); lb.className = "legend-label"; lb.textContent = c.libelle; row.appendChild(lb);
        // ligne de légende = filtre sur la catégorie, seulement si le champ colorié est une colonne à catégories du tableau (même circuit : tableau + carte + contrôle)
        const decl = l.def?.style?.declarative, stop = decl?.stops?.find((x) => x.label === c.libelle || x.value === c.libelle);
        if (decl?.field && stop && window.DataPanel?.categorieFiltrable?.(l.id, decl.field, String(stop.value))) {
          const champ = decl.field, val = String(stop.value), on = DataPanel.estCochee(champ, val);
          row.classList.add("legend-clic"); if (on) row.classList.add("on");
          row.setAttribute("role", "button"); row.tabIndex = 0; row.setAttribute("aria-pressed", String(on)); row.title = (on ? "Retirer" : "Filtrer sur") + " « " + c.libelle + " »";
          const agir = () => DataPanel._basculerCategorie(champ, val);
          row.onclick = agir; row.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); agir(); } };
        }
        if (c.compte === 0) row.classList.add("vide"); // classe sans élément dans la sélection courante : atténuée, jamais masquée
        if (typeof c.compte === "number") { const n = document.createElement("span"); n.className = "legend-count"; n.textContent = c.compte.toLocaleString("fr-FR"); row.appendChild(n); }
        box.appendChild(row);
      }
    }
    if (any && mon === this._legTok) { document.getElementById("map-legend")?.remove(); document.getElementById("panel-context")?.appendChild(box); }
  },

  // ── événements Atlas ────────────────────────────────────────────
  _locate(layerId, featureId) {
    const l = this._layers.get(layerId); if (!l) return null;
    const idx = featureId - l.base - 1; return { l, idx, feature: l.features[idx] };
  },
  _on_select(d, origine) {
    if (origine === "api" || !d || d.featureId == null) return;
    const loc = this._locate(d.layer, d.featureId); if (!loc || loc.l.kind !== "thematic" || !loc.feature) return;
    GeoState.emit("feature-click", { feature: { ...loc.feature, id: loc.idx }, meta: loc.l.meta });
  },
  _on_action(d, origine) {
    if (origine === "api" || d?.actionId !== "naviguer") return;
    const loc = this._locate(d.layer, d.featureId); if (!loc?.feature) return;
    const p = loc.feature.properties || {};
    GeoState.emit("navigate-request", { code: p.code_insee || p.code_siren || p.nom_officiel, name: p.nom_officiel || p.nom, level: loc.l.levelDef.level });
  },
  _on_camera(d) {
    if (!d?.center) return;
    this.cam = { center: d.center, zoom: d.zoom, bearing: d.bearing || 0, pitch: d.pitch || 0 };
    clearTimeout(this._camDebounce); this._camDebounce = setTimeout(() => GeoState.emit("camera-settled", this.cam), 250);
    clearTimeout(this._ctxDebounce);
    if (!this._navContext) this._ctxDebounce = setTimeout(() => this._updateContextLayer(), 500);
  },
  _on_error(d) { console.warn("[map-atlas] erreur Atlas:", d?.code, d?.message); if (d?.code === "delai") this._failed = true; },
  // clic sur une ligne du tableau : sélectionne l'objet sur la carte (bulle) et recadre dessus ; échec = message visible
  async _selectFromPanel(idx) {
    const l = [...this._layers.values()].filter((x) => x.kind === "thematic").pop(); const f = l && l.features[idx];
    if (!l || !f || !f.geometry || !this.el) return;
    const jeton = (this._selTok = (this._selTok || 0) + 1);
    try {
      await this.ready;
      await this.el.select(l.base + idx + 1);
      if (jeton !== this._selTok) return;
      const bb = this._bboxDe(f.geometry);
      if (bb) this.fitBbox(bb[0] === bb[2] && bb[1] === bb[3] ? [bb[0] - 0.0008, bb[1] - 0.0006, bb[2] + 0.0008, bb[3] + 0.0006] : bb);
    } catch (e) {
      console.warn("[map-atlas] sélection impossible:", e);
      if (window.GeoBanner) GeoBanner("Sélection sur la carte impossible : " + (e && e.message || e), "erreur");
    }
  },
  _bboxDe(g) {
    if (!g) return null; let x0 = 180, y0 = 90, x1 = -180, y1 = -90, n = 0;
    (function r(c) { if (typeof c[0] === "number") { x0 = Math.min(x0, c[0]); x1 = Math.max(x1, c[0]); y0 = Math.min(y0, c[1]); y1 = Math.max(y1, c[1]); n++; } else c.forEach(r); })(g.coordinates || (g.geometries || []).map((k) => k.coordinates));
    return n ? [x0, y0, x1, y1] : null;
  },
  _hoverFromPanel(idx) {
    const l = [...this._layers.values()].filter((x) => x.kind === "thematic").pop(); if (!l || !this.el) return;
    this.el.highlight(idx == null ? [] : [l.base + idx + 1]).catch(() => {});
  },
  updateLegendCounts() { /* la légende native d'Atlas compte elle-même */ },

  // ── clic dans le vide : mode « Pointer » ────────────────────────
  _buildPick(host) {
    const btn = document.createElement("button");
    btn.id = "map-pick"; btn.className = "map-btn"; btn.type = "button";
    btn.innerHTML = Icon("crosshair", 16) + "<span>Pointer</span>"; btn.title = "Cliquer sur la carte pour naviguer vers ce point";
    const cap = document.createElement("div");
    cap.style.cssText = "position:absolute;inset:0;z-index:4;cursor:crosshair;display:none";
    host.style.position = "relative"; host.append(cap, btn);
    const set = (on) => { this._pickOn = on; cap.style.display = on ? "block" : "none"; btn.classList.toggle("on", on); btn.setAttribute("aria-pressed", on ? "true" : "false"); };
    btn.onclick = () => set(!this._pickOn);
    cap.onclick = (e) => {
      const r = cap.getBoundingClientRect(), p = this._unproject(e.clientX - r.left, e.clientY - r.top, r);
      set(false); GeoState.emit("map-click", { lon: p[0], lat: p[1] });
    };
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && this._pickOn) set(false); });
  },
  _unproject(x, y, r) { // caméra à plat (inclinaison 0, cap 0) : mercator, tuiles de 512 px
    const { center, zoom } = this.cam, scale = 512 * 2 ** zoom;
    const cx = (center[0] + 180) / 360 * scale, s = Math.sin(center[1] * Math.PI / 180);
    const cy = (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale;
    const th = (this.cam.bearing || 0) * Math.PI / 180, dx = x - r.width / 2, dy = y - r.height / 2;
    const px = cx + dx * Math.cos(th) - dy * Math.sin(th), py = cy + dx * Math.sin(th) + dy * Math.cos(th);
    const lon = px / scale * 360 - 180, n = Math.PI - 2 * Math.PI * py / scale;
    return [lon, 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)))];
  },
  _updateBadge(ctx) {
    return; // le fil territorial est rendu par ContextPanel.renderHierarchy
    const badge = document.getElementById("territory-badge");
    if (!ctx.level || !ctx.name) { badge.classList.add("hidden"); return; }
    badge.classList.remove("hidden"); badge.innerHTML = `${ctx.name}<span class="code">${ctx.code}</span>`;
  },
};
window.GeoMap = GeoMap;
