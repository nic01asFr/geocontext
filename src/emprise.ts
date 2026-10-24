/**
 * Emprise de requête d'une commune pour les services WFS du GPU : un SUR-ENSEMBLE serré du contour ADMIN EXPRESS
 * (contour simplifié puis élargi vers l'extérieur), exprimé en INTERSECTS. Il ne remplace pas le contrôle exact
 * d'appartenance (fait ensuite, sur les coordonnées), il évite seulement de lire des dizaines de milliers d'objets de
 * communes voisines que l'emprise rectangulaire (BBOX) ramènerait.
 *
 * Garantie : le résultat CONTIENT le contour (vérifié ; sinon erreur). Tolérance de simplification 0,001° (~100 m),
 * élargissement 1,5 × la tolérance (le tampon est polygonal à 1 segment par quart de cercle : son pire écart intérieur est 0,71 × la distance).
 */
// @ts-ignore — jsts n'a pas de déclarations pour ces chemins ES
import GeoJSONReader from "jsts/org/locationtech/jts/io/GeoJSONReader.js";
// @ts-ignore
import DouglasPeuckerSimplifier from "jsts/org/locationtech/jts/simplify/DouglasPeuckerSimplifier.js";
// @ts-ignore
import BufferOp from "jsts/org/locationtech/jts/operation/buffer/BufferOp.js";
// @ts-ignore
import "jsts/org/locationtech/jts/monkey.js";
import { Territoire } from "./territoire.js";

const WFS = "https://data.geopf.fr/wfs/ows";
const TOL = 0.001;
const cache = new Map<string, Promise<string>>();

function ring(g: any): string {
  const c = g.getCoordinates();
  return "(" + c.map((p: any) => `${p.x.toFixed(6)} ${p.y.toFixed(6)}`).join(",") + ")";
}

const NIVEAUX: Record<string, { typename: string; champ: string; code: RegExp; libelle: string }> = {
  commune: { typename: "ADMINEXPRESS-COG.LATEST:commune", champ: "code_insee", code: /^[0-9A-Za-z]{5}$/, libelle: "la commune" },
  epci: { typename: "ADMINEXPRESS-COG.LATEST:epci", champ: "code_siren", code: /^[0-9]{9}$/, libelle: "l'EPCI" },
  departement: { typename: "ADMINEXPRESS-COG.LATEST:departement", champ: "code_insee", code: /^[0-9A-Za-z]{2,3}$/, libelle: "le département" },
  region: { typename: "ADMINEXPRESS-COG.LATEST:region", champ: "code_insee", code: /^[0-9A-Za-z]{2}$/, libelle: "la région" },
};
export type Position = "hors" | "dedans" | "cheval";
export const NIVEAUX_EXACTS = Object.keys(NIVEAUX);
export function libelleNiveau(niveau: string): string { return NIVEAUX[niveau]?.libelle ?? `le territoire (${niveau})`; }

async function contourBrut(code: string, niveau: string): Promise<any> {
  const n = NIVEAUX[niveau]; if (!n) throw new Error(`niveau sans contour ADMIN EXPRESS : ${niveau}`);
  const q = new URLSearchParams({ SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: n.typename, OUTPUTFORMAT: "application/json", SRSNAME: "EPSG:4326", CQL_FILTER: `${n.champ}='${code}'` });
  let fc: any;
  for (let essai = 0; ; essai++) {
    const r = await fetch(`${WFS}?${q}`);
    if (r.ok) { fc = await r.json(); break; }
    if (essai >= 3 || (r.status < 500 && r.status !== 429)) throw new Error(`contour ${niveau} ${code} : WFS ${r.status}`);
    await new Promise((ok) => setTimeout(ok, 1000 * 2 ** essai));
  }
  if (fc.features?.length !== 1) throw new Error(`contour ${niveau} ${code} : ${fc.features?.length ?? 0} résultat(s) dans ADMIN EXPRESS`);
  return fc.features[0].geometry;
}

