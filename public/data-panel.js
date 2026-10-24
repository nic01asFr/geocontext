/**
 * Panneau de données thématiques : stats, filtres, tableau.
 *
 * RÈGLE : jamais de résultat faux. Le panneau stocke les propriétés en colonnes typées (indices Uint32Array des lignes retenues),
 * applique chaque filtre à la carte (Atlas setFilter) et ne montre le résultat qu'après avoir vérifié que le compte d'Atlas est
 * égal au nombre de lignes retenues ici. Sinon : filtre annulé des deux côtés et message explicite.
 * Une valeur absente est comptée à part (« sans valeur »), jamais comme zéro. Le tableau est fenêtré : aucune ligne n'est écartée.
 * Prédicats alignés sur lib/controls.js d'Atlas : select (sans casse, '' = sans valeur), range (bornes incluses, absent exclu :
 * requireValue), text (sous-chaîne sans casse ni accents).
 */
(function () {
  const ROW_H = 26, VIEW_H = 320, ENUM_MAX = 80;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const norm = (t) => String(t ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const nombreDe = (v) => {
    if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
    if (typeof v !== "string") return NaN;
    const t = v.trim().replace(/\s+/g, "").replace(",", ".");
    if (t === "") return NaN;
    const n = Number(t); return Number.isFinite(n) ? n : NaN;
  };
  const fr = (n, d = 2) => (Number.isInteger(n) ? n.toLocaleString("fr-FR") : n.toLocaleString("fr-FR", { maximumFractionDigits: d }));

  /** Une colonne typée : number (Float64Array + présence), enum (dictionnaire, code 0 = sans valeur), text. */
  function buildColumn(key, feats, force) {
    const n = feats.length;
    let miss = 0, allNum = true, obj = false, over = false, min = Infinity, max = -Infinity;
    const uniq = new Map();
    for (let i = 0; i < n; i++) {
      const f = feats[i], v = (f.properties || f)[key];
      if (v == null || v === "") { miss++; continue; }
      if (typeof v === "object") { obj = true; allNum = false; continue; }
      if (allNum) { const x = nombreDe(v); if (Number.isNaN(x)) allNum = false; else { if (x < min) min = x; if (x > max) max = x; } }
      if (!over) { const s = String(v); uniq.set(s, (uniq.get(s) || 0) + 1); if (uniq.size > ENUM_MAX) over = true; }
    }
    const col = { key, n, miss, filterable: !obj };
    if (miss === n) return { ...col, kind: "vide" };
    if (force !== "number" && !obj && !over && uniq.size <= 1 && miss === 0) return { ...col, kind: "constant", value: [...uniq.keys()][0] };
    if (!obj && allNum && (force === "number" || over || uniq.size > 10)) {
      const vals = new Float64Array(n), pres = new Uint8Array(n);
      for (let i = 0; i < n; i++) { const f = feats[i], x = nombreDe((f.properties || f)[key]); if (!Number.isNaN(x)) { vals[i] = x; pres[i] = 1; } }
      return { ...col, kind: "number", vals, pres, min, max };
    }
    if (!obj && !over) {
      const dict = [...uniq.entries()].sort((a, b) => b[1] - a[1]).map(([k]) => k), code = new Map(dict.map((k, j) => [k, j + 1]));
      const codes = dict.length < 255 ? new Uint8Array(n) : new Uint16Array(n);
      for (let i = 0; i < n; i++) { const f = feats[i], v = (f.properties || f)[key]; codes[i] = v == null || v === "" ? 0 : code.get(String(v)); }
      return { ...col, kind: "enum", dict, codes, counts: dict.map((k) => uniq.get(k)) };
    }
    const arr = new Array(n);
    for (let i = 0; i < n; i++) { const f = feats[i], v = (f.properties || f)[key]; arr[i] = v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v); }
    return { ...col, kind: "text", arr };
  }
  const cell = (c, i) => {
    if (c.kind === "number") return c.pres[i] ? c.vals[i] : null;
    if (c.kind === "enum") { const k = c.codes[i]; return k ? c.dict[k - 1] : null; }
    if (c.kind === "text") return c.arr[i] === "" ? null : c.arr[i];
    return c.kind === "constant" ? c.value : null;
  };
  const fmt = (v) => (v == null ? "—" : typeof v === "number" ? fr(v) : (String(v).length > 60 ? String(v).slice(0, 57) + "…" : esc(v)));

  const STYLE = `.dp-bar{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 8px;font:12px system-ui}
  .dp-bar details{position:relative}.dp-bar summary{cursor:pointer;padding:3px 8px;border:1px solid var(--border,#c5ccd3);border-radius:4px;background:var(--bg-panel,#fff);list-style:none}
  .dp-bar summary.on{border-color:var(--accent,#000091);background:var(--accent-soft,#eef0fb);font-weight:600}
  .dp-ms{position:absolute;z-index:20;max-height:260px;overflow:auto;background:var(--bg-panel,#fff);border:1px solid var(--border,#c5ccd3);border-radius:4px;padding:6px 8px;min-width:200px;box-shadow:0 4px 14px #0003}
  .dp-ms label{display:flex;gap:6px;align-items:center;padding:2px 0;white-space:nowrap}.dp-ms small{color:#667;margin-left:auto;padding-left:10px}
  .dp-bar input[type=number]{width:70px}.dp-bar input[type=text]{width:110px}
  .dp-temps{display:flex;flex-wrap:wrap;gap:6px 10px;align-items:center;padding:6px 8px;font:12px system-ui;border-bottom:1px solid var(--border,#dde2e7)}.dp-t-titre{display:inline-flex;gap:5px;align-items:center}.dp-t-slider{flex:1 1 160px;min-width:120px}.dp-t-val{min-width:90px;font-variant-numeric:tabular-nums;font-weight:600}.dp-t-play{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:1px solid var(--border,#c5ccd3);border-radius:50%;background:var(--bg-panel,#fff);cursor:pointer;color:inherit}.dp-vue{display:flex;flex-wrap:wrap;gap:6px 14px;align-items:center;padding:6px 8px;font:12px system-ui;border-bottom:1px solid var(--border,#dde2e7)}.dp-vue select{font:12px system-ui;padding:2px 4px}.dp-t-note{color:#556;flex-basis:100%}
  .dp-liens{padding:6px 10px;font:12px system-ui;border-bottom:1px solid var(--border,#dde2e7)}.dp-liens-ok{background:#eef7f0}.dp-liens-ko{background:#fdf3dc}.dp-liens ul{margin:4px 0 4px 18px;padding:0}.dp-liens .dp-note{color:#556}
  .dp-chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center;padding:4px 10px 0;font:12px system-ui}
  .dp-chip{display:inline-flex;align-items:center;gap:4px;padding:2px 4px 2px 8px;border:1px solid var(--accent,#000091);border-radius:var(--r-chip,6px);background:var(--accent-soft,#eef0fb)}
  .dp-chip button,.dp-btn{font:12px system-ui;cursor:pointer;border:0;background:none;color:inherit;padding:2px 6px;border-radius:var(--r-chip,6px)}
  .dp-btn{border:1px solid var(--border,#c5ccd3);background:var(--bg-panel,#fff);padding:3px 10px}
  .dp-chip button:hover,.dp-btn:hover{background:var(--accent-soft,#eef0fb)}
  .dp-actions{display:flex;gap:8px;align-items:center;padding:2px 10px 6px;font:12px system-ui}
  .dp-scroll td.num,.dp-scroll th.num{text-align:right;font-variant-numeric:tabular-nums}
  .dp-scroll th:focus-visible,.dp-scroll tr:focus-visible,.dp-btn:focus-visible,.dp-chip button:focus-visible{outline:2px solid var(--accent,#000091);outline-offset:-2px}
  .dp-status{padding:2px 10px 6px;font:12px system-ui;color:#334}.dp-ok{color:#0a6b2d}.dp-ko{color:#b3261e}
  .dp-sanspos{margin:2px 10px 4px;font:12px system-ui;color:#5a6670}.dp-sanspos label{margin-left:8px;white-space:nowrap}.dp-constat-btn,.dp-constat button{font:12px system-ui;margin-left:6px;cursor:pointer}.dp-constat{margin-top:4px}.dp-constat-txt{white-space:pre-wrap;max-height:160px;overflow:auto;background:#f4f6f8;border:1px solid #d5dbe0;border-radius:6px;padding:6px 8px;font:11.5px/1.4 system-ui;margin:0 0 4px}.dp-v-agg{display:inline-flex;flex-wrap:wrap;gap:6px 14px;align-items:center;margin-top:4px}.dp-v-agg label{display:inline-flex;gap:5px;align-items:center}.dp-v-agg button{padding:3px 10px;border:1px solid #9aa7b0;border-radius:4px;background:#fff;font:12px system-ui;cursor:pointer}
  .dp-alert{margin:6px 8px;padding:8px 10px;border:1px solid #b3261e;border-radius:4px;background:#fdecea;color:#5c1410;font:13px system-ui}
  .dp-scroll{max-height:clamp(200px,38vh,560px);overflow:auto;margin:0 8px 8px;border:1px solid var(--border,#dde2e7);border-radius:var(--r-ctl,8px)}
  .dp-scroll table{border-collapse:separate;border-spacing:0;width:100%}.dp-scroll th{position:sticky;top:0;background:var(--bg-subtle,#f4f6f8);z-index:2;cursor:pointer;white-space:nowrap}
  .dp-scroll td{height:${ROW_H}px;box-sizing:border-box;max-width:240px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 8px}`;

  const DataPanel = {
    _cols: {}, _fields: [], _n: 0, _idx: null, _order: null, _state: {}, _committed: {}, _dirty: new Set(), _busy: false,
    _sortKey: null, _sortAsc: true, _meta: {}, _sourceId: null, _verified: null, _idxAttr: null, _zoneOn: false, _zone: null, _bbf: null,

    init() { if (window.GeoState) GeoState.on("camera-settled", () => this._majZone()); document.getElementById("data-close").addEventListener("click", () => this.hide()); this._initEpingles(); },
    show() { const p = document.getElementById("data-panel"); p.classList.remove("hidden", "collapsed"); },
    hide() { document.getElementById("data-panel").classList.add("hidden"); },

    /** Bandeau d'erreur : une couche n'a pas pu être chargée en entier, elle n'est donc pas affichée (aucun résultat partiel). */
    showErrors(echecs, retry) {
      const el = document.getElementById("data-content");
      const box = document.createElement("div"); box.className = "data-error dp-alert";
      box.innerHTML = "<b>Chargement incomplet : couche non affichée.</b> Aucun résultat partiel n'est montré.<ul style='margin:6px 0 8px 18px;padding:0'>" +
        echecs.map((e) => `<li>${esc(e.label)} : ${esc(e.error)}</li>`).join("") + "</ul>";
      const b = document.createElement("button"); b.textContent = "Réessayer"; b.style.cssText = "padding:4px 12px;cursor:pointer";
      b.onclick = () => { b.disabled = true; b.textContent = "Nouvelle tentative…"; retry(); };
      box.appendChild(b); el.prepend(box); this.show();
    },
    showLoading(title) {
      this._sauverEpingle(); this._sourceId = null; this._majEpingles();
      document.getElementById("data-title").textContent = this._titre(title) || "Chargement…";
      document.getElementById("data-content").innerHTML = '<div style="text-align:center;padding:24px"><span class="loading-spinner"></span></div>';
      this.show();
    },

    /** Titre lisible : libellé du thème ou de l'action plutôt que son identifiant. */
    _titre(t) {
      if (!t) return t;
      const th = (GeoState.context.themes || []).find((x) => x.id === t);
      if (th) return th.label;
      return typeof libelleAction === "function" ? libelleAction(t) : t;
    },

    render(title, textResult, features, meta) {
      this._sauverEpingle(); this._action = title;
      document.getElementById("data-title").textContent = this._titre(title);
      if (!features || features.length === 0) {
        this._sourceId = null; this._majEpingles();
        document.getElementById("data-content").innerHTML = typeof textResult === "string" ? this._renderText(textResult) : `<pre style="font-size:11px">${esc(JSON.stringify(textResult, null, 2))}</pre>`;
        this.show(); return;
      }
      this._meta = meta || {}; this._sourceId = meta?.sourceId || null; this._n = features.length; this._features = features;
      this._geo = features.map((f) => !!f.geometry); this._nCarte = this._geo.reduce((a, x) => a + (x ? 1 : 0), 0);
      this._state = {}; this._committed = {}; this._dirty = new Set(); this._sortKey = null; this._order = null; this._verified = null;
      this._fields = this._resolveFields(features);
      this._cols = {}; for (const f of this._fields) this._cols[f.key] = buildColumn(f.key, features, f.derivee ? "number" : null);
      this._fields = this._fields.filter((f) => !["vide", "constant"].includes(this._cols[f.key].kind));
      this._idx = Uint32Array.from({ length: this._n }, (_, i) => i); this._idxAttr = this._idx; this._zoneOn = false; this._zone = null; this._bbf = null;
      const controls = this._fields.filter((f) => this._cols[f.key].filterable).map((f) => this._control(f));
      if (window.GeoMap?.setFilterControls && this._sourceId) GeoMap.setFilterControls(this._sourceId, controls);
      this._build(); this.show();
      this._checkMap(controls[0]);
      this._majEpingles();
    },

    // ── épingles : des couches qui restent sur la carte pendant qu'on en charge d'autres ───────────────
    // Une épingle conserve la couche sur la carte (GeoMap.epingler) ET l'état du panneau (filtres, représentation, tri) ; la carte garde de son côté
    // les filtres, la coloration et la forme. Réactiver une épingle rejoue l'état du panneau puis le fait vérifier par le contrôle tableau = carte habituel.
    _pins: [],
    _initEpingles() {
      const h = document.getElementById("data-header"); if (!h || document.getElementById("data-pin")) return;
      const titre = h.querySelector("h3"), close = document.getElementById("data-close");
      // à gauche, ce qui concerne LA COUCHE (titre, punaise, onglets) ; à droite, ce qui concerne le PANNEAU (replier, fermer)
      const b = document.createElement("button"); b.id = "data-pin"; b.type = "button"; b.hidden = true;
      b.addEventListener("click", () => this._basculerEpingle()); titre.after(b);
      const s = document.createElement("div"); s.id = "data-pins"; s.className = "dp-pins"; s.hidden = true; b.after(s);
      const c = document.createElement("button"); c.id = "data-collapse"; c.type = "button"; c.innerHTML = Icon("chevron-down", 16);
      c.setAttribute("aria-label", "Replier / déplier le tableau"); c.title = "Replier / déplier le tableau"; c.addEventListener("click", () => titre.click()); h.insertBefore(c, close);
    },
    _SEL_VUE: "select,input:not(.dp-v-env-r):not(.dp-v-env-s)", // l'environnement (relief, soleil) est global à la carte, pas à la couche
    _instantane() {
      const box = this._el?.querySelector(".dp-vue");
      return { champs: box && !box.hidden ? [...box.querySelectorAll(this._SEL_VUE)].map((x) => (x.type === "checkbox" ? x.checked : x.value)) : null,
        note: box?.querySelector(".dp-v-note")?.innerHTML || "", ech: box?.querySelector(".dp-v-ech")?.hidden ?? true, agg: box?.querySelector(".dp-v-agg")?.hidden ?? true,
        incl: box?.querySelector(".dp-v-incl")?.dataset.incline || "0", vue: { ...(this._vue || {}) }, committed: JSON.parse(JSON.stringify(this._committed || {})) };
    },
    _sauverEpingle() {
      const p = this._sourceId && this._pins.find((x) => x.id === this._sourceId);
      if (p && this._features === p.features) p.inst = this._instantane();
    },
    _majEpingles() {
      const b = document.getElementById("data-pin"), s = document.getElementById("data-pins"); if (!b || !s) return;
      const actif = this._pins.find((x) => x.id === this._sourceId), peut = !!this._sourceId && !!this._features?.length;
      b.hidden = !peut; b.setAttribute("aria-pressed", String(!!actif));
      if (!b.firstChild) b.innerHTML = Icon("pin", 16);
      b.setAttribute("aria-label", actif ? "Désépingler cette couche" : "Épingler cette couche");
      b.title = actif ? "Désépingler : la couche reste sur la carte jusqu'à la prochaine action ; elle ne sera plus conservée ensuite." : "Garder cette couche sur la carte quand on en charge une autre.";
      s.hidden = !this._pins.length; s.innerHTML = "";
      for (const p of this._pins) {
        const w = document.createElement("span"); w.className = "dp-pin" + (p.id === this._sourceId ? " on" : "");
        const a = document.createElement("button"); a.type = "button"; a.textContent = `${this._titre(p.titre)} · ${p.features.length.toLocaleString("fr-FR")}`; a.setAttribute("aria-pressed", String(p.id === this._sourceId));
        a.title = "Afficher cette couche dans le panneau (remplace la vue non épinglée)"; a.addEventListener("click", () => this._activerEpingle(p));
        const x = document.createElement("button"); x.type = "button"; x.className = "dp-pin-x"; x.textContent = "×"; x.title = "Retirer cette couche de la carte"; x.setAttribute("aria-label", "Retirer " + this._titre(p.titre) + " de la carte");
        x.addEventListener("click", () => this._retirerEpingle(p)); w.append(a, x); s.appendChild(w);
      }
    },
    _basculerEpingle() {
      if (!this._sourceId || !this._features?.length) return;
      const p = this._pins.find((x) => x.id === this._sourceId);
      if (p) { this._pins = this._pins.filter((x) => x !== p); GeoMap.desepingler(p.layerIds); }
      else {
        const ids = this._meta.layerIds?.length ? this._meta.layerIds : [this._sourceId];
        this._pins.push({ id: this._sourceId, action: this._meta.action || null, titre: this._action || this._meta.action || this._sourceId, texte: "", features: this._features, meta: this._meta, layerIds: ids, inst: this._instantane() });
        GeoMap.epingler(ids);
      }
      this._majEpingles();
    },
    _retirerEpingle(p) {
      this._pins = this._pins.filter((x) => x !== p);
      for (const i of p.layerIds) GeoMap.removeLayer(i);
      if (p.id === this._sourceId) { this._sourceId = null; this._features = null; this.hide(); }
      this._majEpingles();
    },
    /** Relancer une action déjà épinglée la recharge : l'ancienne épingle (données périmées) est retirée, carte comprise. */
    retirerEpingle(action) { const p = this._pins.find((x) => x.action === action); if (p) this._retirerEpingle(p); },
    reinitEpingles() { this._pins = []; this._majEpingles(); },
    async _activerEpingle(p) {
      if (p.id === this._sourceId && this._features === p.features) return;
      this._sauverEpingle();
      GeoMap.clearLayers(); // la vue non épinglée qu'on remplace quitte la carte ; les couches épinglées restent
      this.render(p.titre, p.texte, p.features, p.meta);
      document.getElementById("data-title").textContent = this._titre(p.titre);
      await this._restaurer(p);
    },
    /** Rejoue dans le panneau ce qui était réglé : représentation (listes, notes) puis filtres, ceux-ci repassant par le contrôle tableau = carte. */
    async _restaurer(p) {
      const s = p.inst; if (!s) return;
      const box = this._el.querySelector(".dp-vue");
      if (s.champs && box && !box.hidden) {
        const xs = [...box.querySelectorAll(this._SEL_VUE)];
        if (xs.length === s.champs.length) {
          xs.forEach((x, i) => { if (x.type === "checkbox") x.checked = !!s.champs[i]; else x.value = s.champs[i]; });
          const e = box.querySelector(".dp-v-ech"), g = box.querySelector(".dp-v-agg"), n = box.querySelector(".dp-v-note"), bi = box.querySelector(".dp-v-incl");
          if (e) e.hidden = s.ech; if (g) g.hidden = s.agg; if (n) n.innerHTML = s.note;
          if (bi) { bi.dataset.incline = s.incl; bi.textContent = s.incl === "1" ? "Remettre à plat" : "Incliner la carte"; }
          this._vue = { ...s.vue };
        } else this._alert("<b>Réglages de représentation non restaurés</b> (le panneau a changé de structure) : la carte garde ceux de la couche, ne pas se fier aux listes ci-dessus.");
      }
      const ks = Object.keys(s.committed || {});
      if (ks.length) {
        await GeoMap._settled?.();
        this._state = JSON.parse(JSON.stringify(s.committed)); for (const k of ks) this._dirty.add(k);
        this._restoreUi(); await this._drain();
      }
      this._majEpingles();
    },

    _ctl(key) { return `${this._sourceId}__${key}`.replace(/[^A-Za-z0-9_]/g, "_"); },
    _control(f) {
      const c = this._cols[f.key];
      return { id: this._ctl(f.key), field: f.key, label: f.label || this._formatHeader(f.key), type: c.kind === "number" ? "range" : c.kind === "enum" ? "select" : "text", ...(c.kind === "number" ? { requireValue: true } : {}) };
    },
    _resolveFields(features) {
      if (this._meta.fields?.length > 0) return this._meta.fields.filter((f) => f.type !== "geometry");
      const excluded = new Set(["geometry", "bbox", "id", "gml_id", "fid"]), keys = new Set();
      for (const f of features.slice(0, 50)) for (const k of Object.keys(f.properties || f)) if (!excluded.has(k)) keys.add(k);
      return [...keys].slice(0, 12).map((k) => ({ key: k, label: this._formatHeader(k) }));
    },

    // ── construction ────────────────────────────────────────────
    _build() {
      const el = document.getElementById("data-content");
      el.innerHTML = `<style>${STYLE}</style><div class="dp-alert" hidden></div><div class="dp-sanspos" hidden></div><div class="dp-stats"></div><div class="dp-liens" hidden></div><div class="dp-vue" hidden></div><div class="dp-temps" hidden></div><div class="dp-bar"></div><div class="dp-chips" hidden></div><div class="dp-status"></div><div class="dp-actions"></div>
        <div class="dp-scroll"><table class="data-table"><thead><tr></tr></thead><tbody></tbody></table></div>`;
      this._el = el;
      const bar = el.querySelector(".dp-bar");
      const lab = {}; for (const fl of this._meta.filters || []) if (fl.type === "enum" && fl.values) lab[fl.key] = fl.values;
      for (const f of this._fields) {
        const c = this._cols[f.key]; if (!c.filterable) continue;
        const title = esc(f.label || this._formatHeader(f.key));
        if (c.kind === "enum") {
          const d = document.createElement("details");
          const rows = c.dict.map((v, j) => `<label><input type="checkbox" data-v="${esc(v)}"> ${esc(lab[f.key]?.[v] ?? v)}<small>${c.counts[j].toLocaleString("fr-FR")}</small></label>`);
          if (c.miss) rows.push(`<label><input type="checkbox" data-v=""> (sans valeur)<small>${c.miss.toLocaleString("fr-FR")}</small></label>`);
          d.innerHTML = `<summary>${title} ▾</summary><div class="dp-ms">${rows.join("")}</div>`;
          d.addEventListener("change", () => {
            const vals = [...d.querySelectorAll("input:checked")].map((i) => i.dataset.v);
            d.querySelector("summary").classList.toggle("on", vals.length > 0);
            this._set(f.key, vals.length ? { values: vals } : null);
          });
          bar.appendChild(d);
        } else if (c.kind === "number") {
          const w = document.createElement("span");
          w.innerHTML = `${title} <input type="number" placeholder="${fr(c.min)}" data-r="min"> – <input type="number" placeholder="${fr(c.max)}" data-r="max">`;
          let t; w.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => {
            const g = (r) => { const v = w.querySelector(`[data-r=${r}]`).value.trim(); return v === "" ? null : Number(v); };
            const min = g("min"), max = g("max"); this._set(f.key, min == null && max == null ? null : { min, max });
          }, 300); });
          bar.appendChild(w);
        } else {
          const w = document.createElement("span"); w.innerHTML = `${title} <input type="text" placeholder="⌕">`;
          let t; w.addEventListener("input", () => { clearTimeout(t); t = setTimeout(() => { const q = w.querySelector("input").value.trim(); this._set(f.key, q ? { texte: q } : null); }, 300); });
          bar.appendChild(w);
        }
      }
      this._buildLiens();
      this._sansPos();
      this._buildVue();
      this._buildTemps();
      const tr = el.querySelector("thead tr");
      tr.innerHTML = this._fields.map((f) => `<th data-key="${esc(f.key)}" tabindex="0" role="columnheader" aria-sort="none"${this._cols[f.key].kind === "number" ? ' class="num"' : ""}>${esc(f.label || this._formatHeader(f.key))}${f.unit ? ` <small>(${esc(f.unit)})</small>` : ""}</th>`).join("");
      const trier = (e) => {
        const th = e.target.closest("th"); if (!th) return;
        const k = th.dataset.key; if (this._sortKey === k) this._sortAsc = !this._sortAsc; else { this._sortKey = k; this._sortAsc = true; }
        this._order = null; this._paintTable(true);
      };
      tr.addEventListener("click", trier);
      tr.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); trier(e); } });
      const sc = el.querySelector(".dp-scroll"); let raf = 0;
      sc.addEventListener("scroll", () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => this._paintRows()); });
      el.querySelector("tbody").addEventListener("mouseover", (e) => { const r = e.target.closest("tr[data-i]"); if (r) GeoState.emit("feature-hover", Number(r.dataset.i)); });
      el.querySelector("tbody").addEventListener("mouseleave", () => GeoState.emit("feature-hover", null));
      el.querySelector("tbody").addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; const r = e.target.closest("tr[data-i]"); if (!r) return; e.preventDefault(); const i = Number(r.dataset.i); this._selIdx = i; this._paintRows(); GeoState.emit("feature-select", i); });
      el.addEventListener("click", (e) => { if (e.target.closest(".dp-clear-all")) this._effacerTout(); const d = e.target.closest(".dist-clic"); if (d) this._basculerCategorie(d.dataset.k, d.dataset.v); });
      el.addEventListener("keydown", (e) => { if (e.key !== "Enter" && e.key !== " ") return; const d = e.target.closest(".dist-clic"); if (d) { e.preventDefault(); this._basculerCategorie(d.dataset.k, d.dataset.v); } });
      el.querySelector("tbody").addEventListener("click", (e) => { const r = e.target.closest("tr[data-i]"); if (!r) return; const i = Number(r.dataset.i); this._selIdx = i; this._paintRows(); GeoState.emit("feature-select", i); });
      this._paintAll();
    },

    // ── représentation (une seule vue du contexte : mêmes données, filtres et comptes que le tableau) ──
    /** Classes par quantiles décidées ICI (règle [borne basse ; borne haute[ ; la dernière inclut le max) ; chaque ligne reçoit le nom de sa classe dans « <champ>__classe ». */
    /** Échelles séquentielles (du plus bas au plus haut) ; la couleur de la classe i est interpolée entre les repères de la palette choisie. */
    _PALETTES: { bleus: ["#e6f0f5", "#b4d3e1", "#77abc6", "#3c7fa3", "#12607c"], viridis: ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"], chaud: ["#ffffb2", "#fecc5c", "#fd8d3c", "#f03b20", "#bd0026"], verts: ["#edf8e9", "#bae4b3", "#74c476", "#31a354", "#006d2c"], gris: ["#f0f0f0", "#bdbdbd", "#636363", "#252525"] },
    _echelle(nom, n) {
      const st = this._PALETTES[nom] || this._PALETTES.bleus, h = (x) => [1, 3, 5].map((j) => parseInt(x.slice(j, j + 2), 16));
      return (i) => { const t = n === 1 ? 1 : i / (n - 1), f = t * (st.length - 1), a = Math.min(st.length - 2, Math.floor(f)), u = f - a, A = h(st[a]), B = h(st[a + 1]);
        return "#" + A.map((v, j) => Math.round(v + (B[j] - v) * u).toString(16).padStart(2, "0")).join(""); };
    },
    _classes(key, k, ecrire, palNom) {
      const c = this._cols[key], v = []; for (let i = 0; i < this._n; i++) if (c.pres[i]) v.push(c.vals[i]);
      v.sort((x, y) => x - y); if (v.length < 2 || v[0] === v[v.length - 1]) return null;
      const q = (p) => v[Math.min(v.length - 1, Math.floor(p * v.length))];
      const b = [v[0]]; for (let i = 1; i < k; i++) { const x = q(i / k); if (x > b[b.length - 1]) b.push(x); }
      b.push(v[v.length - 1]);
      const n = b.length - 1, col = this._echelle(palNom, n);
      const noms = [], categories = [];
      for (let i = 0; i < n; i++) {
        const lo = b[i], hi = b[i + 1], dernier = i === n - 1;
        const nom = i === 0 ? `moins de ${fr(hi)}` : dernier ? `${fr(lo)} et plus` : `de ${fr(lo)} à moins de ${fr(hi)}`;
        noms.push(nom); categories.push({ value: nom, label: nom, color: col(i) });
      }
      categories.push({ value: "(sans valeur)", label: "(sans valeur)", color: "#9aa3a8" });
      const classeDe = (x) => { for (let i = n - 1; i >= 1; i--) if (x >= b[i]) return noms[i]; return noms[0]; };
      if (ecrire) for (let i = 0; i < this._n; i++) { const f = this._features[i], p = f.properties || (f.properties = {}); p[key + "__classe"] = c.pres[i] ? classeDe(c.vals[i]) : "(sans valeur)"; }
      return { champ: key + "__classe", categories, noms: [...noms, "(sans valeur)"], classeDe };
    },
    /** Bandeau du lien par références (IRIS IGN → INSEE) : appariement, contrôle de cohérence, erreurs. Jamais de succès silencieux. */
    _buildLiens() {
      const box = this._el.querySelector(".dp-liens"), L = this._meta.liens;
      if (!box || !L) return;
      const nf = (n) => Number(n).toLocaleString("fr-FR");
      const ecarts = L.controles.filter((c) => c.verdict !== "coherent");
      const ok = !L.erreurs.length && !L.sans.length && !ecarts.length && L.controles.length > 0;
      const lignes = [];
      if (L.erreurs.length) lignes.push(`<b>Indicateurs INSEE non joints.</b><ul>${L.erreurs.map((e) => `<li>${esc(e)}</li>`).join("")}</ul>`);
      if (L.iris) {
        lignes.push(`<b>Indicateurs INSEE joints</b> (recensement${L.annee ? " " + L.annee : ""}, API Melodi) : ${nf(L.avec)} IRIS sur ${nf(L.iris)} appariés par code IRIS.`);
        const c = L.controles;
        if (c.length) {
          const somme = c.reduce((n, x) => n + x.somme_iris, 0), total = c.reduce((n, x) => n + x.total_commune, 0);
          lignes.push(ecarts.length
            ? `Contrôle de population : <b>écart</b> — somme des IRIS ${nf(somme)} pour ${nf(total)} habitants au total communal (${ecarts.map((x) => `${x.commune} : ${x.ecart_pct} %`).join(", ")}).`
            : `Contrôle de population : somme des IRIS ${nf(somme)} = total communal ${nf(total)} ✓`);
        }
        if (L.sans.length) lignes.push(`<details><summary><b>${L.sans.length} IRIS sans donnée INSEE</b> (laissés vides, jamais mis à zéro)</summary><ul>${L.sans.map((s) => `<li>${esc(s.nom_iris || s.code_iris)} (${esc(s.code_iris)}, type ${esc(s.type_iris)})</li>`).join("")}</ul><small>Cause non déterminée : IRIS absent du millésime de l'INSEE, non diffusé ou code différent.</small></details>`);
        lignes.push('<small class="dp-note">Effectifs estimés par l\'INSEE, arrondis à l\'unité ; parts calculées sur les valeurs non arrondies.</small>');
      }
      box.className = "dp-liens " + (ok ? "dp-liens-ok" : "dp-liens-ko");
      box.innerHTML = lignes.join("<br>");
      if (L.erreurs.length && !L.definitif && typeof this._meta.retryLiens === "function") {
        const b = document.createElement("button"); b.textContent = "Réessayer"; b.style.cssText = "margin-top:4px;padding:3px 10px;cursor:pointer";
        b.onclick = () => { b.disabled = true; b.textContent = "Nouvelle tentative…"; this._meta.retryLiens(); };
        box.appendChild(b);
      }
      box.hidden = false;
    },
    _buildVue() {
      const box = this._el.querySelector(".dp-vue"); this._vue = { champ: null }; box.innerHTML = ""; box.hidden = true;
      if (!window.GeoMap?.colorerPar || !this._sourceId) return;
      const nums = this._fields.filter((f) => this._cols[f.key]?.kind === "number" && !f.derivee && this._classes(f.key, 5));
      const geom = GeoMap.geomDe?.(this._sourceId), points = geom === "point";
      if (!nums.length && !points) return;
      box.hidden = false;
      let h = `<span class="dp-t-titre">${Icon("layers", 14)} Représentation</span>`;
      if (nums.length) h += `<label>Colorier par <select class="dp-v-champ"><option value="">catégories d'origine</option>${nums.map((f) => `<option value="${esc(f.key)}">${esc(f.label || this._formatHeader(f.key))} (par classes)</option>`).join("")}</select></label>`;
      if (nums.length || points) h += `<label>Palette <select class="dp-v-pal"><option value="">charte (défaut)</option><option value="bleus">bleus</option><option value="viridis">viridis (lisible daltoniens)</option><option value="chaud">jaune-rouge</option><option value="verts">verts</option><option value="gris">gris</option></select></label>${nums.length ? `<span class="dp-v-ech" hidden><label>Classes <select class="dp-v-k">${[3, 4, 5, 6, 7].map((x) => `<option${x === 5 ? " selected" : ""}>${x}</option>`).join("")}</select></label></span>` : ""}`;
      if (points) h += `<label>Forme <select class="dp-v-forme"><option value="">symboles</option><option value="proportionnel">cercles proportionnels</option><option value="heat">chaleur</option><option value="hex">hexagones</option><option value="grille">grille</option></select></label>${nums.length ? `<label class="dp-v-lib">Champ <select class="dp-v-champ2">${nums.map((f) => `<option value="${esc(f.key)}">${esc(f.label || this._formatHeader(f.key))}</option>`).join("")}</select></label>` : ""}`;
      if (points) h += `<span class="dp-v-agg" hidden><label>Valeur <select class="dp-v-metr"><option value="n">nombre de points</option>${nums.map((f) => `${f.aggregate === "sum" ? `<option value="somme:${esc(f.key)}">somme de ${esc(f.label || this._formatHeader(f.key))}</option>` : ""}<option value="moyenne:${esc(f.key)}">moyenne de ${esc(f.label || this._formatHeader(f.key))}</option>`).join("")}</select></label><label>Maille <select class="dp-v-taille"><option>75</option><option selected>150</option><option>300</option><option>600</option></select> m</label><label><input type="checkbox" class="dp-v-relief"> relief 3D</label><button type="button" class="dp-v-incl" hidden>Incliner la carte</button></span>`;
      h += `<span class="dp-v-env"><label><input type="checkbox" class="dp-v-env-r"> relief du terrain</label><label><input type="checkbox" class="dp-v-env-s"> soleil (heure actuelle)</label></span><small class="dp-t-note dp-v-note"></small>`;
      box.innerHTML = h;
      const note = box.querySelector(".dp-v-note");
      const dire = (m, ko) => { note.innerHTML = m ? (ko ? `<span class="dp-ko">${m}</span>` : m) : ""; };
      const ch = box.querySelector(".dp-v-champ");
      if (ch) ch.addEventListener("change", async () => {
        const key = ch.value, kk = Number(box.querySelector(".dp-v-k").value) || 5, pn = box.querySelector(".dp-v-pal").value; box.querySelector(".dp-v-ech").hidden = !key; dire("Application sur la carte…");
        try {
          if (!key) { await GeoMap.colorerPar(this._sourceId, null); this._vue.champ = null; dire("Catégories d'origine rétablies."); this._publier?.(); return; }
          const cl = this._classes(key, kk, true, pn), c = this._cols[key];
          const g = await GeoMap.colorerPar(this._sourceId, { champ: cl.champ, categories: cl.categories });
          // attendu : comptes de la sélection COURANTE calculés ici ; lus : comptes de la légende d'Atlas, classe par classe
          const att = new Map(cl.noms.map((x) => [x, 0]));
          for (let t = 0; t < this._idxAttr.length; t++) { const i = this._idxAttr[t]; if (!this._geo[i]) continue; att.set(c.pres[i] ? cl.classeDe(c.vals[i]) : "(sans valeur)", (att.get(c.pres[i] ? cl.classeDe(c.vals[i]) : "(sans valeur)") || 0) + 1); }
          const lu = new Map((g?.classes || []).map((x) => [x.libelle, x.compte]));
          const ecarts = [...att.entries()].filter(([nom, m]) => (lu.get(nom) ?? 0) !== m);
          if (ecarts.length) { await GeoMap.colorerPar(this._sourceId, null); ch.value = ""; this._vue.champ = null;
            dire(`Coloration annulée : la carte et le tableau ne comptent pas pareil (${ecarts.map(([nom, m]) => `« ${esc(nom)} » : tableau ${m}, carte ${lu.get(nom) ?? 0}`).join(" ; ")}). Style d'origine rétabli.`, true); return; }
          this._vue.champ = key; this._publier?.();
          const manque = this._n - c.pres.reduce((a, x) => a + x, 0);
          dire(`${cl.noms.length - 1} classes par quantiles (palette ${esc(pn || "bleus")}) sur « ${esc(key)} » — comptes carte = comptes tableau.${manque ? ` ${manque.toLocaleString("fr-FR")} élément(s) sans valeur : classe grise « (sans valeur) », jamais rangés dans une classe.` : ""}`);
        } catch (e) { try { await GeoMap.colorerPar(this._sourceId, null); } catch {} ch.value = ""; this._vue.champ = null; dire(`Coloration impossible : ${esc(e.message || e)}. Style d'origine rétabli.`, true); }
      });
      for (const sel of box.querySelectorAll(".dp-v-k,.dp-v-pal")) sel.addEventListener("change", async () => {
        if (sel.classList.contains("dp-v-pal")) { // même palette pour les classes ET pour la rampe de la chaleur / hexagones / grille
          const pn = sel.value, f = this._echelle(pn, 9); 
          try { await GeoMap.setRampe(this._sourceId, pn ? Array.from({ length: 9 }, (_, i) => f(i)) : null); }
          catch (e) { dire(`Palette non appliquée à la chaleur / hexagones / grille de cette couche : ${esc(e.message || e)}`, true); }
        }
        if (ch && ch.value) ch.dispatchEvent(new Event("change"));
      });
      { const e0 = GeoMap._env || {}; box.querySelector(".dp-v-env-r").checked = !!e0.relief; box.querySelector(".dp-v-env-s").checked = !!e0.soleil; }
      const majEnv = () => { const env = {}; if (box.querySelector(".dp-v-env-r").checked) env.relief = true; if (box.querySelector(".dp-v-env-s").checked) env.soleil = { maintenant: true }; GeoMap.setEnvironnement(env); dire(Object.keys(env).length ? "Environnement appliqué (incliner la carte pour voir le relief ; le relief est celui du monde entier, le soleil donne la direction de la lumière sans ombres portées)." : "Environnement retiré."); };
      for (const c of box.querySelectorAll(".dp-v-env input")) c.addEventListener("change", majEnv);
      const fo = box.querySelector(".dp-v-forme"), agg = box.querySelector(".dp-v-agg");
      const appliquer = async () => {
        const t = fo.value, champ = (box.querySelector(".dp-v-champ2") || {}).value;
        if (agg) agg.hidden = !(t === "hex" || t === "grille");
        if (t === "proportionnel" && !champ) { dire("Choisir un champ numérique pour des cercles proportionnels.", true); fo.value = ""; return; }
        const c = champ && this._cols[champ];
        let visuel, agr = null;
        if (!t) visuel = { type: "cercles"};
        else if (t === "proportionnel") visuel = { type: "proportionnel", champ, min: c.min, max: c.max, rMin: 3, rMax: 22 };
        else if (t === "heat") visuel = { type: "heat", rayon: 0.3, opacite: 0.85 };
        else { agr = this._reglageAgg(box); visuel = { type: t, ...agr.spec } } // forme PLATE : Atlas ignore sans erreur { hex: {...} } et prend sa maille par défaut (600 m)
        try {
          await GeoMap.formeVisuelle(this._sourceId, t ? visuel : null); this._vue.forme = t || null; this._publier?.();
          if (!t) { dire("Symboles rétablis."); return; }
          if (t === "proportionnel") { dire(`Cercles proportionnels à « ${esc(champ)} » (de ${fr(c.min)} à ${fr(c.max)}).${c.miss ? ` ${c.miss.toLocaleString("fr-FR")} élément(s) sans valeur : leur tracé n’est pas vérifié.` : ""}`); return; }
          if (t === "heat") { dire("Chaleur : densité de points, non pondérée (pas d'échelle chiffrée)."); return; }
          await this._noteAgg(box, dire, t, agr);
        } catch (e) { fo.value = ""; if (agg) agg.hidden = true; dire(`Représentation refusée : ${esc(e.message || e)}. Symboles conservés.`, true); }
      };
      if (fo) fo.addEventListener("change", appliquer);
      if (agg) {
        agg.querySelectorAll("select,input").forEach((x) => x.addEventListener("change", appliquer));
        const bi = agg.querySelector(".dp-v-incl");
        bi.addEventListener("click", async () => {
          const plat = bi.dataset.incline === "1";
          try { await GeoMap.incliner(plat ? 0 : 60, plat ? 0 : -20); bi.dataset.incline = plat ? "0" : "1"; bi.textContent = plat ? "Incliner la carte" : "Remettre à plat"; }
          catch (e) { dire(`Inclinaison impossible : ${esc(e.message || e)}.`, true); }
        });
      }
    },
    /** Réglages hex/grille lus dans le panneau → spec Atlas ; la valeur « somme/moyenne » exige un champ numérique. */
    _reglageAgg(box) {
      const m = box.querySelector(".dp-v-metr").value, taille = Number(box.querySelector(".dp-v-taille").value), relief = box.querySelector(".dp-v-relief").checked;
      const [metrique, champ] = m === "n" ? ["n", null] : m.split(":");
      const spec = { taille, metrique, ...(champ ? { champ } : {}), ...(relief ? { extrusion: true, hauteurMax: 400 } : {}) };
      return { spec, taille, metrique, champ, relief };
    },
    /** Relit l'agrégat sur la carte et le dit : cases, maximum courant (la hauteur est relative à la vue filtrée), valeurs manquantes. */
    async _noteAgg(box, dire, t, agr) {
      t = t || box.querySelector(".dp-v-forme").value; agr = agr || this._reglageAgg(box);
      const bi = box.querySelector(".dp-v-incl"); bi.hidden = !agr.relief;
      if (!agr.relief) { bi.dataset.incline = "0"; bi.textContent = "Incliner la carte"; }
      const g = await GeoMap.agregat(this._sourceId);
      if (!g) { dire("La carte n'a pas renvoyé d'agrégat : ne pas se fier à cette représentation.", true); return; }
      const nom = t === "hex" ? "Hexagones" : "Grille", c = agr.champ && this._cols[agr.champ];
      const quoi = agr.metrique === "n" ? "nombre de points" : `${agr.metrique} de « ${esc(agr.champ)} »`;
      const max = agr.metrique === "n" ? g.nMax : g.valeurMax;
      const seuils = Array.isArray(g.seuils) ? ` Seuils des 5 classes : ${g.seuils.map((x) => fr(x)).join(" · ")}.` : "";
      const manque = c && c.miss ? ` ${c.miss.toLocaleString("fr-FR")} élément(s) sans valeur ne comptent pas dans cette valeur.` : "";
      const rel = agr.relief ? ` Relief : hauteur proportionnelle à la valeur, rapportée au maximum de la vue filtrée (${fr(max)}) — elle change quand on filtre ; incliner la carte pour la voir.` : "";
      dire(`${nom} de ${agr.taille} m : ${quoi}, ${g.cases} cellules, maximum ${fr(max)}.${seuils}${manque}${rel}`);
    },

    // ── axe temporel ────────────────────────────────────────────
    /** Un seul axe : le premier champ d'année dérivé d'une date (cf. geo-fetcher._deriverAnnees). Le temps est un FILTRE numérique ordinaire (carte, tableau, agent le voient). */
    _buildTemps() {
      const box = this._el.querySelector(".dp-temps"); this._temps = null; this._stopTemps();
      const fr = (n) => Number(n).toLocaleString("fr-FR");
      const tous = this._fields.filter((x) => x.derivee === "temps" && this._cols[x.key]?.kind === "number");
      // un intervalle (début + fin) prime sur les deux champs pris isolément ; il se joue dès que l'ensemble des deux champs s'étale dans le temps
      const deb = tous.find((x) => { const y = tous.find((z) => z.key === x.avec); return x.intervalle === "debut" && y && Math.max(this._cols[x.key].max, this._cols[y.key].max) > Math.min(this._cols[x.key].min, this._cols[y.key].min); });
      const cand = deb ? [deb, tous.find((z) => z.key === deb.avec)] : tous.filter((x) => !x.intervalle && this._cols[x.key].max > this._cols[x.key].min);
      const f = deb || cand[0];
      if (!f) { box.hidden = true; box.innerHTML = ""; return; }
      const fin = deb ? cand.find((y) => y.key === deb.avec) : null;
      const cols = [this._cols[f.key], ...(fin ? [this._cols[fin.key]] : [])];
      const lo = Math.min(...cols.map((c) => c.min)), hi = Math.max(...cols.map((c) => c.max)), pas = f.pas;
      // positions jouables : toutes les périodes de lo à hi, une par pas (jamais de code impossible comme 202313)
      const pos = []; let y = Math.floor(pas === "annee" ? lo : pas === "mois" ? lo / 100 : lo / 10000), mo = pas === "mois" ? lo % 100 : pas === "jour" ? Math.floor(lo / 100) % 100 : 1, d = pas === "jour" ? lo % 100 : 1;
      const code = () => (pas === "annee" ? y : pas === "mois" ? y * 100 + mo : y * 10000 + mo * 100 + d);
      for (let g = 0; g < 20000; g++) { const c = code(); if (c > hi) break; pos.push(c); if (pas === "annee") y++; else if (pas === "mois") { if (++mo > 12) { mo = 1; y++; } } else { const t = new Date(Date.UTC(y, mo - 1, d + 1)); y = t.getUTCFullYear(); mo = t.getUTCMonth() + 1; d = t.getUTCDate(); } }
      const MN = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
      const lib = (c) => (pas === "annee" ? `${c}` : pas === "mois" ? `${MN[(c % 100) - 1]} ${Math.floor(c / 100)}` : `${c % 100} ${MN[Math.floor(c / 100) % 100 - 1]} ${Math.floor(c / 10000)}`);
      const srcLab = (x) => (x.label || x.key).replace(/ \((année|mois|jour)\)$/, "");
      this._temps = { key: f.key, finKey: fin ? fin.key : null, lo, hi, pos, lib, pas, mode: fin ? "actif" : "cumul", jouer: false };
      const manque = cols.map((c) => c.miss).reduce((a, b) => a + b, 0);
      const quoi = fin ? `${esc(srcLab(f))} → ${esc(srcLab(fin))}` : esc(srcLab(f));
      box.hidden = false;
      box.innerHTML = `<span class="dp-t-titre">${Icon("clock", 14)} Temps — <b>${quoi}</b></span>
        <button type="button" class="dp-t-play" aria-label="Lecture" title="Lecture (une période par seconde)">${Icon("play", 14)}</button>
        <input type="range" class="dp-t-slider" min="0" max="${pos.length - 1}" step="1" value="${pos.length - 1}" aria-label="Période">
        <output class="dp-t-val"></output>
        ${fin ? "" : `<select class="dp-t-mode" aria-label="Mode"><option value="cumul">cumul (jusqu'à)</option><option value="annee">période seule</option></select>`}
        <small class="dp-t-note">${fin ? "Actif à la date choisie : début ≤ date ≤ fin. " : ""}${manque ? `${fr(manque)} date(s) absente(s) : lignes exclues du filtre temps, jamais supposées en cours. ` : ""}Pas : ${pas === "annee" ? "année" : pas}, lu dans « ${esc(f.source)} »${fin ? ` et « ${esc(fin.source)} »` : ""}.</small> <small class="dp-t-manuel" hidden><b>Un filtre de plage manuel est actif sur ce champ.</b></small>`;
      const sl = box.querySelector(".dp-t-slider"), mode = box.querySelector(".dp-t-mode"), play = box.querySelector(".dp-t-play");
      const md = () => (mode ? mode.value : "actif");
      let t; const appliquer = () => { clearTimeout(t); t = setTimeout(() => this._appliquerTemps(Number(sl.value), md()), 120); };
      sl.addEventListener("input", () => { this._stopTemps(); this._majTemps(Number(sl.value), md()); appliquer(); });
      if (mode) mode.addEventListener("change", () => { this._temps.mode = mode.value; this._majTemps(Number(sl.value), mode.value); appliquer(); });
      play.addEventListener("click", () => (this._temps.jouer ? this._stopTemps() : this._jouerTemps()));
      this._majTemps(pos.length - 1, md());
    },
    _majTemps(i, mode) {
      const o = this._el?.querySelector(".dp-t-val"), T = this._temps; if (!o || !T) return;
      o.textContent = T.finKey ? `actif le ${T.lib(T.pos[i])}` : mode === "annee" ? T.lib(T.pos[i]) : `${T.lib(T.pos[0])} → ${T.lib(T.pos[i])}`;
    },
    _appliquerTemps(i, mode) {
      const T = this._temps, c = T.pos[i];
      if (T.finKey) { this._set(T.key, { max: c }); this._set(T.finKey, { min: c }); return; } // intervalle : début ≤ c et fin ≥ c (sans date : exclu, compté à part)
      // « cumul » à la dernière période = pas de filtre (tout, y compris les lignes sans date) ; sinon filtre numérique (les sans-date sont exclus et comptés à part)
      this._set(T.key, mode === "cumul" && i >= T.pos.length - 1 ? null : mode === "annee" ? { min: c, max: c } : { max: c });
    },
    async _attendre() { while (this._busy || this._dirty.size) await new Promise((r) => setTimeout(r, 40)); },
    async _jouerTemps() {
      const T = this._temps; if (!T) return; T.jouer = true;
      const box = this._el.querySelector(".dp-temps"), sl = box.querySelector(".dp-t-slider"), mode = box.querySelector(".dp-t-mode");
      const md = () => (mode ? mode.value : "actif");
      box.querySelector(".dp-t-play").innerHTML = Icon("pause", 14); box.querySelector(".dp-t-play").setAttribute("aria-label", "Pause");
      let i = Number(sl.value) >= T.pos.length - 1 ? 0 : Number(sl.value) + 1;
      while (T.jouer && i < T.pos.length) {
        sl.value = i; this._majTemps(i, md());
        if (T.finKey) { this._set(T.key, { max: T.pos[i] }); this._set(T.finKey, { min: T.pos[i] }); } else this._set(T.key, md() === "annee" ? { min: T.pos[i], max: T.pos[i] } : { max: T.pos[i] });
        await this._attendre();
        if (this._verified === false || !T.jouer) break; // incohérence carte/tableau : on s'arrête, rien n'est masqué
        await new Promise((r) => setTimeout(r, 1000));
        i++;
      }
      this._stopTemps();
    },
    _stopTemps() {
      if (this._temps) this._temps.jouer = false;
      const b = this._el?.querySelector(".dp-t-play"); if (b) { b.innerHTML = Icon("play", 14); b.setAttribute("aria-label", "Lecture"); }
    },
    /** Resynchronise le curseur sur le filtre réellement validé (filtre posé au tableau ou par l'agent). */
    _syncTemps() {
      const T = this._temps; if (!T || !this._el || T.jouer) return;
      const box = this._el.querySelector(".dp-temps"); if (!box) return;
      const sl = box.querySelector(".dp-t-slider"), mode = box.querySelector(".dp-t-mode"), man = box.querySelector(".dp-t-manuel");
      if (document.activeElement === sl) return;
      const idx = (c) => { const j = T.pos.indexOf(c); return j < 0 ? T.pos.length - 1 : j; };
      const s = this._committed[T.key]; let manuel = false;
      if (T.finKey) {
        const sf = this._committed[T.finKey];
        if (!s && !sf) sl.value = T.pos.length - 1;
        else if (s && sf && s.min == null && sf.max == null && s.max != null && s.max === sf.min) sl.value = idx(s.max);
        else { manuel = true; sl.value = s?.max != null ? idx(s.max) : T.pos.length - 1; }
      } else if (!s) { sl.value = T.pos.length - 1; mode.value = "cumul"; }
      else if (s.min != null && s.min === s.max) { sl.value = idx(s.min); mode.value = "annee"; }
      else if (s.min == null && s.max != null) { sl.value = idx(s.max); mode.value = "cumul"; }
      else { sl.value = s.max != null ? idx(s.max) : T.pos.length - 1; mode.value = "cumul"; manuel = true; }
      man.hidden = !manuel;
      this._majTemps(Number(sl.value), mode ? mode.value : "actif");
    },

    // ── filtres ─────────────────────────────────────────────────
    _set(key, s) { if (s) this._state[key] = s; else delete this._state[key]; this._dirty.add(key); if (!this._busy) this._drain(); },
    /**
     * Opération de filtre demandée de l'extérieur (outil `map`) : validée sur les DONNÉES réelles du panneau, appliquée par le
     * circuit habituel (tableau + carte, contrôle de concordance, annulation si divergence), puis relue. Jamais de succès sans relecture.
     */
    /** État commun du contexte tel qu'AFFICHÉ (couche suivie, filtres validés, comptes relus, champs filtrables) : c'est ce que voit l'agent. */
    etatPublic() {
      if (!this._sourceId || !this._cols || !this._idx) return null;
      const filtres = [];
      for (const [k, v] of Object.entries(this._committed || {})) filtres.push({ champ: k, ...v });
      const champs = [];
      for (const f of this._fields || []) {
        const c = this._cols[f.key]; if (!c || !c.filterable) continue;
        const o = { cle: f.key, type: c.kind === "enum" ? "categories" : c.kind === "number" ? "nombre" : "texte", sansValeur: c.miss };
        if (c.kind === "enum") o.valeurs = c.dict.map((v, i) => [v, c.counts[i]]).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([v, n]) => `${v} (${n})`);
        if (c.kind === "number") { o.min = c.min; o.max = c.max; }
        champs.push(o);
      }
      return { couche: this._sourceId, total: this._n, retenus: this._idxAttr.length, dansZoneVisible: this._zoneOn && this._zone ? this._idx.length : null, verifie: this._verified === false ? "non" : this._verified ? "oui" : "non synchronisee", filtres, champs, ...(this._temps ? { axeTemps: { champ: this._temps.key, de: this._temps.lo, a: this._temps.hi } } : {}), ...(this._vue && (this._vue.champ || this._vue.forme) ? { representation: { coloriePar: this._vue.champ || null, forme: this._vue.forme || null } } : {}) };
    },
    _publier() { try { GeoState.emit("surface-state", this.etatPublic()); } catch (_) { /* l'état est informatif : sa publication ne doit jamais casser l'affichage */ } },

    async applyOp(op) {
      if (!this._cols || !this._sourceId || !this._fields) return { ok: false, erreur: "Aucune donnée chargée dans le panneau de données : chargez d'abord une couche (action)." };
      if (op.layer !== this._sourceId) return { ok: false, erreur: `Le panneau de données suit la couche « ${this._sourceId} », pas « ${op.layer} » : les filtres ne sont possibles que sur la couche du panneau.` };
      const dispo = () => this._fields.filter((f) => this._cols[f.key].filterable).map((f) => `${f.key} (${this._cols[f.key].kind === "enum" ? "catégories" : this._cols[f.key].kind === "number" ? "nombre" : "texte"})`).join(", ");
      const quand = async () => { const t0 = Date.now(); while (this._busy || this._dirty.size) { if (Date.now() - t0 > 90000) throw new Error("délai dépassé pendant l'application du filtre"); await new Promise((r) => setTimeout(r, 50)); } };
      try {
        await quand();
        if (op.operation === "clear_filter") {
          const cles = op.field ? [op.field] : Object.keys(this._state);
          for (const k of cles) { if (op.field && !this._cols[k]) return { ok: false, erreur: `Champ « ${k} » inconnu. Champs filtrables : ${dispo()}.` }; this._set(k, null); }
          if (!cles.length) return { ok: true, resume: `Aucun filtre actif sur ${this._sourceId} : ${this._idx.length.toLocaleString("fr-FR")} sur ${this._n.toLocaleString("fr-FR")}.`, etat: this._etatOp() };
        } else {
          const k = op.field, c = this._cols[k];
          if (!c) return { ok: false, erreur: `Champ « ${k} » inconnu (ou vide, ou constant). Champs filtrables : ${dispo()}.` };
          if (!c.filterable) return { ok: false, erreur: `Le champ « ${k} » n'est pas filtrable (valeurs structurées). Champs filtrables : ${dispo()}.` };
          let s;
          if (c.kind === "enum") {
            if (op.min != null || op.max != null || op.texte != null) return { ok: false, erreur: `« ${k} » est un champ à catégories : utilisez \`values\`, pas min/max/texte.` };
            const bas = new Map(c.dict.map((d, j) => [d.toLowerCase(), d]));
            const inconnues = [], valeurs = [];
            for (const v of op.values || []) { const x = String(v); if (x === "") valeurs.push(""); else if (bas.has(x.toLowerCase())) valeurs.push(bas.get(x.toLowerCase())); else inconnues.push(x); }
            if (inconnues.length) return { ok: false, erreur: `Valeur(s) absente(s) du champ « ${k} » : ${inconnues.map((x) => `« ${x} »`).join(", ")}. Valeurs existantes : ${c.dict.slice(0, 40).map((d, j) => `${d} (${c.counts[j]})`).join(", ")}${c.dict.length > 40 ? `, … (${c.dict.length} au total)` : ""}${c.miss ? `; « » = sans valeur (${c.miss})` : ""}.` };
            s = { values: valeurs };
          } else if (c.kind === "number") {
            if (op.values != null || op.texte != null) return { ok: false, erreur: `« ${k} » est numérique (de ${c.min} à ${c.max}) : utilisez min et/ou max.` };
            if (op.min == null && op.max == null) return { ok: false, erreur: `Précisez min et/ou max pour « ${k} » (valeurs de ${c.min} à ${c.max}).` };
            s = { ...(op.min != null ? { min: op.min } : {}), ...(op.max != null ? { max: op.max } : {}) };
          } else {
            if (op.values != null || op.min != null || op.max != null) return { ok: false, erreur: `« ${k} » est un champ texte : utilisez \`texte\`.` };
            if (op.texte == null || !String(op.texte).trim()) return { ok: false, erreur: `Précisez \`texte\` pour « ${k} ».` };
            s = { texte: String(op.texte) };
          }
          this._set(k, s);
        }
        await new Promise((r) => setTimeout(r, 0)); await quand();
        // relecture : ce qui est réellement validé (tableau ET carte), pas ce qui a été demandé
        const voulu = op.operation === "clear_filter" ? (op.field ? [op.field] : Object.keys(this._committed)) : [op.field];
        const ecart = op.operation === "clear_filter" ? voulu.filter((k) => this._committed[k]) : (JSON.stringify(this._committed[op.field]) === JSON.stringify(this._state[op.field]) ? [] : [op.field]);
        if (ecart.length || this._verified === false) {
          const alerte = this._el?.querySelector(".dp-alert")?.innerText?.trim();
          return { ok: false, erreur: `Le filtre n'a pas été appliqué : ${alerte || "le tableau et la carte ne concordent pas"}. État inchangé.`, etat: this._etatOp() };
        }
        this._restoreUi();
        const e = this._etatOp(), f = Object.entries(this._committed).map(([k, v]) => `${k} ${JSON.stringify(v)}`).join(" ; ") || "aucun";
        return { ok: true, resume: `${e.compte.toLocaleString("fr-FR")} sur ${e.total.toLocaleString("fr-FR")} éléments retenus sur ${this._sourceId} (filtres : ${f}) — ${e.verifie ? "tableau et carte concordent" : "carte non vérifiée"}.`, etat: e };
      } catch (err) { return { ok: false, erreur: `Application du filtre impossible : ${err.message || err}` }; }
    },
    _etatOp() { return { couche: this._sourceId, compte: this._idxAttr.length, dansZoneVisible: this._zoneOn && this._zone ? this._idx.length : null, total: this._n, verifie: !!this._verified, filtres: JSON.parse(JSON.stringify(this._committed)) }; },
    _compile(state) {
      const fs = [];
      for (const [key, s] of Object.entries(state)) {
        const c = this._cols[key]; if (!c) continue;
        if (c.kind === "enum") {
          const sel = new Set(s.values.map((v) => String(v).toLowerCase())), ok = new Uint8Array(c.dict.length + 1), codes = c.codes;
          ok[0] = sel.has("") ? 1 : 0; c.dict.forEach((d, j) => { ok[j + 1] = sel.has(d.toLowerCase()) ? 1 : 0; });
          fs.push((i) => ok[codes[i]] === 1);
        } else if (c.kind === "number") {
          const { min, max } = s, v = c.vals, p = c.pres;
          fs.push((i) => p[i] === 1 && (min == null || v[i] >= min) && (max == null || v[i] <= max));
        } else if (c.kind === "text") {
          const q = norm(s.texte).trim(); if (!q) continue;
          const nn = c.norm || (c.norm = c.arr.map(norm)); fs.push((i) => nn[i].includes(q));
        }
      }
      return fs;
    },
    _compute(state) {
      const fs = this._compile(state), n = this._n, out = new Uint32Array(n); let m = 0;
      outer: for (let i = 0; i < n; i++) { for (let k = 0; k < fs.length; k++) if (!fs[k](i)) continue outer; out[m++] = i; }
      return out.slice(0, m);
    },
    _toAtlas(key, s) {
      if (!s) return null; const c = this._cols[key];
      if (c.kind === "enum") return s.values.slice();
      if (c.kind === "number") return { ...(s.min != null ? { min: s.min } : {}), ...(s.max != null ? { max: s.max } : {}) };
      return { texte: s.texte };
    },
    async _drain() {
      this._busy = true;
      try { while (this._dirty.size) await this._runOnce(); } finally { this._busy = false; }
    },
    async _runOnce() {
      const keys = [...this._dirty]; this._dirty.clear();
      const state = JSON.parse(JSON.stringify(this._state)), idx = this._compute(state);
      this._status("Application du filtre et vérification avec la carte…");
      const r = await this._pushToMap(keys, state);
      if (this._dirty.size) return; // un réglage plus récent est arrivé : on vérifiera celui-là
      if (r.ok === null || (r.ok && r.compte === this._nGeo(idx) && r.total === this._nCarte)) {
        this._committed = state; this._idxAttr = idx; this._idx = this._appliquerZone(idx); this._order = null; this._verified = r.ok === null ? null : { compte: r.compte, total: r.total };
        this._alert(null); this._paintAll(); this._syncTemps();
      } else {
        // divergence ou échec : on annule des deux côtés, rien de faux n'est affiché
        const why = r.erreur ? `Atlas a refusé le filtre (${r.erreur}).` : `Le tableau retient ${idx.length.toLocaleString("fr-FR")} éléments, la carte ${Number(r.compte).toLocaleString("fr-FR")} (sur ${Number(r.total).toLocaleString("fr-FR")}).`;
        this._state = JSON.parse(JSON.stringify(this._committed));
        const back = await this._pushToMap(Object.keys({ ...state, ...this._committed }), this._committed);
        this._restoreUi();
        const sain = back.ok === null || (back.ok && back.compte === this._nGeo(this._idxAttr));
        if (!sain) this._verified = false;
        this._alert(`<b>Filtre annulé : le tableau et la carte ne concordent pas.</b> ${why} ${sain ? "Le filtre précédent est rétabli." : "<b>La carte n'a pas pu être resynchronisée : ne pas se fier à l'affichage, recharger la couche.</b>"}`);
        this._paintAll();
      }
    },
    /** Envoie à Atlas l'état complet des contrôles listés ; renvoie le dernier {compte,total} (ok:null si la carte n'a pas de setFilter). */
    async _pushToMap(keys, state) {
      if (!window.GeoMap?.applyFilter || !this._sourceId) return { ok: null };
      let last = null;
      try {
        for (const k of keys) if (this._cols[k]?.filterable) last = await GeoMap.applyFilter(this._sourceId, this._ctl(k), this._toAtlas(k, state[k]));
        if (!last) last = await GeoMap.applyFilter(this._sourceId, this._control(this._fields.find((f) => this._cols[f.key].filterable)).id, null);
      } catch (e) { return { ok: false, erreur: e.message || String(e) }; }
      return { ok: true, compte: last?.compte, total: last?.total };
    },
    /** Ligne discrète sous le total : N entités sans position fiable (donnée source), exclues par défaut ; case pour les inclure au tableau. */
    _sansPos() {
      const b = this._el?.querySelector(".dp-sanspos"); if (!b) return;
      const n = Number(this._meta.ecartees || 0);
      const vo = this._meta.controle?.voisines || [];
      if (!n && !vo.length) { b.hidden = true; b.innerHTML = ""; return; }
      if (!n) {
        const esc = (x) => String(x ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
        const ch = Number(this._meta.controle?.cheval || 0), nv = this._meta.controle?.niveau || "commune", lib = { commune: "la commune", epci: "l'EPCI", departement: "le département", region: "la région" }[nv] || "le territoire", delib = { commune: "de la commune", epci: "de l'EPCI", departement: "du département", region: "de la région" }[nv] || "du territoire", adj = { commune: "communale", epci: "de l'EPCI", departement: "départementale", region: "régionale" }[nv] || "du territoire";
        b.hidden = false;
        b.innerHTML = `<span>+ ${vo.length.toLocaleString("fr-FR")} objet(s) écarté(s) : aucun point commun avec le contour ${delib} (ADMIN EXPRESS, IGN) — retenus par l'emprise rectangulaire du filtre serveur (voisinage).${ch ? ` ${ch.toLocaleString("fr-FR")} objet(s) à cheval sur la limite ${adj} sont conservés (colonne « Position »).` : ""}</span> <button type="button" class="dp-constat-btn">liste des écartés</button><div class="dp-constat" hidden><pre style="max-height:180px;overflow:auto;margin:6px 0 0;font-size:11px;white-space:pre-wrap">${vo.map((x) => `${esc(x.id)}${x.libelle ? " · " + esc(x.libelle) : ""} — ${esc(x.raison)}`).join("\n")}</pre></div>`;
        b.querySelector(".dp-constat-btn").addEventListener("click", () => { const d = b.querySelector(".dp-constat"); d.hidden = !d.hidden; });
        return;
      }
      const inc = !!window.GeoFetcher?.inclureSansPosition, fr = n.toLocaleString("fr-FR");
      b.hidden = false;
      b.innerHTML = `<span>${inc ? `Dont ${fr} sans position fiable (donnée source), dans le tableau seulement.` : `+ ${fr} sans position fiable (donnée source), masqués.`}</span> <label><input type="checkbox" ${inc ? "checked" : ""}> inclure dans le tableau</label>`;
      b.insertAdjacentHTML("beforeend", ` <button type="button" class="dp-constat-btn">constat à signaler</button><div class="dp-constat" hidden></div>`);
      b.querySelector(".dp-constat-btn").addEventListener("click", () => this._constat(b.querySelector(".dp-constat")));
      b.querySelector("input").addEventListener("change", (e) => { window.GeoFetcher.inclureSansPosition = e.target.checked; if (typeof this._meta.retryLiens === "function") this._meta.retryLiens(); });
    },
    /** Constat des entités écartées : texte à relire et à copier, JSON à télécharger. Décrit ce qui est CONSTATÉ, n'affirme pas que la source a tort ; rien n'est envoyé. */
    _constat(box) {
      if (!box.hidden) { box.hidden = true; return; }
      const an = this._meta.anomalies || [], n = Number(this._meta.ecartees || 0);
      const src = this._meta.sourceLabel || this._sourceId, le = new Date().toISOString().slice(0, 10);
      const fil = document.querySelector(".fil-cur"); const terr = fil ? [...fil.childNodes].map((x) => x.textContent.trim()).filter(Boolean).join(" ").slice(0, 120) : "";
      const complet = an.length === n; const lues = (window.GeoFetcher?.inclureSansPosition ? this._n : this._n + n).toLocaleString("fr-FR");
      const lignes = an.slice(0, 20).map((a) => `- ${a.id || "(sans identifiant)"} : ${a.raison}${a.valeur ? ` (valeur lue : ${a.valeur})` : ""}${a.distanceKm != null ? `, à ${a.distanceKm} km des autres` : ""}`);
      const texte = `À vérifier : dans « ${src} »${terr ? ` (${terr})` : ""}, lu le ${le}, ${n} entité(s) sur ${lues} lues ont une position inutilisable. Ce n'est pas une erreur prouvée : la raison de chaque ligne indique le critère appliqué.${this._meta.controle ? (this._meta.controle.fait ? ` Contrôle du contour communal (ADMIN EXPRESS, IGN) effectué sur ${this._meta.controle.lus.toLocaleString("fr-FR")} positions : ${this._meta.controle.hors} hors contour.` : ` Contrôle du contour communal NON effectué (${this._meta.controle.erreur}).`) : ""}\n${lignes.join("\n")}${an.length > 20 ? `\n… et ${an.length - 20} autre(s) dans le fichier JSON.` : ""}${complet ? "" : "\n(Liste incomplète : le constat ne détaille que " + an.length + " entité(s) sur " + n + ".)"}\nMerci de vérifier la position de ces entrées.`;
      const json = JSON.stringify({ version: "anomalies-donnees/0.1", source: { id: this._sourceId, label: src }, lu_le: le, territoire: terr || null, lignes_lues: window.GeoFetcher?.inclureSansPosition ? this._n : this._n + n, entites_ecartees: n, anomalies: an, nature: "constat à examiner, pas une erreur prouvée" }, null, 2);
      box.hidden = false;
      box.innerHTML = `<pre class="dp-constat-txt"></pre><button type="button" class="dp-c-copier">Copier le texte</button> <button type="button" class="dp-c-json">Télécharger le JSON</button> <span class="dp-c-etat"></span>`;
      box.querySelector("pre").textContent = texte;
      const etat = box.querySelector(".dp-c-etat");
      box.querySelector(".dp-c-copier").addEventListener("click", async () => { try { await navigator.clipboard.writeText(texte); etat.textContent = "Copié."; } catch (e) { etat.textContent = "Copie impossible : sélectionnez le texte à la main."; } });
      box.querySelector(".dp-c-json").addEventListener("click", () => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([json], { type: "application/json" })); a.download = `anomalies-${this._sourceId}-${le}.json`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); etat.textContent = "Fichier téléchargé."; });
    },
    /** Combien des lignes de `idx` sont sur la carte (celles sans position fiable sont dans le tableau seulement). */
    _nGeo(idx) { let n = 0; for (let t = 0; t < idx.length; t++) if (this._geo[idx[t]]) n++; return n; },
    async _checkMap(ctl) {
      if (!ctl) return;
      const r = await this._pushToMap([], {});
      if (r.ok === null) { this._verified = null; this._status(); return; }
      if (!r.ok || r.compte !== this._nCarte || r.total !== this._nCarte) {
        this._alert(`<b>Carte et tableau ne concordent pas.</b> Tableau : ${this._n.toLocaleString("fr-FR")} éléments ; carte : ${r.ok ? `${Number(r.compte).toLocaleString("fr-FR")} sur ${Number(r.total).toLocaleString("fr-FR")}` : esc(r.erreur)}. Ne pas se fier à l'affichage ; recharger la couche.`);
        this._verified = false;
      } else { this._verified = { compte: r.compte, total: r.total }; this._alert(""); this._sansPos(); }
      this._status();
    },
    _restoreUi() {
      const bar = this._el.querySelector(".dp-bar"); let i = 0;
      for (const f of this._fields) {
        const c = this._cols[f.key]; if (!c.filterable) continue;
        const node = bar.children[i++], s = this._state[f.key];
        if (c.kind === "enum") { node.querySelectorAll("input").forEach((x) => { x.checked = !!s && s.values.includes(x.dataset.v); }); node.querySelector("summary").classList.toggle("on", !!s); }
        else if (c.kind === "number") { node.querySelector("[data-r=min]").value = s?.min ?? ""; node.querySelector("[data-r=max]").value = s?.max ?? ""; }
        else node.querySelector("input").value = s?.texte ?? "";
      }
      this._syncTemps();
    },

    // ── rendu ───────────────────────────────────────────────────
    _alert(html) { const a = this._el?.querySelector(".dp-alert"); if (!a) return; a.hidden = !html; a.innerHTML = html || ""; },
    _status(msg) {
      const s = this._el?.querySelector(".dp-status"); if (!s) return;
      if (msg) { s.textContent = msg; return; }
      const f = this._idxAttr.length, n = this._n, carte = this._verified === false ? '<span class="dp-ko">carte non vérifiée</span>' : this._verified ? `<span class="dp-ok">carte vérifiée ${Icon("check", 12)} ${Number(this._verified.compte).toLocaleString("fr-FR")} / ${Number(this._verified.total).toLocaleString("fr-FR")}</span>${this._nCarte < this._n ? ` <span class="dp-ko">(${(this._n - this._nCarte).toLocaleString("fr-FR")} sans position)</span>` : ""}` : "carte non synchronisée";
      s.innerHTML = `${this._zoneOn && this._zone ? `${this._idx.length.toLocaleString("fr-FR")} dans la zone visible, sur ${f.toLocaleString("fr-FR")} retenus (${n.toLocaleString("fr-FR")} au total)` : `${f.toLocaleString("fr-FR")} sur ${n.toLocaleString("fr-FR")} éléments`} · ${carte}${this._meta.nLayers > 1 ? ` · panneau : couche 1 sur ${this._meta.nLayers}` : ""}`;
    },
    _paintAll() {
      this._publier(); this._paintStats(); this._paintChips(); this._status(); this._paintTable(false); },
    _paintStats() {
      const idx = this._idx, total = idx.length, cards = [];
      cards.push(`<div class="stat-card"><div class="value">${total.toLocaleString("fr-FR")}</div><div class="label">éléments${total !== this._n ? ` sur ${this._n.toLocaleString("fr-FR")}` : ""}</div></div>`);
      for (const f of this._fields) {
        const c = this._cols[f.key];
        if (f.unit && f.type === "number" && c.kind === "number") {
          // Somme : seulement pour une grandeur déclarée extensive (population, surface, nombre…). Une intensité (kWh/m²/an, hauteur, taux…) ne
          // s'additionne pas : médiane et étendue (min–max), jamais une moyenne ou une somme présentées comme représentatives.
          const v = []; for (let j = 0; j < total; j++) { const i = idx[j]; if (c.pres[i]) v.push(c.vals[i]); }
          const k = v.length, manque = total - k ? `<br><small>${(total - k).toLocaleString("fr-FR")} sans valeur</small>` : "";
          if (k && f.aggregate === "sum") {
            let sum = 0; for (const x of v) sum += x;
            cards.push(`<div class="stat-card"><div class="value">${fr(Math.round(sum * 10) / 10, 1)}</div><div class="label">Total : ${esc(f.label || f.key)} (${esc(f.unit)})${manque}</div></div>`);
          } else if (k) {
            v.sort((x, y) => x - y);
            const med = k % 2 ? v[(k - 1) / 2] : (v[k / 2 - 1] + v[k / 2]) / 2, r1 = (x) => fr(Math.round(x * 10) / 10, 1);
            cards.push(`<div class="stat-card"><div class="value">${r1(med)}</div><div class="label">Médiane : ${esc(f.label || f.key)} (${esc(f.unit)})<br><small>de ${r1(v[0])} à ${r1(v[k - 1])}</small>${manque}</div></div>`);
          }
        }
      }
      for (const f of this._fields) {
        const c = this._cols[f.key]; if (c.kind !== "enum" || c.dict.length <= 1 || c.dict.length > 12) continue;
        if (!f.primary && c.dict.length > 6) continue;
        const cnt = new Uint32Array(c.dict.length + 1), codes = c.codes;
        const sel = this._committed[f.key] ? new Set(this._committed[f.key].values.map((v) => String(v).toLowerCase())) : null;
        const base = sel ? this._idxSans(f.key) : idx, tb = base.length;
        for (let j = 0; j < tb; j++) cnt[codes[base[j]]]++;
        const rows = c.dict.map((v, j) => ({ v, n: cnt[j + 1], cle: v })); if (cnt[0]) rows.push({ v: "(sans valeur)", n: cnt[0], cle: "" });
        rows.sort((a, b) => b.n - a.n); const garde = (r) => r.n > 0 || (sel && sel.has(r.cle.toLowerCase())), shown = rows.filter(garde).slice(0, 8), rest = rows.filter(garde).length - shown.length, mx = Math.max(1, ...shown.map((r) => r.n));
        cards.push(`<div class="stat-card stat-dist" style="grid-column:span 2"><div class="label" style="margin-bottom:6px">${esc(f.label || f.key)}</div>${shown.map((r) => `<div class="dist-row dist-clic${sel && sel.has(r.cle.toLowerCase()) ? " on" : ""}" role="button" tabindex="0" aria-pressed="${!!(sel && sel.has(r.cle.toLowerCase()))}" data-k="${esc(f.key)}" data-v="${esc(r.cle)}" title="${sel && sel.has(r.cle.toLowerCase()) ? "Retirer" : "Filtrer sur"} « ${esc(r.v)} »"><span class="dist-label" title="${esc(r.v)}">${esc(r.v.length > 18 ? r.v.slice(0, 16) + "…" : r.v)}</span><div class="dist-bar-bg"><div class="dist-bar" style="width:${Math.max(4, Math.round(r.n / mx * 100))}%"></div></div><span class="dist-count">${r.n.toLocaleString("fr-FR")} <small>(${Math.round(r.n / Math.max(1, tb) * 100)}%)</small></span></div>`).join("")}${rest > 0 ? `<div class="dist-row"><small>+ ${rest} autres valeurs</small></div>` : ""}</div>`);
      }
      this._el.querySelector(".dp-stats").innerHTML = `<div class="stat-grid">${cards.join("")}</div>`;
    },
    // sélection venue de la carte : marque la ligne et la rend visible ; renvoie false si elle est absente du tableau (filtre)
    selectRow(idx) {
      this._selIdx = idx;
      const ord = this._sorted(), pos = ord.indexOf(idx);
      if (pos < 0) { this._paintRows(); return false; }
      const sc = this._el.querySelector(".dp-scroll");
      const top = pos * ROW_H, vh = sc.clientHeight || VIEW_H;
      if (top < sc.scrollTop || top + ROW_H > sc.scrollTop + vh) sc.scrollTop = Math.max(0, top - Math.floor(vh / 2));
      this._paintRows();
      return true;
    },
    _sorted() {
      if (!this._sortKey) return this._idx;
      if (this._order) return this._order;
      const c = this._cols[this._sortKey], asc = this._sortAsc ? 1 : -1, o = this._idx.slice();
      if (c.kind === "number") o.sort((a, b) => { const pa = c.pres[a], pb = c.pres[b]; if (!pa || !pb) return pa === pb ? 0 : pa ? -1 : 1; return (c.vals[a] - c.vals[b]) * asc || a - b; });
      else if (c.kind === "enum") {
        const ord = c.dict.map((d, j) => [d, j + 1]).sort((a, b) => a[0].localeCompare(b[0], "fr")), rank = new Uint16Array(c.dict.length + 1); ord.forEach(([, k], r) => { rank[k] = r + 1; });
        o.sort((a, b) => { const ka = c.codes[a], kb = c.codes[b]; if (!ka || !kb) return ka === kb ? 0 : ka ? -1 : 1; return (rank[ka] - rank[kb]) * asc || a - b; });
      } else o.sort((a, b) => { const sa = c.arr[a], sb = c.arr[b]; if (!sa || !sb) return sa === sb ? 0 : sa ? -1 : 1; return sa.localeCompare(sb, "fr") * asc || a - b; });
      return (this._order = o);
    },
    _paintTable(resetScroll) {
      const tr = this._el.querySelector("thead tr");
      tr.querySelectorAll("th").forEach((th) => { th.querySelector(".ar")?.remove(); th.setAttribute("aria-sort", th.dataset.key === this._sortKey ? (this._sortAsc ? "ascending" : "descending") : "none"); if (th.dataset.key === this._sortKey) th.insertAdjacentHTML("beforeend", `<span class="ar">${Icon(this._sortAsc ? "arrow-up" : "arrow-down", 12)}</span>`); });
      const sc = this._el.querySelector(".dp-scroll"); if (resetScroll) sc.scrollTop = 0;
      this._paintRows();
    },
    /** Période lisible (« déc. 2023 ») à partir du code numérique AAAA / AAAAMM / AAAAMMJJ. */
    _libTemps(pas, c) {
      const MN = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];
      return pas === "annee" ? `${c}` : pas === "mois" ? `${MN[(c % 100) - 1]} ${Math.floor(c / 100)}` : `${c % 100} ${MN[Math.floor(c / 100) % 100 - 1]} ${Math.floor(c / 10000)}`;
    },
    _paintRows() {
      const sc = this._el.querySelector(".dp-scroll"), ord = this._sorted(), total = ord.length, cols = this._fields.map((f) => this._cols[f.key]);
      const start = Math.max(0, Math.floor(sc.scrollTop / ROW_H) - 6), end = Math.min(total, start + Math.ceil((sc.clientHeight || VIEW_H) / ROW_H) + 14), span = cols.length;
      let html = start ? `<tr style="height:${start * ROW_H}px"><td colspan="${span}"></td></tr>` : "";
      for (let j = start; j < end; j++) { const i = ord[j]; html += `<tr data-i="${i}" tabindex="0"${i === this._selIdx ? ' class="sel" aria-selected="true"' : ""}>${cols.map((c, ci) => { let v = cell(c, i); const ff = this._fields[ci]; if (ff.derivee === "temps" && typeof v === "number") v = this._libTemps(ff.pas, v); return `<td${c.kind === "number" ? ' class="num"' : ""}${typeof v === "string" && v.length > 60 ? ` title="${esc(v)}"` : ""}>${fmt(v)}</td>`; }).join("")}</tr>`; }
      if (end < total) html += `<tr style="height:${(total - end) * ROW_H}px"><td colspan="${span}"></td></tr>`;
      if (!total) html = `<tr><td colspan="${span}" style="padding:12px">Aucun élément ne correspond aux filtres. <button type="button" class="dp-btn dp-clear-all">Effacer les filtres</button></td></tr>`;
      this._el.querySelector("tbody").innerHTML = html;
    },
    /** Lignes retenues par tous les filtres SAUF celui de `key` (comptes des facettes), puis restreintes à la zone visible. */
    _idxSans(key) { const st = { ...this._committed }; delete st[key]; return this._appliquerZone(this._compute(st)); },
    /** La légende peut-elle filtrer ce champ/cette valeur sur la couche suivie par le tableau ? (colonne à catégories, valeur connue) */
    categorieFiltrable(couche, champ, valeur) {
      const c = this._cols?.[champ]; if (!c || c.kind !== "enum" || !this._sourceId || (couche !== this._sourceId && couche !== "l_" + this._sourceId)) return false;
      return valeur === "" ? c.miss > 0 : c.dict.includes(valeur);
    },
    estCochee(champ, valeur) { return !!this._committed?.[champ]?.values?.some((x) => String(x).toLowerCase() === String(valeur).toLowerCase()); },
    /** Clic sur une catégorie des statistiques : ajoute ou retire la valeur du filtre du champ (même circuit que la barre de filtres : tableau + carte + contrôle). */
    _basculerCategorie(key, v) {
      const c = this._cols[key]; if (!c || c.kind !== "enum") return;
      const cur = (this._state[key]?.values || []).map(String), i = cur.findIndex((x) => x.toLowerCase() === v.toLowerCase());
      if (i >= 0) cur.splice(i, 1); else cur.push(v);
      this._set(key, cur.length ? { values: cur } : null); this._restoreUi();
    },
    // ── zone visible de la carte : restreint le TABLEAU et les statistiques, jamais la carte (qui garde tous les éléments) ──
    _bboxFeatures() {
      if (this._bbf) return this._bbf;
      const n = this._n, b = new Float64Array(n * 4).fill(NaN);
      const parcourir = (c, o) => { if (typeof c[0] === "number") { if (c[0] < o[0]) o[0] = c[0]; if (c[0] > o[2]) o[2] = c[0]; if (c[1] < o[1]) o[1] = c[1]; if (c[1] > o[3]) o[3] = c[1]; } else for (const x of c) parcourir(x, o); };
      for (let i = 0; i < n; i++) {
        const g = this._features[i]?.geometry; if (!g || !g.coordinates) continue;
        const o = [Infinity, Infinity, -Infinity, -Infinity]; try { parcourir(g.coordinates, o); } catch { continue; }
        if (o[0] <= o[2]) { b[4 * i] = o[0]; b[4 * i + 1] = o[1]; b[4 * i + 2] = o[2]; b[4 * i + 3] = o[3]; }
      }
      return (this._bbf = b);
    },
    /** Restreint `idx` aux éléments dont l'emprise touche la zone visible ; sans zone active, renvoie `idx` tel quel. */
    _appliquerZone(idx) {
      if (!this._zoneOn || !this._zone) return idx;
      const b = this._bboxFeatures(), [w, s, e, n] = this._zone, out = new Uint32Array(idx.length); let m = 0;
      for (let t = 0; t < idx.length; t++) { const i = idx[t], k = 4 * i; if (b[k] <= e && b[k + 2] >= w && b[k + 1] <= n && b[k + 3] >= s) out[m++] = i; }
      return out.slice(0, m);
    },
    _majZone() {
      if (!this._zoneOn) return;
      const z = window.GeoMap?.zoneVisible?.();
      if (!z || z.erreur) { this._zoneOn = false; this._zone = null; this._idx = this._idxAttr; this._order = null; this._alert(`<b>Zone visible indisponible :</b> ${esc(z?.erreur || "la carte ne fournit pas son emprise")}. La limitation à la zone visible est désactivée, le tableau montre tous les éléments retenus.`); this._paintAll(); this._syncZoneUi(); return; }
      this._zone = z.bbox; this._idx = this._appliquerZone(this._idxAttr); this._order = null; this._alert(null); this._paintAll();
    },
    _syncZoneUi() { const c = this._el?.querySelector(".dp-zone"); if (c) c.checked = this._zoneOn; },
    _basculerZone(on) {
      this._zoneOn = !!on;
      if (!on) { this._zone = null; this._idx = this._idxAttr; this._order = null; this._alert(null); this._paintAll(); return; }
      this._majZone();
    },
    /** Retire tous les filtres par le circuit habituel (carte + tableau + contrôle de concordance). */
    _effacerTout() { const ks = Object.keys(this._state); if (!ks.length) return; for (const k of ks) this._set(k, null); this._restoreUi(); },
    _libFiltre(k, v) {
      const f = this._fields.find((x) => x.key === k), nom = f?.label || this._formatHeader(k);
      if (v.values) return `${nom} : ${v.values.map((x) => x === "" ? "(sans valeur)" : x).join(", ")}`;
      if (v.texte != null) return `${nom} contient « ${v.texte} »`;
      return `${nom} : ${v.min != null ? "≥ " + fr(v.min) : ""}${v.min != null && v.max != null ? " et " : ""}${v.max != null ? "≤ " + fr(v.max) : ""}`;
    },
    _paintChips() {
      const box = this._el.querySelector(".dp-chips"), act = this._el.querySelector(".dp-actions"), ent = Object.entries(this._committed || {});
      box.hidden = !ent.length;
      box.innerHTML = ent.map(([k, v]) => `<span class="dp-chip">${esc(this._libFiltre(k, v))}<button type="button" data-k="${esc(k)}" aria-label="Retirer le filtre ${esc(k)}">×</button></span>`).join("") + (ent.length > 1 ? '<button type="button" class="dp-btn dp-clear-all">Effacer les filtres</button>' : "");
      this._syncZoneUi();
      box.onclick = (e) => { const b = e.target.closest("button[data-k]"); if (b) { this._set(b.dataset.k, null); this._restoreUi(); } };
      if (!act.dataset.ok) { act.dataset.ok = "1"; act.innerHTML = '<label class="dp-zone-l"><input type="checkbox" class="dp-zone"> Limiter à la zone visible de la carte</label><button type="button" class="dp-btn dp-export">Exporter en CSV</button><small class="dp-export-note"></small>'; act.querySelector(".dp-zone").onchange = (e) => this._basculerZone(e.target.checked); act.querySelector(".dp-export").onclick = () => this._exporter(); }
    },
    /** Exporte exactement les lignes retenues, dans l'ordre affiché, avec le total et les filtres en note. Aucune ligne écartée en silence. */
    _exporter() {
      const ord = this._sorted(), cols = this._fields.map((f) => [f, this._cols[f.key]]);
      const q = (v) => { if (v == null) return ""; const t = String(v); return /[";\n\r]/.test(t) ? '"' + t.replace(/"/g, '""') + '"' : t; };
      const lignes = [cols.map(([f]) => q(f.label || this._formatHeader(f.key) + (f.unit ? ` (${f.unit})` : ""))).join(";")];
      for (let j = 0; j < ord.length; j++) lignes.push(cols.map(([, c]) => q(cell(c, ord[j]))).join(";"));
      const blob = new Blob(["\ufeff" + lignes.join("\r\n")], { type: "text/csv;charset=utf-8" });
      const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
      a.download = `${(this._sourceId || "donnees").replace(/[^A-Za-z0-9_-]/g, "_")}.csv`; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 4000); const zn = this._zoneOn && this._zone;
      const n = this._el.querySelector(".dp-export-note"); if (n) n.textContent = `${ord.length.toLocaleString("fr-FR")} ligne(s) exportée(s) sur ${this._n.toLocaleString("fr-FR")}${zn ? " (limitées à la zone visible)" : ord.length < this._n ? " (filtres actifs)" : ""}.`;
    },
    _formatHeader(key) { return key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/^Id$/, "ID"); },
    _renderText(text) {
      text = String(text).replace(/^\s*(?:\u{1F4CD}|\u{1F5FA}\uFE0F?)\s*/gmu, "");
      const html = esc(text).replace(/── (.+?) ──/g, "<h4 style='margin:12px 0 6px;color:var(--accent)'>$1</h4>").replace(/\n/g, "<br>");
      return `<div style="font-size:12px;line-height:1.6">${html}</div>`;
    },
  };
  window.DataPanel = DataPanel;
})();
