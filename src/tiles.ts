/**
 * Tuiles GeoJSON à cache disque, servies depuis le serveur HTTP du fork.
 *
 *   GET /tiles/{jeu}/{z}/{x}/{y}.json[?props=a,b][&dp=6][&niveau=commune&code=13055]
 *
 * RÈGLE : jamais de résultat faux ou incomplet. Aucun plafond : une tuile est lue en entier, par pages, et CONTRÔLÉE :
 *   - le nombre d'objets reçus doit égaler `numberMatched` annoncé par le service, sinon erreur (502) ;
 *   - le `numberMatched` ne doit pas changer d'une page à l'autre ; pas de doublon dans une lecture triée ;
 *   - deux `cleabs` différents ne doivent pas donner le même `id` entier ;
 *   - une tuile qui échoue n'est JAMAIS mise en cache (et l'erreur est dite au client, qui n'affiche alors rien).
 * Le cache disque garde la tuile brute (toutes les propriétés, coordonnées au millimètre) ; la réponse est dérivée :
 * filtre de territoire EXACT (intersection avec le polygone, décidée sur les coordonnées brutes), propriétés demandées,
 * arrondi d'affichage seulement.
 */
import { IncomingMessage, ServerResponse } from "http";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { join, dirname } from "path";
import { territoire } from "./territoire.js";

const WFS = "https://data.geopf.fr/wfs/ows";
const CACHE_DIR = process.env.TILE_CACHE_DIR || join(process.cwd(), ".tilecache");
const PAGE = 5000;

interface Jeu { typename: string; props: string[]; geom: string }
const JEUX: Record<string, Jeu> = {
  batiment: { typename: "BDTOPO_V3:batiment", geom: "geometrie", props: ["cleabs", "nature", "usage_1", "hauteur", "nombre_de_logements", "nombre_d_etages", "etat_de_l_objet", "date_modification"] },
};

let actifs = 0;
const file: Array<() => void> = [];
async function limite<T>(fn: () => Promise<T>): Promise<T> {
  if (actifs >= 3) await new Promise<void>((r) => file.push(r));
  actifs++;
  try { return await fn(); } finally { actifs--; file.shift()?.(); }
}
const enCours = new Map<string, Promise<Brute>>();
export const statsTuiles = { froid: 0, chaud: 0, msWfs: 0, reprises: 0, erreurs: 0 };

interface Brute { numberMatched: number; features: Array<{ id: number; properties: Record<string, unknown>; geometry: any }> }

function bboxTuile(z: number, x: number, y: number): [number, number, number, number] {
  const n = 2 ** z, lon = (i: number) => (i / n) * 360 - 180;
  const lat = (j: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * j) / n))) * 180) / Math.PI;
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}
const xy = (c: any): any => (typeof c[0] === "number" ? [c[0], c[1]] : c.map(xy)); // retire l'altitude, garde la précision source
const arrondi = (c: any, f: number): any => (typeof c[0] === "number" ? [Math.round(c[0] * f) / f, Math.round(c[1] * f) / f] : c.map((s: any) => arrondi(s, f)));
function idDe(cleabs: string): number {
  const m = /(\d{6,15})$/.exec(cleabs || ""); if (!m) throw new Error(`cleabs sans suffixe numérique : « ${cleabs} »`);
  return Number(m[1]);
}

