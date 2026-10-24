/**
 * Territoire préparé : test d'intersection EXACT entre une emprise (commune, EPCI, département…) et un objet.
 *
 * Pourquoi : l'emprise rectangulaire (BBOX) d'une commune contient des objets des communes voisines ; les compter ou les
 * afficher « dans la commune » serait faux. Règle retenue : un objet est dans le territoire s'il l'INTERSECTE
 * (au sens OGC : au moins un point commun, bord compris). Un bâtiment à cheval sur la limite compte donc des deux côtés.
 *
 * Méthode : grille grossière (cellule entièrement dedans / dehors / sur la limite) pour décider vite, puis, pour les
 * objets proches de la limite, test exact : un sommet dans le polygone (règle pair-impair, trous compris) ou une arête
 * qui coupe une arête de la limite. Les arêtes de la limite sont rangées par bandes horizontales.
 * Non géré (sans conséquence pour des bâtiments) : un territoire entièrement contenu dans l'objet testé.
 */
type Pt = [number, number];
const WFS = "https://data.geopf.fr/wfs/ows";
const TYPENAMES: Record<string, { typename: string; field: string }> = {
  commune: { typename: "ADMINEXPRESS-COG.LATEST:commune", field: "code_insee" },
  departement: { typename: "ADMINEXPRESS-COG.LATEST:departement", field: "code_insee" },
  region: { typename: "ADMINEXPRESS-COG.LATEST:region", field: "code_insee" },
  epci: { typename: "ADMINEXPRESS-COG.LATEST:epci", field: "code_siren" },
};

export class Territoire {
  private ex: Float64Array; private ey: Float64Array; private fx: Float64Array; private fy: Float64Array; // arêtes (x1,y1)->(x2,y2)
  private bandes: number[][]; private nb: number; private h: number;
  readonly bbox: [number, number, number, number];
  private gn = 0; private gx0 = 0; private gy0 = 0; private gw = 0; private gh = 0; private cls!: Uint8Array; // 0 dehors, 1 dedans, 2 limite
  readonly sommets: number;
  /** Premier sommet de chaque anneau (extérieurs et trous) : points de test pour « un objet surfacique contient-il une partie du territoire ». */
  readonly premiers: Pt[] = [];

