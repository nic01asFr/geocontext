/**
 * Fetch GeoJSON direct depuis Géoplateforme + reprojection.
 *
 * Le serveur MCP retourne des layerSpecs (URL, typename, CQL, style, theme…)
 * mais PAS le GeoJSON brut (trop volumineux pour le transport MCP).
 *
 * Ce module :
 *   1. Construit l'URL WFS GetFeature depuis le layerSpec
 *   2. Fetch le GeoJSON directement depuis Géoplateforme
 *   3. Reprojette de EPSG:2154 → 4326 si nécessaire
 *   4. Ajoute la couche sur la carte MapLibre avec style thématique
 */

// Typenames ADMINEXPRESS par niveau territorial
const ADMINEXPRESS_TYPENAMES = {
  commune:    { typename: "ADMINEXPRESS-COG.LATEST:commune",    field: "code_insee" },
  departement:{ typename: "ADMINEXPRESS-COG.LATEST:departement", field: "code_insee" },
  region:     { typename: "ADMINEXPRESS-COG.LATEST:region",      field: "code_insee" },
  epci:       { typename: "ADMINEXPRESS-COG.LATEST:epci",        field: "code_siren" },
};

const GPF_WFS_URL = "https://data.geopf.fr/wfs/ows";

// Métadonnées de niveau pour les couches de contexte (doit correspondre à map.js)
const ZOOM_TO_LEVEL_MAP = {
  region:      { level: "region",      label: "RÉG",  color: "#7a8abd" },
  departement: { level: "departement", label: "DÉP",  color: "#6a9aad" },
  epci:        { level: "epci",        label: "EPCI", color: "#5aadad" },
  commune:     { level: "commune",     label: "COM",  color: "#4aad8a" },
};