async function fabriquerBrute(jeu: Jeu, z: number, x: number, y: number): Promise<Brute> {
  const [w, s, e, n] = bboxTuile(z, x, y);
  const base = {
    SERVICE: "WFS", VERSION: "2.0.0", REQUEST: "GetFeature", TYPENAMES: jeu.typename, OUTPUTFORMAT: "application/json",
    SRSNAME: "EPSG:4326", BBOX: `${s},${w},${n},${e},urn:ogc:def:crs:EPSG::4326`, PROPERTYNAME: [...jeu.props, jeu.geom].join(","),
  };
  const t0 = Date.now();
  const page = async (extra: Record<string, string>): Promise<any> => {
    for (let essai = 0; ; essai++) {
      let r: Response | null = null;
      try { r = await limite(() => fetch(`${WFS}?${new URLSearchParams({ ...base, ...extra })}`, { headers: { "Accept-Encoding": "gzip" } })); } catch { /* réseau */ }
      if (r?.ok) { const j: any = await r.json(); if (!Array.isArray(j.features) || typeof j.numberMatched !== "number") throw new Error("réponse WFS sans numberMatched"); return j; }
      statsTuiles.reprises++;
      if (essai >= 5 || (r && r.status < 500 && r.status !== 429)) throw new Error(`WFS ${r?.status ?? "réseau"} (tuile ${z}/${x}/${y})`);
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** essai));
    }
  };
  let brut: any[]; let attendu: number;
  const p0 = await page({ COUNT: String(PAGE) });
  attendu = p0.numberMatched;
  if (p0.features.length === attendu) brut = p0.features;           // tuile entière en une page
  else {                                                              // sinon lecture triée par pages, jusqu'au dernier objet
    brut = [];
    for (let debut = 0; debut < attendu; debut += PAGE) {
      const p = await page({ COUNT: String(PAGE), STARTINDEX: String(debut), SORTBY: "cleabs" });
      if (p.numberMatched !== attendu) throw new Error(`numberMatched a changé pendant la lecture (${attendu} -> ${p.numberMatched}) : tuile ${z}/${x}/${y}`);
      if (!p.features.length) throw new Error(`page vide avant la fin (${brut.length}/${attendu}) : tuile ${z}/${x}/${y}`);
      brut.push(...p.features);
    }
  }
  statsTuiles.msWfs += Date.now() - t0;
  if (brut.length !== attendu) throw new Error(`tuile ${z}/${x}/${y} incomplète : ${brut.length} objets reçus sur ${attendu}`);
  const vus = new Map<number, string>(), out: Brute["features"] = [];
  for (const ft of brut) {
    if (!ft.geometry) throw new Error(`objet sans géométrie (${ft.properties?.cleabs}) : tuile ${z}/${x}/${y}`);
    const cle = String(ft.properties?.cleabs ?? ""), id = idDe(cle);
    if (vus.has(id)) throw new Error(vus.get(id) === cle ? `doublon ${cle} : tuile ${z}/${x}/${y}` : `collision d'identifiant : ${cle} / ${vus.get(id)}`);
    vus.set(id, cle);
    const p: Record<string, unknown> = {}; for (const k of jeu.props) if (ft.properties?.[k] != null) p[k] = ft.properties[k];
    out.push({ id, properties: p, geometry: { type: ft.geometry.type, coordinates: xy(ft.geometry.coordinates) } });
  }
  return { numberMatched: attendu, features: out };
}

async function brute(nom: string, z: number, x: number, y: number): Promise<Brute> {
  const jeu = JEUX[nom], fichier = join(CACHE_DIR, "brut", nom, String(z), String(x), `${y}.json.gz`);
  if (existsSync(fichier)) {
    try { statsTuiles.chaud++; return JSON.parse(gunzipSync(readFileSync(fichier)).toString()); } catch { statsTuiles.chaud--; /* fichier abîmé : on refait */ }
  }
  const id = `${nom}/${z}/${x}/${y}`;
  let p = enCours.get(id);
  if (!p) {
    p = fabriquerBrute(jeu, z, x, y).then((b) => {
      mkdirSync(dirname(fichier), { recursive: true });
      const tmp = fichier + ".tmp"; writeFileSync(tmp, gzipSync(Buffer.from(JSON.stringify(b)), { level: 6 })); renameSync(tmp, fichier); // écriture atomique
      statsTuiles.froid++; return b;
    }).finally(() => enCours.delete(id));
    enCours.set(id, p);
  }
  return p;
}

export interface MetaTuile { z: number; x: number; y: number; numberMatched: number; n: number; complete: true; territoire: string | null }

/** Tuile dérivée : filtre de territoire exact, propriétés demandées, arrondi d'affichage. */
export async function tuile(nom: string, z: number, x: number, y: number, o: { props?: string[]; dp?: number; niveau?: string; code?: string } = {}) {
  const d = await tuileObjets(nom, z, x, y, o);
  return gzipSync(Buffer.from(JSON.stringify({ type: "FeatureCollection", features: d.features, meta: d.meta })), { level: 6 });
}