  constructor(polygones: Pt[][][]) {
    for (const p of polygones) for (const r of p) if (r.length) this.premiers.push(r[0]);
    const E: number[][] = []; let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of polygones) for (const r of p) for (let i = 0; i + 1 < r.length; i++) {
      const [ax, ay] = r[i], [bx, by] = r[i + 1];
      E.push([ax, ay, bx, by]);
      x0 = Math.min(x0, ax); x1 = Math.max(x1, ax); y0 = Math.min(y0, ay); y1 = Math.max(y1, ay);
    }
    this.sommets = E.length; this.bbox = [x0, y0, x1, y1];
    this.ex = Float64Array.from(E, (e) => e[0]); this.ey = Float64Array.from(E, (e) => e[1]);
    this.fx = Float64Array.from(E, (e) => e[2]); this.fy = Float64Array.from(E, (e) => e[3]);
    this.nb = Math.max(16, Math.min(2048, Math.round(Math.sqrt(E.length) * 2))); this.h = (y1 - y0) / this.nb || 1;
    this.bandes = Array.from({ length: this.nb }, () => [] as number[]);
    E.forEach((e, i) => {
      const lo = this.bande(Math.min(e[1], e[3])), hi = this.bande(Math.max(e[1], e[3]));
      for (let b = lo; b <= hi; b++) this.bandes[b].push(i);
    });
    this.construireGrille();
  }
  static depuisGeoJSON(g: any): Territoire {
    const polys: Pt[][][] = g.type === "Polygon" ? [g.coordinates] : g.type === "MultiPolygon" ? g.coordinates : [];
    if (!polys.length) throw new Error(`géométrie de territoire non surfacique (${g?.type})`);
    return new Territoire(polys);
  }
  private bande(y: number) { return Math.min(this.nb - 1, Math.max(0, Math.floor((y - this.bbox[1]) / this.h))); }

  /** Pair-impair sur toutes les anneaux (les trous et multipolygones disjoints sont ainsi corrects). */
  dedans(x: number, y: number): boolean {
    if (x < this.bbox[0] || x > this.bbox[2] || y < this.bbox[1] || y > this.bbox[3]) return false;
    let c = false;
    for (const i of this.bandes[this.bande(y)]) {
      const y1 = this.ey[i], y2 = this.fy[i];
      if ((y1 > y) !== (y2 > y) && x < ((this.fx[i] - this.ex[i]) * (y - y1)) / (y2 - y1) + this.ex[i]) c = !c;
    }
    return c;
  }
  private static orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) { return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax); }
  private static coupe(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number): boolean {
    const o1 = Territoire.orient(ax, ay, bx, by, cx, cy), o2 = Territoire.orient(ax, ay, bx, by, dx, dy);
    const o3 = Territoire.orient(cx, cy, dx, dy, ax, ay), o4 = Territoire.orient(cx, cy, dx, dy, bx, by);
    if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return true;
    const sur = (px: number, py: number, qx: number, qy: number, rx: number, ry: number) =>
      Math.min(px, qx) <= rx && rx <= Math.max(px, qx) && Math.min(py, qy) <= ry && ry <= Math.max(py, qy);
    return (o1 === 0 && sur(ax, ay, bx, by, cx, cy)) || (o2 === 0 && sur(ax, ay, bx, by, dx, dy)) ||
           (o3 === 0 && sur(cx, cy, dx, dy, ax, ay)) || (o4 === 0 && sur(cx, cy, dx, dy, bx, by));
  }
  private segmentCoupeLimite(ax: number, ay: number, bx: number, by: number): boolean {
    const lo = this.bande(Math.min(ay, by)), hi = this.bande(Math.max(ay, by));
    for (let b = lo; b <= hi; b++) for (const i of this.bandes[b]) {
      if (Math.max(ax, bx) < Math.min(this.ex[i], this.fx[i]) || Math.min(ax, bx) > Math.max(this.ex[i], this.fx[i])) continue;
      if (Territoire.coupe(ax, ay, bx, by, this.ex[i], this.ey[i], this.fx[i], this.fy[i])) return true;
    }
    return false;
  }

  private construireGrille() {
    const [x0, y0, x1, y1] = this.bbox; const n = 192;
    this.gn = n; this.gx0 = x0; this.gy0 = y0; this.gw = (x1 - x0) / n || 1; this.gh = (y1 - y0) / n || 1;
    const cls = new Uint8Array(n * n);
    for (let i = 0; i < this.ex.length; i++) {
      const a = Math.min(this.ex[i], this.fx[i]), b = Math.max(this.ex[i], this.fx[i]), c = Math.min(this.ey[i], this.fy[i]), d = Math.max(this.ey[i], this.fy[i]);
      const i0 = Math.max(0, Math.floor((a - x0) / this.gw)), i1 = Math.min(n - 1, Math.floor((b - x0) / this.gw));
      const j0 = Math.max(0, Math.floor((c - y0) / this.gh)), j1 = Math.min(n - 1, Math.floor((d - y0) / this.gh));
      const long = (i1 - i0 + 1) * (j1 - j0 + 1) > 16;
      for (let j = j0; j <= j1; j++) for (let k = i0; k <= i1; k++) {
        if (long) { // arête longue : ne marque que les cellules réellement traversées
          const rx0 = x0 + k * this.gw, ry0 = y0 + j * this.gh, rx1 = rx0 + this.gw, ry1 = ry0 + this.gh;
          const traverse = this.dedansRect(i, rx0, ry0, rx1, ry1);
          if (!traverse) continue;
        }
        cls[j * n + k] = 2;
      }
    }
    for (let j = 0; j < n; j++) for (let k = 0; k < n; k++) if (cls[j * n + k] !== 2) cls[j * n + k] = this.dedans(x0 + (k + 0.5) * this.gw, y0 + (j + 0.5) * this.gh) ? 1 : 0;
    this.cls = cls;
  }
  private dedansRect(i: number, x0: number, y0: number, x1: number, y1: number): boolean {
    const ax = this.ex[i], ay = this.ey[i], bx = this.fx[i], by = this.fy[i];
    if ((ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1) || (bx >= x0 && bx <= x1 && by >= y0 && by <= y1)) return true;
    return Territoire.coupe(ax, ay, bx, by, x0, y0, x1, y0) || Territoire.coupe(ax, ay, bx, by, x1, y0, x1, y1) ||
           Territoire.coupe(ax, ay, bx, by, x1, y1, x0, y1) || Territoire.coupe(ax, ay, bx, by, x0, y1, x0, y0);
  }

  /** Classe l'enveloppe d'un objet : 0 = entièrement hors du territoire, 1 = entièrement dedans sans toucher la limite, 2 = indécis. Décision certaine pour 0 et 1 (aucune arête de la limite dans les cellules concernées). */
  classeEnveloppe(x0: number, y0: number, x1: number, y1: number): 0 | 1 | 2 {
    if (x1 < this.bbox[0] || x0 > this.bbox[2] || y1 < this.bbox[1] || y0 > this.bbox[3]) return 0;
    const n = this.gn, i0 = Math.floor((x0 - this.gx0) / this.gw), i1 = Math.floor((x1 - this.gx0) / this.gw);
    const j0 = Math.floor((y0 - this.gy0) / this.gh), j1 = Math.floor((y1 - this.gy0) / this.gh);
    if (!(i0 >= 0 && j0 >= 0 && i1 < n && j1 < n)) return 2;
    let tous0 = true, tous1 = true;
    for (let j = j0; j <= j1 && (tous0 || tous1); j++) for (let k = i0; k <= i1; k++) { const c = this.cls[j * n + k]; if (c !== 0) tous0 = false; if (c !== 1) tous1 = false; }
    return tous0 ? 0 : tous1 ? 1 : 2;
  }
  /** Contact d'un segment avec la limite : 0 = aucun ; 1 = croisement franc (passe d'un côté à l'autre) ; 2 = contact sans croisement franc (touche, colinéaire, extrémité sur la limite). */
  contactSegment(ax: number, ay: number, bx: number, by: number): 0 | 1 | 2 {
    let res: 0 | 1 | 2 = 0;
    const lo = this.bande(Math.min(ay, by)), hi = this.bande(Math.max(ay, by));
    for (let b = lo; b <= hi; b++) for (const i of this.bandes[b]) {
      const cx = this.ex[i], cy = this.ey[i], dx = this.fx[i], dy = this.fy[i];
      if (Math.max(ax, bx) < Math.min(cx, dx) || Math.min(ax, bx) > Math.max(cx, dx)) continue;
      const o1 = Territoire.orient(ax, ay, bx, by, cx, cy), o2 = Territoire.orient(ax, ay, bx, by, dx, dy);
      const o3 = Territoire.orient(cx, cy, dx, dy, ax, ay), o4 = Territoire.orient(cx, cy, dx, dy, bx, by);
      if (((o1 > 0 && o2 < 0) || (o1 < 0 && o2 > 0)) && ((o3 > 0 && o4 < 0) || (o3 < 0 && o4 > 0))) return 1;
      if (res === 0 && Territoire.coupe(ax, ay, bx, by, cx, cy, dx, dy)) res = 2;
    }
    return res;
  }
  /** Le point est-il sur la limite du territoire ? */
  surLimite(x: number, y: number): boolean { return this.contactSegment(x, y, x, y) !== 0; }

  /** L'objet (Polygon / MultiPolygon / LineString / Point…) intersecte-t-il le territoire ? */
  intersecte(geom: any): boolean {
    const anneaux: Pt[][] = [];
    const ajoute = (g: any) => {
      switch (g?.type) {
        case "Point": anneaux.push([g.coordinates]); break;
        case "MultiPoint": case "LineString": anneaux.push(g.coordinates); break;
        case "MultiLineString": case "Polygon": for (const r of g.coordinates) anneaux.push(r); break;
        case "MultiPolygon": for (const p of g.coordinates) for (const r of p) anneaux.push(r); break;
        case "GeometryCollection": g.geometries.forEach(ajoute); break;
      }
    };
    ajoute(geom);
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, nb = 0;
    for (const r of anneaux) for (const p of r) { nb++; if (p[0] < x0) x0 = p[0]; if (p[0] > x1) x1 = p[0]; if (p[1] < y0) y0 = p[1]; if (p[1] > y1) y1 = p[1]; }
    if (!nb) return false;
    if (x1 < this.bbox[0] || x0 > this.bbox[2] || y1 < this.bbox[1] || y0 > this.bbox[3]) return false;
    // décision rapide par la grille
    const n = this.gn, i0 = Math.floor((x0 - this.gx0) / this.gw), i1 = Math.floor((x1 - this.gx0) / this.gw);
    const j0 = Math.floor((y0 - this.gy0) / this.gh), j1 = Math.floor((y1 - this.gy0) / this.gh);
    if (i0 >= 0 && j0 >= 0 && i1 < n && j1 < n) {
      let tous0 = true, tous1 = true;
      for (let j = j0; j <= j1 && (tous0 || tous1); j++) for (let k = i0; k <= i1; k++) { const c = this.cls[j * n + k]; if (c !== 0) tous0 = false; if (c !== 1) tous1 = false; }
      if (tous0) return false; if (tous1) return true;
    }
    for (const r of anneaux) for (const p of r) if (this.dedans(p[0], p[1])) return true;
    for (const r of anneaux) for (let i = 0; i + 1 < r.length; i++) if (this.segmentCoupeLimite(r[i][0], r[i][1], r[i + 1][0], r[i + 1][1])) return true;
    return false;
  }
}