const GeoFetcher = {
  /** Entités sans position fiable (donnée source) : exclues par défaut du tableau ET de la carte ; l'utilisateur peut les inclure dans le tableau. */
  inclureSansPosition: false,
  /**
   * Traite un résultat MCP tool call et extrait les layerSpecs.
   * Retourne null si pas de layerSpecs dans la réponse.
   */
  extractLayerSpecs(result) {
    // Contrat courant : layerSpecs en données structurées
    if (result?.structuredContent?.layerSpecs) return result.structuredContent.layerSpecs;
    if (!result?.content) return null;

    for (const block of result.content) {
      if (block.type !== "text") continue;
      const text = block.text;

      // Chercher toutes les occurrences de "{" et tenter un parse JSON complet
      let i = 0;
      while (i < text.length) {
        const start = text.indexOf('{"_type":"layerSpecs"', i);
        if (start === -1) break;
        // Trouver la fermeture en comptant les accolades
        let depth = 0, end = start;
        for (; end < text.length; end++) {
          if (text[end] === '{') depth++;
          else if (text[end] === '}') { depth--; if (depth === 0) break; }
        }
        try {
          const parsed = JSON.parse(text.slice(start, end + 1));
          if (parsed._type === "layerSpecs" && parsed.layers) return parsed.layers;
        } catch {}
        i = start + 1;
      }
    }
    return null;
  },

  /**
   * Charge les couches, TOUTES leurs données, et ne les affiche que complètes et vérifiées (atomique par couche).
   * Une couche qui n'a pas pu être chargée en entier n'est PAS affichée ; elle est rendue avec `error` (jamais un résultat partiel
   * présenté comme complet).
   * @param {Object} layerSpecs - Map de { sourceId: LayerSpec }
   * @returns {Array<{ sourceId, label, features, primaryFields } | { sourceId, label, error, retry }>}
   */
  async loadLayers(layerSpecs) {
    const results = await Promise.all(Object.entries(layerSpecs).map(async ([sourceId, spec]) => {
      try {
        const r = await this._fetchAndDisplay(sourceId, spec);
        return r;
      } catch (err) {
        console.warn(`[geo-fetcher] ${sourceId}: ${err.message}`);
        return { sourceId, label: spec.label || sourceId, error: err.message, retry: () => this.loadLayers({ [sourceId]: spec }) };
      } finally {
        this._progress(sourceId, null);
      }
    }));
    const loaded = results.filter(Boolean);
    for (const layer of loaded) {
      if (layer?.features?.length > 0 && layer.styleRecipe?.classification) {
        GeoMap.updateLegendCounts(layer.features, layer.styleRecipe.classification);
      }
    }
    return loaded;
  },

  // ── Progression (le détail de ce qui est en cours, jamais une couche à moitié affichée) ──
  _progress(sourceId, texte) {
    const host = document.getElementById("map-overlay"); if (!host) return;
    const id = `map-progress-${String(sourceId).replace(/[^A-Za-z0-9_-]/g, "_")}`;
    let el = document.getElementById(id);
    if (texte == null) { el?.remove(); return; }
    if (!el) { el = document.createElement("div"); el.id = id; el.className = "map-progress"; el.style.cssText = "position:absolute;left:50%;top:12px;transform:translateX(-50%);background:#fff;border:1px solid #bbb;border-radius:4px;padding:6px 12px;font:13px system-ui;box-shadow:0 1px 4px #0003;z-index:6"; host.appendChild(el); }
    el.textContent = texte;
  },

  /** GET JSON avec reprises espacées (réseau, 429, 5xx). Toute autre réponse non valide est une erreur. */
  async _fetchJson(url, { essais = 5 } = {}) {
    let derniere = "";
    for (let i = 0; i < essais; i++) {
      try {
        const r = await fetch(url);
        if (r.ok) return await r.json();
        derniere = `HTTP ${r.status}`;
        let detail = ""; try { detail = (await r.clone().json()).erreur || ""; } catch { /* corps non JSON */ }
        if (detail) derniere += ` — ${detail}`;
        if (r.status < 500 && r.status !== 429) break; // erreur définitive
      } catch (e) { derniere = e.message || "réseau"; }
      await new Promise((ok) => setTimeout(ok, 800 * 2 ** i));
    }
    throw new Error(derniere || "échec de la requête");
  },

  /**
   * Charge et affiche le contour du territoire courant sur la carte.
   * @param {{ level: string, code: string }} ctx
   */
  async loadTerritoryBoundary(ctx) {
    if (!ctx || !ctx.level || !ctx.code) return;
    const def = ADMINEXPRESS_TYPENAMES[ctx.level];
    if (!def) return; // parcelle, point, etc. : pas de boundary ADMINEXPRESS
    const jeton = GeoState.navToken, perime = () => jeton !== GeoState.navToken;
    try {
      const params = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeName: def.typename, outputFormat: "application/json", CQL_FILTER: `${def.field}='${ctx.code}'`, srsName: "EPSG:4326" });
      const response = await fetch(`${GPF_WFS_URL}?${params.toString()}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geojson = await response.json();
      if (perime()) return;
      if (!geojson.features || geojson.features.length === 0) throw new Error("contour introuvable dans ADMIN EXPRESS");
      GeoMap.addTerritoryBoundary(geojson);
    } catch (err) {
      if (perime()) return;
      console.warn(`[geo-fetcher] boundary ${ctx.level}/${ctx.code}: ${err.message}`);
      if (window.GeoBanner) GeoBanner(`Le contour de « ${ctx.name || ctx.code} » n'a pas pu être chargé (${err.message}).`, "erreur", { label: "Réessayer", fn: () => this.loadTerritoryBoundary(ctx) });
    }
  },

  /**
   * Charge la couche de contexte admin.
   * En mode navigation : affiche les enfants de l'entité courante (filtre parent).
   * En mode initial : affiche toutes les entités du niveau dans la bbox.
   *
   * @param {string} level - "region" | "departement" | "epci" | "commune"
   * @param {number[]} bbox - viewport bbox
   * @param {object} [parent] - contexte parent { level, code, hierarchy }
   */
  async loadContextLayer(level, bbox, parent, freres) {
    const def = ADMINEXPRESS_TYPENAMES[level];
    if (!def) return;
    const jeton = GeoState.navToken, perime = () => jeton !== GeoState.navToken;
    const relancer = () => { GeoMap._ctxCurrentLevel = null; GeoMap._updateContextLayer(); };
    try {
      const propFields = level === "epci" ? "code_siren,nom_officiel,geometrie" : "code_insee,nom_officiel,geometrie";
      const pad = level === "region" ? 3 : level === "departement" ? 1 : 0.5, [minLon, minLat, maxLon, maxLat] = bbox;
      const parBbox = `BBOX(geometrie,${minLon - pad},${minLat - pad},${maxLon + pad},${maxLat + pad},'EPSG:4326')`;
      let cqlFilter = (parent && this._buildParentFilter(level, parent)) || parBbox;
      if (level === "epci" && parent && parent.level === "departement" && parent.code) {
        // département → EPCI : pas de clé directe ; on lit les SIREN d'EPCI portés par les communes du département (ADMIN EXPRESS)
        const pc = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeName: ADMINEXPRESS_TYPENAMES.commune.typename, outputFormat: "application/json", propertyName: "code_insee,codes_siren_des_epci", count: "2000", CQL_FILTER: `code_insee_du_departement='${parent.code}'` });
        const rc = await fetch(`${GPF_WFS_URL}?${pc}`); if (!rc.ok) throw new Error(`HTTP ${rc.status} (communes du département)`);
        const gc = await rc.json();
        if (typeof gc.numberMatched === "number" && gc.numberMatched > (gc.features || []).length) throw new Error("liste des communes du département tronquée par le serveur");
        const sirens = [...new Set((gc.features || []).flatMap((f) => String(f.properties?.codes_siren_des_epci || "").match(/\d{9}/g) || []))];
        if (!sirens.length) throw new Error("aucun EPCI déclaré par les communes du département");
        cqlFilter = `code_siren IN (${sirens.map((x) => `'${x}'`).join(",")})`;
      }
      const params = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeName: def.typename, outputFormat: "application/json", srsName: "EPSG:4326", count: level === "commune" ? "2000" : "300", propertyName: propFields, CQL_FILTER: cqlFilter });
      const response = await fetch(`${GPF_WFS_URL}?${params}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const geojson = await response.json();
      if (perime()) return;
      let feats = geojson.features || [];
      if (typeof geojson.numberMatched === "number" && geojson.numberMatched > feats.length && window.GeoBanner) {
        GeoBanner(`Limites ${ZOOM_TO_LEVEL_MAP[level].label} : ${feats.length} affichées sur ${geojson.numberMatched} (le serveur plafonne la réponse).`, "info");
      }
      if (freres) feats = feats.filter((f) => String(f.properties?.code_insee) !== String(freres));
      if (!feats.length) { if (parent && !freres && window.GeoBanner) GeoBanner(`Aucune limite ${ZOOM_TO_LEVEL_MAP[level].label} trouvée pour ce territoire.`, "info"); return; }
      geojson.features = feats.map((f, i) => ({ ...f, id: i }));
      GeoMap.addContextLayer(`_ctx_${level}`, geojson, ZOOM_TO_LEVEL_MAP[level]);
      if (parent && parent.level === "epci" && level === "commune" && !freres) this._parentsEpci(feats, parent.code, jeton);
    } catch (err) {
      if (perime()) return;
      console.warn(`[geo-fetcher] ctx layer ${level}: ${err.message}`);
      if (window.GeoBanner) GeoBanner(`Les limites ${ZOOM_TO_LEVEL_MAP[level].label} n'ont pas pu être chargées (${err.message}) : la navigation depuis la carte est indisponible.`, "erreur", { label: "Réessayer", fn: relancer });
    }
  },

  /**
   * Une intercommunalité n'a pas de parent unique : ses départements (et sa région si elle est unique) se déduisent
   * des communes qui la composent. Valeurs lues dans ADMIN EXPRESS, jamais supposées.
   */
  async _parentsEpci(communes, epci, jeton) {
    const deps = [...new Set(communes.map((f) => String(f.properties?.code_insee || "")).filter((c) => c.length === 5).map((c) => (/^9[78]/.test(c) ? c.slice(0, 3) : c.slice(0, 2))))].sort();
    if (!deps.length || deps.length > 10) return;
    const wfs = async (typename, cql, props) => {
      const p = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeName: typename, outputFormat: "application/json", propertyName: props, CQL_FILTER: cql });
      const r = await fetch(`${GPF_WFS_URL}?${p}`); if (!r.ok) throw new Error(`HTTP ${r.status}`); return (await r.json()).features || [];
    };
    let departements = deps.map((d) => ({ code: d, name: d })), region = null;
    try {
      const fd = await wfs(ADMINEXPRESS_TYPENAMES.departement.typename, `code_insee IN (${deps.map((d) => `'${d}'`).join(",")})`, "code_insee,nom_officiel,code_insee_de_la_region");
      if (fd.length) departements = fd.map((f) => ({ code: f.properties.code_insee, name: f.properties.nom_officiel })).sort((a, b) => (a.code < b.code ? -1 : 1));
      const regs = [...new Set(fd.map((f) => f.properties.code_insee_de_la_region))];
      if (regs.length === 1) { const fr = await wfs(ADMINEXPRESS_TYPENAMES.region.typename, `code_insee='${regs[0]}'`, "code_insee,nom_officiel"); if (fr[0]) region = { code: fr[0].properties.code_insee, name: fr[0].properties.nom_officiel }; }
    } catch (err) { console.warn("[geo-fetcher] parents EPCI:", err.message); }
    if (jeton !== GeoState.navToken) return;
    GeoState.epciParents = { epci, region, departements };
    if (window.ContextPanel && GeoState.context) ContextPanel.renderHierarchy(GeoState.context);
  },

  /**
   * Construit le filtre CQL par clé étrangère ADMINEXPRESS.
   * Chaque relation parent→enfant utilise la FK exacte du schéma.
   */
  _buildParentFilter(childLevel, parent) {
    const h = parent.hierarchy || {};
    const level = parent.level;

    switch (childLevel) {
      case "departement":
        // région → départements : FK departement.code_insee_de_la_region
        if (h.region?.code) return `code_insee_de_la_region='${h.region.code}'`;
        return null;

      case "commune":
        // EPCI → communes : FK commune.codes_siren_des_epci (multi-valué)
        if (level === "epci" && h.epci?.siren)
          return `codes_siren_des_epci LIKE '%${h.epci.siren}%'`;
        // département → communes : FK commune.code_insee_du_departement
        if (h.departement?.code)
          return `code_insee_du_departement='${h.departement.code}'`;
        return null;

      default:
        return null;
    }
  },

  /**
   * Charge une couche en ENTIER (inline, tuiles vérifiées ou WFS paginé vérifié) puis l'affiche d'un seul coup.
   * Lève une erreur au moindre manque. Retourne { sourceId, label, features, primaryFields, styleRecipe } ou null si la source est vide.
   */
  /**
   * Axe temporel : pour chaque champ de type date, ajoute une propriété numérique « <champ>__annee » (année sur 4 chiffres)
   * lue en ISO (AAAA-MM-JJ…) ou en français (JJ/MM/AAAA). Toute autre forme n'est PAS devinée : la valeur reste « sans valeur ».
   * Le champ dérivé est déclaré dans spec.fields (derivee: "annee") pour que le tableau et la carte le filtrent comme un nombre.
   */
  /**
   * Champs temporels, reconnus par leur CONTENU (jamais par le nom seul) : dates ISO, jj/mm/aaaa, « 9 septembre 2026 », « septembre 2026 », aaaa-mm ; une valeur
   * non lisible dans l'échantillon écarte le champ. Chaque champ-date reçoit un champ numérique dérivé `<champ>__t` (AAAA, AAAAMM ou AAAAMMJJ selon le pas),
   * le pas étant le plus fin lisible dont l'étendue reste jouable (jour ≤ 120 j, mois ≤ 12 ans, sinon année). Deux champs début/fin de même radical forment un intervalle.
   */
  _deriverAnnees(features, spec) {
    if (!Array.isArray(spec.fields)) { if (!Array.isArray(spec.primaryFields) || !spec.primaryFields.length) return; const exc = new Set(["geometry", "bbox", "id", "gml_id", "fid"]), ks = new Set(); for (const f of features.slice(0, 50)) for (const k of Object.keys(f.properties || {})) if (!exc.has(k)) ks.add(k); spec.fields = [...ks].slice(0, 12).map((k) => ({ key: k, label: k.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) })); }
    const MOIS = { janvier: 1, "février": 2, mars: 3, avril: 4, mai: 5, juin: 6, juillet: 7, "août": 8, septembre: 9, octobre: 10, novembre: 11, "décembre": 12 };
    const ok = (y, m, d) => y >= 1000 && y <= 2999 && m >= 1 && m <= 12 && (d == null || (d >= 1 && d <= 31)) ? { y, m, d } : null;
    const lire = (v) => {
      if (v == null || v === "") return null;
      if (v instanceof Date) return ok(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate());
      if (typeof v !== "string") return null;
      const t = v.trim(); let m;
      if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t))) return ok(+m[1], +m[2], +m[3]);
      if ((m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(t))) return ok(+m[3], +m[2], +m[1]);
      if ((m = /^(\d{1,2})(?:er)? ([^\d\s]+) (\d{4})$/.exec(t)) && MOIS[m[2].toLowerCase()]) return ok(+m[3], MOIS[m[2].toLowerCase()], +m[1]);
      if ((m = /^([^\d\s]+) (\d{4})$/.exec(t)) && MOIS[m[1].toLowerCase()]) return ok(+m[2], MOIS[m[1].toLowerCase()], null);
      if ((m = /^(\d{4})-(\d{2})$/.exec(t))) return ok(+m[1], +m[2], null);
      return null;
    };
    const jours = (x) => Date.UTC(x.y, x.m - 1, x.d || 1) / 86400000;
    // 1. champs-dates : déclarés « date », ou champs primaires dont TOUTES les valeurs renseignées (échantillon de 300) se lisent comme une date
    const cles = new Map(); for (const f of spec.fields) if (f.type === "date") cles.set(f.key, f);
    for (const k of spec.primaryFields || []) {
      const key = typeof k === "string" ? k : k?.key; if (!key || cles.has(key) || spec.fields.some((x) => x.key === key && x.type)) continue;
      let vus = 0, bon = true;
      for (const ft of features) { const v = (ft.properties || {})[key]; if (v == null || v === "") continue; if (lire(v) == null) { bon = false; break; } if (++vus >= 300) break; }
      if (bon && vus > 0) cles.set(key, { key, label: key.replace(/_/g, " "), type: "date" });
    }
    const info = new Map();
    for (const [key] of cles) {
      if (spec.fields.some((x) => x.key === key + "__t")) continue;
      let n = 0, res = "jour", lo = Infinity, hi = -Infinity; const lus = new Array(features.length);
      features.forEach((ft, i) => { const x = lire((ft.properties || {})[key]); lus[i] = x; if (!x) return; n++; if (x.d == null) res = res === "jour" ? "mois" : res; lo = Math.min(lo, jours(x)); hi = Math.max(hi, jours(x)); });
      if (n > 0) info.set(key, { n, res, lo, hi, lus });
    }
    // 2. intervalles : deux champs de même radical, l'un « début », l'autre « fin »
    const radical = (k, re) => (re.test(k) ? k.replace(re, "§") : null);
    const DEB = /(d[ée]but|deb|start|from)/i, FIN = /(fin|end|to)(?![a-z])/i;
    const paires = [];
    for (const kd of info.keys()) { const rd = radical(kd, DEB); if (!rd) continue; for (const kf of info.keys()) if (kf !== kd && radical(kf, FIN) === rd) { paires.push([kd, kf]); break; } }
    const enPaire = new Set(paires.flat());
    const choisirPas = (ks) => {
      const lo = Math.min(...ks.map((k) => info.get(k).lo)), hi = Math.max(...ks.map((k) => info.get(k).hi)), span = hi - lo;
      const fin = ks.every((k) => info.get(k).res === "jour") ? "jour" : "mois";
      return fin === "jour" && span <= 120 ? "jour" : span <= 12 * 366 ? "mois" : "annee";
    };
    const groupes = [...paires, ...[...info.keys()].filter((k) => !enPaire.has(k)).map((k) => [k])];
    for (const g of groupes) {
      const pas = choisirPas(g), code = (x) => (pas === "annee" ? x.y : pas === "mois" ? x.y * 100 + x.m : x.y * 10000 + x.m * 100 + x.d);
      for (const key of g) {
        const I = info.get(key); features.forEach((ft, i) => { const x = I.lus[i]; if (x) { const p = ft.properties || (ft.properties = {}); p[key + "__t"] = code(x); } });
        spec.fields.push({ key: key + "__t", label: `${cles.get(key).label || key} (${pas === "annee" ? "année" : pas})`, type: "number", derivee: "temps", pas, source: key, ...(g.length === 2 ? { intervalle: g[0] === key ? "debut" : "fin", avec: (g[0] === key ? g[1] : g[0]) + "__t" } : {}) });
      }
    }
  },

  /**
   * Lien par références : couche IRIS (IGN) → indicateurs INSEE (recensement, API Melodi) via le code IRIS.
   * La jointure est faite par le serveur (/liens/iris) qui rend aussi le rapport d'appariement et un contrôle de cohérence.
   * Valeur absente = « sans valeur », jamais zéro. Un échec n'est pas masqué : il est consigné dans liens.erreurs et affiché.
   */
  async _joindreIris(features, spec) {
    if (!/iris_ge/i.test(spec.typename || "")) return null;
    const liens = { source: "INSEE — recensement de la population (API Melodi)", communes: [], iris: 0, avec: 0, sans: [], controles: [], avertissements: [], erreurs: [], annee: null };
    const communes = [...new Set(features.map((f) => String(f.properties?.code_iris || "").slice(0, 5)).filter((c) => /^(\d{2}|2A|2B)\d{3}$/.test(c)))];
    liens.communes = communes;
    if (!communes.length) { liens.erreurs.push("Aucun code IRIS exploitable dans la couche : lien INSEE impossible."); liens.definitif = true; return liens; }
    if (communes.length > 30) { liens.erreurs.push(`La couche couvre ${communes.length} communes : les indicateurs INSEE ne sont joints que pour 30 communes au plus. Aucun n'est affiché.`); liens.definitif = true; return liens; }
    const lire = async (c) => {
      try {
        const r = await fetch(`/liens/iris?commune=${encodeURIComponent(c)}`);
        const j = await r.json().catch(() => null);
        if (!r.ok || !j || j.erreur) throw new Error((j && j.erreur) || `HTTP ${r.status}`);
        return { c, j };
      } catch (e) { return { c, erreur: String(e.message || e) }; }
    };
    const resultats = [];
    for (let i = 0; i < communes.length; i += 4) resultats.push(...(await Promise.all(communes.slice(i, i + 4).map(lire))));
    const parCode = new Map();
    for (const r of resultats) {
      if (r.erreur) { liens.erreurs.push(`Commune ${r.c} : ${r.erreur}`); continue; }
      const rap = r.j.rapport, an = r.j.sources?.population?.annee;
      if (an != null && (liens.annee == null || an > liens.annee)) liens.annee = an;
      liens.iris += rap.iris_ign; liens.avec += rap.avec_donnees;
      for (const s of rap.sans_donnees) liens.sans.push(s);
      if (rap.controle_population) liens.controles.push({ commune: r.c, ...rap.controle_population }); else liens.avertissements.push(`Commune ${r.c} : contrôle de population non effectué.`);
      for (const a of r.j.avertissements) if (!liens.avertissements.includes(a)) liens.avertissements.push(a);
      for (const i of r.j.iris) if (i.indicateurs) parCode.set(i.code_iris, i.indicateurs);
    }
    const CH = [
      ["insee_population", "Population", "population", null],
      ["insee_part_moins15", "Moins de 15 ans", "part_moins15", "%"],
      ["insee_part_plus65", "65 ans et plus", "part_plus65", "%"],
      ["insee_logements", "Logements", "logements", null],
      ["insee_part_vacants", "Logements vacants", "part_logements_vacants", "%"],
      ["insee_part_rp", "Résidences principales", "part_residences_principales", "%"],
    ];
    if (!Array.isArray(spec.fields)) spec.fields = [];
    for (const [cle, libelle, src, unite] of CH) {
      let n = 0;
      for (const ft of features) {
        const ind = parCode.get(String(ft.properties?.code_iris));
        const v = ind ? ind[src] : null;
        if (v != null) { (ft.properties || (ft.properties = {}))[cle] = v; n++; }
      }
      if (n > 0 && !spec.fields.some((x) => x.key === cle)) {
        spec.fields.push({ key: cle, label: `${libelle} (INSEE${liens.annee ? ", RP " + liens.annee : ""})`, type: "number", ...(unite ? { unit: unite } : {}), jointure: "insee_melodi" });
      }
    }
    return liens;
  },

  _contours: new Map(),
  /** Contour ADMIN EXPRESS de la commune (IGN), mis en cache ; une erreur est renvoyée telle quelle, jamais avalée. */
  async _contourCommune(code) { return this._contourTerritoire("commune", code); },
  /** Contour ADMIN EXPRESS d'un territoire (commune, epci, departement, region), mis en cache ; une erreur est renvoyée telle quelle. */
  async _contourTerritoire(niveau, code) {
    const def = ADMINEXPRESS_TYPENAMES[niveau]; if (!def) throw new Error(`niveau sans contour ADMIN EXPRESS : ${niveau}`);
    const cle = `${niveau}:${code}`;
    if (!this._contours.has(cle)) {
      const p = (async () => {
        const params = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeName: def.typename, outputFormat: "application/json", CQL_FILTER: `${def.field}='${code}'`, srsName: "EPSG:4326" });
        const r = await fetch(`${GPF_WFS_URL}?${params.toString()}`); if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const g = await r.json(); if (!g.features?.length) throw new Error("contour introuvable dans ADMIN EXPRESS"); return g.features;
      })();
      this._contours.set(cle, p); p.catch(() => this._contours.delete(cle));
    }
    return this._contours.get(cle);
  },
  _deNiveau(niveau) { return { commune: "de la commune", epci: "de l'EPCI", departement: "du département", region: "de la région" }[niveau] || "du territoire"; },
  _libNiveau(niveau) { return { commune: "la commune", epci: "l'EPCI", departement: "le département", region: "la région" }[niveau] || "le territoire"; },
  /** Point dans un polygone (anneau extérieur puis trous). */
  _dansPoly(x, y, rings) {
    const dans = (r) => { let c = false; for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const [xi, yi] = r[i], [xj, yj] = r[j]; if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c; } return c; };
    if (!dans(rings[0])) return false;
    for (let k = 1; k < rings.length; k++) if (dans(rings[k])) return false;
    return true;
  },
  /** Segments [a,b] et [c,d] sécants (y compris contact). */
  _segCroise(a, b, c, d) {
    const o = (p, q, r) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
    const sur = (p, q, r) => Math.min(p[0], q[0]) <= r[0] && r[0] <= Math.max(p[0], q[0]) && Math.min(p[1], q[1]) <= r[1] && r[1] <= Math.max(p[1], q[1]);
    const o1 = o(a, b, c), o2 = o(a, b, d), o3 = o(c, d, a), o4 = o(c, d, b);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
    return (o1 === 0 && sur(a, b, c)) || (o2 === 0 && sur(a, b, d)) || (o3 === 0 && sur(c, d, a)) || (o4 === 0 && sur(c, d, b));
  },
  /** Position d'une géométrie par rapport au contour : "dedans" (entièrement), "cheval" (en partie), "hors" (aucun point commun). Décision exacte sur les coordonnées. */
  _positionContour(g, polys, bboxC, aretes) {
    if (!g) return null;
    const anneaux = []; // [anneau, estSurface]
    const rec = (t, c) => {
      if (t === "Point") anneaux.push([[c], false]);
      else if (t === "MultiPoint") c.forEach((q) => anneaux.push([[q], false]));
      else if (t === "LineString") anneaux.push([c, false]);
      else if (t === "MultiLineString") c.forEach((l) => anneaux.push([l, false]));
      else if (t === "Polygon") c.forEach((r, i) => anneaux.push([r, i === 0 ? "ext" : "trou"]));
      else if (t === "MultiPolygon") c.forEach((pl) => pl.forEach((r, i) => anneaux.push([r, i === 0 ? "ext" : "trou"])));
      else if (t === "GeometryCollection") throw new Error("GeometryCollection non gérée par le contrôle de contour");
      else throw new Error(`type de géométrie « ${t} » non géré par le contrôle de contour`);
    };
    rec(g.type, g.coordinates);
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const [r] of anneaux) for (const q of r) { if (q[0] < minx) minx = q[0]; if (q[0] > maxx) maxx = q[0]; if (q[1] < miny) miny = q[1]; if (q[1] > maxy) maxy = q[1]; }
    if (maxx < bboxC[0] || minx > bboxC[2] || maxy < bboxC[1] || miny > bboxC[3]) return "hors";
    let dedans = 0, total = 0;
    for (const [r] of anneaux) for (const q of r) { total++; if (polys.some((pl) => this._dansPoly(q[0], q[1], pl))) dedans++; }
    if (dedans > 0 && dedans < total) return "cheval";
    // arêtes qui coupent le contour
    for (const [r] of anneaux) for (let i = 0; i + 1 < r.length; i++) {
      const a = r[i], b = r[i + 1];
      if (Math.max(a[0], b[0]) < bboxC[0] || Math.min(a[0], b[0]) > bboxC[2] || Math.max(a[1], b[1]) < bboxC[1] || Math.min(a[1], b[1]) > bboxC[3]) continue;
      for (const [c, d] of aretes) if (this._segCroise(a, b, c, d)) return dedans === total ? "cheval" : "cheval";
    }
    if (dedans === total) return "dedans";
    // aucun sommet dedans, aucun croisement : la surface peut contenir tout le contour
    if (anneaux.some(([, k]) => k === "ext")) {
      const q = polys[0][0][0];
      const poly = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
      if (poly.some((pl) => this._dansPoly(q[0], q[1], pl))) return "cheval";
    }
    return "hors";
  },
  /** Contrôle strict d'appartenance au contour ADMIN EXPRESS de la commune. Points inline : hors contour = écarté. Couches d'urbanisme WFS (GPU) : le filtre serveur est une emprise rectangulaire (déborde sur les communes voisines) ; seuls les objets sans AUCUN point commun avec la commune sont écartés (listés), ceux « à cheval » sont gardés et comptés. */
  async _controleContour(features, spec) {
    const ctx = GeoState.context;
    const wfs = spec.type !== "inline";
    const gpu = wfs && /^wfs_(du|sup):/.test(spec.typename || "");
    if (!ctx || !["commune", "epci", "departement", "region"].includes(ctx.level) || !ctx.code) return { features, controle: null };
    // Trop d'objets pour décider : aucune décision d'appartenance, déclaré (jamais présenté comme exact)
    if (wfs && spec.exact?.indisponible) return { features, controle: { fait: false, niveau: ctx.level, erreur: `${spec.exact.raison}. Les objets affichés sont ceux du rectangle englobant ${this._deNiveau(ctx.level)} et peuvent déborder sur les territoires voisins` } };
    if (wfs && spec.exact) return this._appliquerExact(features, spec);
    // Points inline : commune seulement ; couches WFS : décision exacte du serveur (ci-dessus), le navigateur ne décide seul que pour le GPU en commune et pour le recoupement
    if (!wfs && (ctx.level !== "commune" || !features.some((f) => f.geometry?.type === "Point"))) return { features, controle: null };
    if (wfs && !gpu && !spec._recoupe) return { features, controle: null };
    if (gpu && ctx.level !== "commune" && !spec._recoupe) return { features, controle: null };
    let contour;
    try { contour = await this._contourTerritoire(ctx.level, ctx.code); }
    catch (e) { return { features, controle: { fait: false, erreur: e.message || String(e) } }; }
    const polys = contour.flatMap((f) => f.geometry?.type === "Polygon" ? [f.geometry.coordinates] : f.geometry?.type === "MultiPolygon" ? f.geometry.coordinates : []);
    if (!polys.length) return { features, controle: { fait: false, erreur: "contour sans polygone" } };
    const cle = (spec.fields || []).find((f) => f.primary && f.type !== "geometry")?.key || (typeof spec.primaryFields?.[0] === "string" ? spec.primaryFields[0] : spec.primaryFields?.[0]?.key);
    const gardes = [], hors = [], voisines = []; let cheval = 0;
    if (!wfs) {
      features.forEach((f, i) => {
        if (f.geometry?.type !== "Point") { gardes.push(f); return; }
        const [x, y] = f.geometry.coordinates;
        if (polys.some((r) => this._dansPoly(x, y, r))) { gardes.push(f); return; }
        hors.push({ ligne: i, id: cle && f.properties?.[cle] != null ? String(f.properties[cle]) : null, raison: "position hors du contour de la commune (ADMIN EXPRESS, IGN)", valeur: `${y},${x}` });
      });
    } else {
      const aretes = []; let bx = [1e9, 1e9, -1e9, -1e9];
      for (const pl of polys) for (const r of pl) for (let i = 0; i + 1 < r.length; i++) { aretes.push([r[i], r[i + 1]]); const q = r[i]; if (q[0] < bx[0]) bx[0] = q[0]; if (q[1] < bx[1]) bx[1] = q[1]; if (q[0] > bx[2]) bx[2] = q[0]; if (q[1] > bx[3]) bx[3] = q[1]; }
      features.forEach((f, i) => {
        const ident = { ligne: i, id: String(spec._cle === "@id" ? f.id : (f.properties?.[spec._cle || "gid"] ?? f.id ?? i)), libelle: f.properties?.libelle ?? f.properties?.nom_site ?? f.properties?.nom ?? f.properties?.toponyme ?? null };
        if (!f.geometry) { voisines.push({ ...ident, raison: "objet sans géométrie : appartenance au territoire non vérifiable" }); return; }
        const pos = this._positionContour(f.geometry, polys, bx, aretes);
        if (pos === "hors") { voisines.push({ ...ident, raison: "aucun point commun avec le contour du territoire (ADMIN EXPRESS, IGN)" }); return; }
        if (pos === "cheval") cheval++;
        gardes.push(f);
      });
    }
    if (hors.length) { spec.ecartees = (spec.ecartees || 0) + hors.length; spec.anomalies = [...(spec.anomalies || []), ...hors]; }
    return { features: gardes, controle: { fait: true, niveau: ctx.level, hors: hors.length, lus: features.length, cheval, ...(wfs ? { voisines } : {}) } };
  },
  /**
   * Décision d'appartenance prise par le SERVEUR (jsts, sur toutes les pages lues avec géométries) : on applique sa liste d'écartés par
   * identifiant (gid). Contrôles : le navigateur doit avoir lu exactement autant d'objets que le serveur ; autant de retenus que
   * annoncé ; et, quand la couche est de taille raisonnable (≤ 5 000 objets, ou ponctuelle ≤ 100 000), le navigateur refait sa propre
   * décision indépendante, qui doit donner la même liste d'écartés — sinon erreur, rien n'est affiché.
   */
  async _appliquerExact(features, spec) {
    const ex = spec.exact;
    if (features.length !== ex.lus) throw new Error(`écart avec la lecture du serveur : ${features.length.toLocaleString("fr-FR")} objets reçus, ${ex.lus.toLocaleString("fr-FR")} lus par le serveur`);
    const ctx = GeoState.context, niv = ctx?.level || ex.niveau, lib = this._libNiveau(niv);
    if (ex.niveau && ex.niveau !== niv) throw new Error(`décision du serveur pour ${ex.niveau}, navigation sur ${niv} : résultat refusé`);
    const cleDe = (f) => String(ex.cle === "@id" ? f.id : f.properties?.[ex.cle || "gid"]);
    const hors = new Set(ex.ecartes.map((e) => String(e.gid)));
    const gardes = features.filter((f) => !hors.has(cleDe(f)));
    if (gardes.length !== ex.gardes) throw new Error(`écart avec la décision du serveur : ${gardes.length.toLocaleString("fr-FR")} objets retenus, ${ex.gardes.toLocaleString("fr-FR")} annoncés`);
    const ponctuelle = features.every((f) => f.geometry?.type === "Point" || f.geometry?.type === "MultiPoint");
    // Colonne « Position / commune » : aucune mise à l'écart silencieuse, les objets à cheval restent repérables et filtrables
    const cheval = new Set((ex.chevalGids || []).map(String));
    if (cheval.size !== ex.cheval) throw new Error(`incohérence serveur : ${cheval.size} identifiants à cheval pour ${ex.cheval} annoncés`);
    const dedans = `dans ${lib}`;
    for (const f of gardes) { f.properties = f.properties || {}; f.properties.position_territoire = cheval.has(cleDe(f)) ? "à cheval sur la limite" : dedans; }
    spec.fields = [...(spec.fields || []).filter((x) => x.key !== "position_territoire"), { key: "position_territoire", label: `Position / ${niv === "epci" ? "EPCI" : niv === "departement" ? "département" : niv === "region" ? "région" : "commune"}`, type: "enum", primary: false }];
    let recoupe = false;
    // Recoupement indépendant du navigateur : seulement si le coût (sommets des objets × arêtes du contour) reste raisonnable
    let cout = Infinity;
    if (features.length <= (ponctuelle ? 100000 : 5000)) {
      const nbS = (c) => (typeof c[0] === "number" ? 1 : c.reduce((t, x) => t + nbS(x), 0));
      let sommets = 0; for (const f of features) if (f.geometry?.coordinates) sommets += nbS(f.geometry.coordinates);
      let aretes = 0; try { const ct = await this._contourTerritoire(niv, ctx.code); for (const g of ct) if (g.geometry?.coordinates) aretes += nbS(g.geometry.coordinates); } catch { aretes = Infinity; }
      cout = sommets * aretes;
    }
    if (cout <= 4e8) {
      const copie = { ...spec, exact: null, _recoupe: true, _cle: ex.cle, ecartees: 0, anomalies: [] };
      const c = await this._controleContour(features, copie);
      if (!c.controle?.fait) throw new Error(`recoupement du navigateur impossible : ${c.controle?.erreur || "inconnu"}`);
      const siens = new Set((c.controle.voisines || []).map((v) => String(v.id)));
      const manque = [...hors].filter((g) => !siens.has(g)), enPlus = [...siens].filter((g) => !hors.has(g));
      if (manque.length || enPlus.length) throw new Error(`désaccord serveur / navigateur sur l'appartenance au territoire (${lib}) : ${manque.length} écarté(s) par le serveur seulement (ex. gid ${manque.slice(0, 3).join(", ")}), ${enPlus.length} par le navigateur seulement (ex. gid ${enPlus.slice(0, 3).join(", ")}) : résultat refusé`);
      if (c.controle.cheval !== ex.cheval) throw new Error(`désaccord serveur / navigateur sur les objets à cheval : ${ex.cheval} contre ${c.controle.cheval} : résultat refusé`);
      recoupe = true;
    }
    return { features: gardes, controle: { fait: true, niveau: niv, hors: ex.ecartes.length, lus: ex.lus, cheval: ex.cheval, voisines: ex.ecartes.map((e) => ({ id: e.gid, libelle: e.libelle, raison: e.raison })), decision: "serveur (jsts)", recoupe } };
  },
  async _fetchAndDisplay(sourceId, spec) {
    const styleRecipe = spec.styleRecipe || null;
    const meta = { label: spec.label || sourceId, primaryFields: spec.primaryFields || [], theme: spec.theme || null, styleRecipe };
    // Couche trop volumineuse pour une décision d'appartenance exacte : on ne charge rien (ni échantillon, ni total approximatif)
    if (spec.type !== "inline" && spec.exact?.indisponible) throw new Error(`${spec.exact.rectangle.toLocaleString("fr-FR")} objets dans le rectangle englobant ${this._deNiveau(spec.exact.niveau)} (au-delà de la limite de contrôle exact) : trop volumineux pour être affiché ici sans résultat faux. Choisir un territoire plus petit (commune) ; une vue agrégée n'est pas encore disponible.`);
    let features;
    if (spec.type === "inline") features = spec.inlineGeojson?.features || [];
    else if (spec.tiled) features = await this._fetchTiled(sourceId, spec);
    else features = await this._fetchAllWfs(sourceId, spec);
    if (spec.type === "inline" && !this.inclureSansPosition) features = features.filter((f) => f.geometry); // jamais d'index décalé : carte et tableau reçoivent la même liste
    if (!features.length) return null;
    const ctr = await this._controleContour(features, spec); features = ctr.features; const controle = ctr.controle;
    if (!features.length) return null;
    this._deriverAnnees(features, spec);
    const liens = await this._joindreIris(features, spec);
    GeoMap.addGeoJsonLayer(sourceId, { type: "FeatureCollection", features }, spec.style || {}, meta);
    return { sourceId, label: meta.label, features, primaryFields: meta.primaryFields, styleRecipe, liens, ecartees: spec.ecartees || 0, anomalies: spec.anomalies || [], controle };
  },

  /**
   * Lecture par tuiles (serveur : cache, filtre de territoire exact). Contrôles : chaque tuile complète, bien celle demandée,
   * même territoire, comptes cohérents ; aucun identifiant en collision ; total final = décompte annoncé par le serveur.
   */
  async _fetchTiled(sourceId, spec) {
    const t = spec.tiled, label = spec.label || sourceId, n = 2 ** t.z;
    const tx = (lon) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
    const ty = (lat) => Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n)));
    const liste = []; for (let x = tx(t.bbox[0]); x <= tx(t.bbox[2]); x++) for (let y = ty(t.bbox[3]); y <= ty(t.bbox[1]); y++) liste.push([x, y]);
    const props = (spec.fields || []).filter((f) => !f.derivee).map((f) => f.key).filter((k) => k !== "geometrie").join(",");
    const parId = new Map(); let fait = 0, brut = 0, k = 0;
    this._progress(sourceId, `${label} : 0 / ${liste.length} tuiles`);
    const ouvrier = async () => {
      for (;;) {
        const i = k++; if (i >= liste.length) return;
        const [x, y] = liste[i];
        const d = await this._fetchJson(`/tiles/${t.jeu}/${t.z}/${x}/${y}.json?niveau=${t.niveau}&code=${encodeURIComponent(t.code)}&props=${encodeURIComponent(props)}`);
        const m = d.meta;
        if (!m || m.complete !== true) throw new Error(`tuile ${x}/${y} non certifiée complète`);
        if (m.z !== t.z || m.x !== x || m.y !== y) throw new Error(`tuile reçue (${m.z}/${m.x}/${m.y}) différente de celle demandée (${t.z}/${x}/${y})`);
        if (m.territoire !== `${t.niveau}:${t.code}`) throw new Error(`tuile ${x}/${y} : territoire ${m.territoire} au lieu de ${t.niveau}:${t.code}`);
        if (!Array.isArray(d.features) || d.features.length !== m.n) throw new Error(`tuile ${x}/${y} : ${d.features?.length} objets reçus pour ${m.n} annoncés`);
        for (const f of d.features) {
          const prev = parId.get(f.id);
          if (prev && prev.properties.cleabs !== f.properties.cleabs) throw new Error(`collision d'identifiant : ${prev.properties.cleabs} / ${f.properties.cleabs}`);
          parId.set(f.id, f);
        }
        brut += d.features.length; fait++;
        this._progress(sourceId, `${label} : ${fait} / ${liste.length} tuiles · ${parId.size.toLocaleString("fr-FR")} objets`);
      }
    };
    await Promise.all(Array.from({ length: 6 }, ouvrier));
    if (fait !== liste.length) throw new Error(`${fait} tuiles lues sur ${liste.length}`);
    if (t.expected != null && parId.size !== t.expected) throw new Error(`écart avec le décompte du serveur : ${parId.size.toLocaleString("fr-FR")} objets reçus, ${t.expected.toLocaleString("fr-FR")} attendus`);
    const features = [...parId.values()].sort((a, b) => a.id - b.id);
    features.forEach((f, i) => { f.id = i; }); // identifiant = rang (survol tableau <-> carte)
    return features;
  },

  /**
   * Lecture WFS paginée COMPLÈTE : le nombre annoncé (numberMatched) doit être atteint, sans doublon ; sinon erreur (jamais de
   * troncature silencieuse). Les pages sont triées par `spec.sortBy` quand la source en déclare un.
   */
  async _fetchAllWfs(sourceId, spec) {
    const label = spec.label || sourceId, pageSize = spec.pageSize || spec.maxFeatures || 1000;
    const url = (debut) => { const u = new URL(this._buildWfsUrl(spec, debut, pageSize)); const tri = spec.sortBy || (/^BDTOPO_V3:/.test(spec.typename || "") ? "cleabs" : /^wfs_(du:(zone_urba|prescription_)|sup:)/.test(spec.typename || "") ? "gid" : /^patrinat_/.test(spec.typename || "") ? "id_local" : null); /* sans tri total, la pagination WFS peut répéter/omettre des objets d'une page à l'autre : BD TOPO a un identifiant unique (cleabs) */ if (tri) u.searchParams.set("sortBy", tri); return u.toString(); };
    const prepare = (page) => (spec.nativeCrs && spec.nativeCrs !== "EPSG:4326" ? this._reproject(page, spec.nativeCrs) : page);
    const p0 = await this._fetchJson(url(0));
    const attendu = p0.numberMatched ?? p0.totalFeatures;
    if (!Number.isFinite(attendu)) throw new Error("le service n'annonce pas le nombre total d'objets : complétude invérifiable");
    const parId = new Map(), toutes = [];
    const ajoute = (page) => { for (const f of prepare(page).features || []) { toutes.push(f); if (f.id != null) parId.set(f.id, 1); } };
    ajoute(p0);
    this._progress(sourceId, `${label} : ${toutes.length.toLocaleString("fr-FR")} / ${attendu.toLocaleString("fr-FR")}`);
    for (let debut = p0.features.length; toutes.length < attendu; debut = toutes.length) {
      const p = await this._fetchJson(url(debut));
      if (!p.features?.length) throw new Error(`page vide avant la fin (${toutes.length}/${attendu})`);
      ajoute(p);
      this._progress(sourceId, `${label} : ${toutes.length.toLocaleString("fr-FR")} / ${attendu.toLocaleString("fr-FR")}`);
    }
    if (toutes.length !== attendu) throw new Error(`${toutes.length} objets reçus pour ${attendu} annoncés`);
    if (toutes[0]?.id != null && parId.size !== toutes.length) throw new Error(`${toutes.length - parId.size} doublon(s) dans les pages (pagination instable) : résultat refusé`);
    return toutes;
  },

  /**
   * Construit l'URL WFS GetFeature depuis un LayerSpec.
   */
  _buildWfsUrl(spec, startIndex = 0, count) {
    const params = new URLSearchParams({
      service: "WFS",
      version: "2.0.0",
      request: "GetFeature",
      typeName: spec.typename,
      outputFormat: "application/json",
      CQL_FILTER: spec.cqlFilter,
      count: String(count || spec.maxFeatures || 1000),
      srsName: spec.srsName || "EPSG:4326",
    });
    if (startIndex > 0) params.set("startIndex", String(startIndex));
    return `${spec.wfsUrl}?${params.toString()}`;
  },

  /**
   * Reprojette un GeoJSON de EPSG:2154 (Lambert-93) vers EPSG:4326.
   */
  _reproject(geojson, fromCrs) {
    if (fromCrs !== "EPSG:2154") {
      console.warn(`[geo-fetcher] Reprojection non supportée pour ${fromCrs}`);
      return geojson;
    }

    const firstCoord = this._getFirstCoord(geojson);
    if (!firstCoord || firstCoord[0] < 10000) {
      return geojson;
    }

    return this._transformCoords(geojson, (coord) => {
      return lambert93ToWgs84(coord[0], coord[1]);
    });
  },

  _getFirstCoord(geojson) {
    const features = geojson.features || [];
    if (features.length === 0) return null;
    const geom = features[0].geometry;
    if (!geom) return null;
    let coords = geom.coordinates;
    while (Array.isArray(coords[0])) coords = coords[0];
    return coords;
  },

  _transformCoords(geojson, fn) {
    const result = JSON.parse(JSON.stringify(geojson));
    for (const feature of result.features || []) {
      if (feature.geometry) {
        feature.geometry.coordinates = this._walkCoords(feature.geometry.coordinates, fn);
      }
    }
    return result;
  },

  _walkCoords(coords, fn) {
    if (typeof coords[0] === "number") return fn(coords);
    return coords.map((c) => this._walkCoords(c, fn));
  },
};

/**
 * Lambert-93 (EPSG:2154) → WGS84 (EPSG:4326).
 * Approximation suffisante pour l'affichage cartographique (~10m).
 */
function lambert93ToWgs84(x, y) {
  const n = 0.7256077650;
  const C = 11754255.426;
  const Xs = 700000.0;
  const Ys = 12655612.050;
  const e = 0.0818191910428;

  const R = Math.sqrt((x - Xs) * (x - Xs) + (Ys - y) * (Ys - y));
  const gamma = Math.atan((x - Xs) / (Ys - y));
  const latIso = -Math.log(R / C) / n;
  const lon = gamma / n + (3 * Math.PI) / 180;

  let lat = 2 * Math.atan(Math.exp(latIso)) - Math.PI / 2;
  for (let i = 0; i < 5; i++) {
    lat = 2 * Math.atan(Math.exp(latIso + e * Math.atanh(e * Math.sin(lat)))) - Math.PI / 2;
  }

  return [lon * (180 / Math.PI), lat * (180 / Math.PI)];
}

if (!Math.atanh) {
  Math.atanh = function (x) { return Math.log((1 + x) / (1 - x)) / 2; };
}

window.GeoFetcher = GeoFetcher;