export async function tuileObjets(nom: string, z: number, x: number, y: number, o: { props?: string[]; dp?: number; niveau?: string; code?: string } = {}) {
  const jeu = JEUX[nom]; if (!jeu) throw new Error("jeu inconnu");
  const b = await brute(nom, z, x, y);
  const props = (o.props?.length ? o.props : jeu.props).filter((k) => jeu.props.includes(k));
  if (!props.includes("cleabs")) props.unshift("cleabs");
  const terr = o.niveau && o.code ? await territoire(o.niveau, o.code) : null;
  const f = 10 ** (o.dp ?? 6), feats: any[] = [];
  for (const ft of b.features) {
    if (terr && !terr.intersecte(ft.geometry)) continue;
    const p: Record<string, unknown> = {}; for (const k of props) if (ft.properties[k] != null) p[k] = ft.properties[k];
    feats.push({ type: "Feature", id: ft.id, properties: p, geometry: { type: ft.geometry.type, coordinates: arrondi(ft.geometry.coordinates, f) } });
  }
  const meta: MetaTuile = { z, x, y, numberMatched: b.numberMatched, n: feats.length, complete: true, territoire: terr ? `${o.niveau}:${o.code}` : null };
  return { features: feats, meta };
}

/** Indices (x, y) des tuiles z qui couvrent une emprise [ouest, sud, est, nord]. */
export function tuilesDeEmprise(z: number, bbox: number[]): Array<[number, number]> {
  const n = 2 ** z, tx = (lon: number) => Math.min(n - 1, Math.max(0, Math.floor(((lon + 180) / 360) * n)));
  const ty = (lat: number) => Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n)));
  const out: Array<[number, number]> = [];
  for (let x = tx(bbox[0]); x <= tx(bbox[2]); x++) for (let y = ty(bbox[3]); y <= ty(bbox[1]); y++) out.push([x, y]);
  return out;
}

/**
 * TOUS les objets d'un territoire : toutes les tuiles de l'emprise, sans plafond, chacune contrôlée ; dédoublonnage des
 * objets à cheval sur deux tuiles (même `cleabs`, sinon erreur). Lève une erreur au moindre manque : jamais de résultat partiel.
 */
export async function ensemble(nom: string, z: number, niveau: string, code: string, bbox: number[], props?: string[]) {
  const liste = tuilesDeEmprise(z, bbox), uniques = new Map<number, any>();
  let i = 0, vus = 0;
  const ouvrier = async () => {
    for (;;) {
      const k = i++; if (k >= liste.length) return;
      const [x, y] = liste[k];
      const d = await tuileObjets(nom, z, x, y, { niveau, code, props });
      vus += d.features.length;
      for (const f of d.features) {
        const prev = uniques.get(f.id);
        if (prev && prev.properties.cleabs !== f.properties.cleabs) throw new Error(`collision d'identifiant entre ${prev.properties.cleabs} et ${f.properties.cleabs}`);
        uniques.set(f.id, f);
      }
    }
  };
  await Promise.all(Array.from({ length: 6 }, ouvrier));
  return { features: [...uniques.values()].sort((a, b) => a.id - b.id), tuiles: liste.length, avecDoublons: vus };
}

/** Route HTTP : retourne true si la requête a été traitée. */
export async function routeTuiles(req: IncomingMessage, res: ServerResponse, pathname: string, url: string): Promise<boolean> {
  if (pathname === "/tiles/stats") { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(statsTuiles)); return true; }
  const m = /^\/tiles\/([a-z_]+)\/(\d+)\/(\d+)\/(\d+)\.json$/.exec(pathname);
  if (!m) return false;
  const q = new URL(url, "http://x").searchParams;
  const z = +m[2], x = +m[3], y = +m[4];
  if (z < 11 || z > 17) { res.writeHead(400, { "Content-Type": "text/plain" }); res.end("z entre 11 et 17"); return true; }
  try {
    const t0 = Date.now();
    const buf = await tuile(m[1], z, x, y, { props: q.get("props")?.split(",").filter(Boolean), dp: Math.min(8, Math.max(5, +(q.get("dp") || 6))), niveau: q.get("niveau") || undefined, code: q.get("code") || undefined });
    res.writeHead(200, { "Content-Type": "application/json", "Content-Encoding": "gzip", "Cache-Control": "no-cache", "Access-Control-Allow-Origin": "*", "Server-Timing": `tuile;dur=${Date.now() - t0}` });
    res.end(buf);
  } catch (e: any) {
    statsTuiles.erreurs++;
    res.writeHead(502, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify({ erreur: String(e.message) }));
  }
  return true;
}