const contours = new Map<string, Promise<any>>();
/** Contour ADMIN EXPRESS du territoire (commune par défaut ; epci, departement, region) : géométrie jsts + tests d'intersection rapides. */
export function contourExact(code: string, niveau = "commune"): Promise<{ g: any; prep: any }> {
  const n = NIVEAUX[niveau];
  if (!n) return Promise.reject(new Error(`niveau sans contour ADMIN EXPRESS : ${niveau}`));
  if (!n.code.test(code)) return Promise.reject(new Error(`code ${niveau} invalide : ${code}`));
  const cle = `${niveau}:${code}`;
  let p = contours.get(cle);
  if (!p) {
    p = (async () => {
      const brut = await contourBrut(code, niveau);
      const lecteur = new (GeoJSONReader as any)();
      const g = lecteur.read(brut);
      const T = Territoire.depuisGeoJSON(brut);
      const stats = { rapide: 0, jsts: 0 };
      // Décision exacte : index de bandes + grille (rapide) quand le résultat est certain ; jsts (arbitre) pour tout cas ambigu
      // (contact sans croisement franc, colinéaire, extrémité sur la limite, trou du territoire sous un objet surfacique).
      const env = g.getEnvelopeInternal();
      const jsts = (geom: any): Position => { stats.jsts++; const o = lecteur.read(geom); if (!(env.intersects(o.getEnvelopeInternal()) && g.intersects(o))) return "hors"; return g.contains(o) ? "dedans" : "cheval"; };
      const prep = {
        stats,
        position: (geom: any): Position => {
          const t = geom?.type;
          const surf = t === "Polygon" || t === "MultiPolygon";
          const lignes: number[][][] = t === "Point" ? [[geom.coordinates]] : t === "MultiPoint" ? geom.coordinates.map((q: number[]) => [q]) : t === "LineString" ? [geom.coordinates] : t === "MultiLineString" ? geom.coordinates : t === "Polygon" ? geom.coordinates : t === "MultiPolygon" ? geom.coordinates.flat() : null as any;
          if (!lignes) return jsts(geom);
          let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, nb = 0;
          for (const r of lignes) for (const q of r) { nb++; if (q[0] < x0) x0 = q[0]; if (q[0] > x1) x1 = q[0]; if (q[1] < y0) y0 = q[1]; if (q[1] > y1) y1 = q[1]; }
          if (!nb) return jsts(geom);
          const cls = T.classeEnveloppe(x0, y0, x1, y1);
          if (cls === 0) { stats.rapide++; return "hors"; }
          if (cls === 1) { stats.rapide++; return "dedans"; }
          let croise = false, touche = false, nIn = 0, nOut = 0;
          for (const r of lignes) {
            if (r.length === 1) { const q = r[0]; if (T.surLimite(q[0], q[1])) touche = true; }
            for (let i = 0; i + 1 < r.length && !croise; i++) { const c = T.contactSegment(r[i][0], r[i][1], r[i + 1][0], r[i + 1][1]); if (c === 1) croise = true; else if (c === 2) touche = true; }
            if (croise) break;
            for (const q of r) { if (T.dedans(q[0], q[1])) nIn++; else nOut++; }
          }
          if (croise) { stats.rapide++; return "cheval"; }
          if (touche) return jsts(geom);
          // aucun contact avec la limite : chaque partie est entièrement dedans ou entièrement dehors
          const polys: number[][][][] = t === "Polygon" ? [geom.coordinates] : t === "MultiPolygon" ? geom.coordinates : [];
          const contientPartie = (): boolean => { // un anneau de la limite (extérieur ou trou) est-il à l'intérieur de l'objet surfacique ?
            for (const q of T.premiers) for (const pl of polys) { let c = false; for (const r of pl) for (let i = 0, j = r.length - 1; i < r.length; j = i++) { const yi = r[i][1], yj = r[j][1]; if ((yi > q[1]) !== (yj > q[1]) && q[0] < ((r[j][0] - r[i][0]) * (q[1] - yi)) / (yj - yi) + r[i][0]) c = !c; } if (c) return true; }
            return false;
          };
          if (nIn > 0 && nOut === 0) { if (surf && contientPartie()) return jsts(geom); stats.rapide++; return "dedans"; }
          if (nIn > 0) { stats.rapide++; return "cheval"; }
          if (surf && contientPartie()) { stats.rapide++; return "cheval"; }
          stats.rapide++; return "hors";
        },
      };
      return { g, prep };
    })();
    p.catch(() => contours.delete(cle));
    contours.set(cle, p);
  }
  return p;
}

async function fabriquer(code: string): Promise<string> {
  const { g } = await contourExact(code);
  const s = (DouglasPeuckerSimplifier as any).simplify(g, TOL);
  const b = (BufferOp as any).bufferOp(s, TOL * 1.5, 1);
  if (!b.contains(g)) throw new Error(`emprise simplifiée de ${code} ne contient pas le contour : requête refusée`);
  const polys: string[] = [];
  for (let i = 0; i < b.getNumGeometries(); i++) {
    const p = b.getGeometryN(i);
    const anneaux = [ring(p.getExteriorRing())];
    for (let k = 0; k < p.getNumInteriorRing(); k++) anneaux.push(ring(p.getInteriorRingN(k)));
    polys.push("(" + anneaux.join(",") + ")");
  }
  return `SRID=4326;MULTIPOLYGON(${polys.join(",")})`;
}

/** Expression CQL « INTERSECTS(colonne, emprise) » de la commune. Erreur explicite si le contour est inaccessible. */
export async function empriseIntersects(code: string, geomCol: string): Promise<string> {
  if (!/^[0-9A-Za-z]{5}$/.test(code)) throw new Error(`code commune invalide : ${code}`);
  let p = cache.get(code);
  if (!p) { p = fabriquer(code); p.catch(() => cache.delete(code)); cache.set(code, p); }
  return `INTERSECTS(${geomCol}, ${await p})`;
}