const cache = new Map<string, Promise<Territoire>>();
/** Territoire ADMIN EXPRESS (commune, epci, departement, region) par son code, mis en cache. */
export function territoire(niveau: string, code: string): Promise<Territoire> {
  const def = TYPENAMES[niveau]; if (!def) return Promise.reject(new Error(`niveau inconnu : ${niveau}`));
  if (!/^[0-9A-Za-z]{2,9}$/.test(code)) return Promise.reject(new Error("code invalide"));
  const cle = `${niveau}:${code}`;
  let p = cache.get(cle);
  if (!p) {
    p = (async () => {
      const q = new URLSearchParams({ SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: def.typename, OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", CQL_FILTER: `${def.field}='${code}'` });
      for (let essai = 0; ; essai++) {
        const r = await fetch(`${WFS}?${q}`);
        if (r.ok) {
          const fc: any = await r.json();
          if (fc.features?.length !== 1) throw new Error(`territoire ${cle} : ${fc.features?.length ?? 0} résultat(s)`);
          return Territoire.depuisGeoJSON(fc.features[0].geometry);
        }
        if (essai >= 3 || (r.status < 500 && r.status !== 429)) throw new Error(`WFS ${r.status} (territoire ${cle})`);
        await new Promise((ok) => setTimeout(ok, 1000 * 2 ** essai));
      }
    })();
    p.catch(() => cache.delete(cle)); // une erreur ne se mémorise pas
    cache.set(cle, p);
  }
  return p;
}
