/**
 * Lecture EXACTE d'une couche WFS pour un territoire (commune, EPCI, département, région).
 *
 * Le service est interrogé sur une emprise (rectangle, ou sur-ensemble serré du contour pour les couches du GPU en commune) qui
 * déborde sur les territoires voisins. Ici on lit TOUTES les pages, avec les géométries, et on décide pour chaque objet, sur les
 * coordonnées, s'il a au moins un point commun avec le contour ADMIN EXPRESS du territoire (jsts) :
 *   - dedans / à cheval sur la limite : retenu (les « à cheval » sont comptés et listés) ;
 *   - aucun point commun : écarté, listé avec son identifiant (jamais supprimé en silence) ;
 *   - sans géométrie : écarté, listé (appartenance invérifiable).
 *
 * RÈGLE : jamais de résultat partiel. Le nombre d'objets lus doit égaler `numberMatched` annoncé, celui-ci ne doit pas changer
 * d'une page à l'autre, pas de doublon d'identifiant ; sinon erreur explicite. Au-delà de `limite` objets, la décision exacte n'est
 * pas tentée : l'erreur `ErreurVolume` le dit (jamais de décision sur un échantillon). Le résultat classé est mis en cache sur disque
 * (clé : couche, territoire, filtre) ; une lecture en échec n'est jamais mise en cache.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, statSync } from "fs";
import { gzipSync, gunzipSync } from "zlib";
import { createHash } from "crypto";
import { join, dirname } from "path";
// @ts-ignore
import { contourExact } from "./emprise.js";

const PAGE = 1000;
const PARALLELE = 4;
const TTL_MS = 6 * 3600 * 1000;
const CACHE_DIR = process.env.TILE_CACHE_DIR || join(process.cwd(), ".tilecache");

export interface Ecarte { gid: string; libelle: string | null; raison: string }
export interface ResultatExact {
  lus: number;
  gardes: Record<string, unknown>[];
  cheval: number;
  chevalGids: string[];
  ecartes: Ecarte[];
  /** Propriété qui identifie un objet (« gid » pour le GPU) ou « @id » pour l'identifiant WFS de l'objet. */
  cle: string;
  niveau: string;
  code: string;
}
export interface OptionsExact {
  /** commune (défaut), epci, departement, region */
  niveau?: string;
  /** propriété identifiante ; « @id » = identifiant WFS (feature.id). Défaut « gid ». */
  cle?: string;
  /** propriété de tri total des pages (sinon la pagination WFS n'est pas stable) */
  tri?: string;
  /** au-delà, ErreurVolume (pas de décision exacte tentée) */
  limite?: number;
}
export class ErreurVolume extends Error {
  constructor(readonly attendu: number, readonly limite: number, typename: string) {
    super(`${typename} : ${attendu.toLocaleString("fr-FR")} objets dans l'emprise, au-delà de ${limite.toLocaleString("fr-FR")} : appartenance exacte non décidée`);
    this.name = "ErreurVolume";
  }
}

const enCours = new Map<string, Promise<ResultatExact>>();
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function page(base: string, typename: string, cql: string, debut: number, timeoutMs: number, tri: string): Promise<any> {
  const u = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeName: typename, outputFormat: "application/json", srsName: "EPSG:4326", CQL_FILTER: cql, sortBy: tri, count: String(PAGE) });
  if (debut > 0) u.set("startIndex", String(debut));
  let derniere: Error | null = null;
  for (let essai = 0; essai < 4; essai++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}?${u}`, { signal: ctl.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
      derniere = new Error(`HTTP ${r.status} (${typename}, page à ${debut})`);
      if (r.status < 500 && r.status !== 429) throw derniere;
    } catch (e: any) {
      clearTimeout(t);
      derniere = e?.name === "AbortError" ? new Error(`délai dépassé (${typename}, page à ${debut})`) : e;
      if (/^HTTP 4/.test(String(derniere?.message)) && !/429/.test(String(derniere?.message))) throw derniere;
    }
    await sleep(1000 * 2 ** essai);
  }
  throw derniere ?? new Error(`lecture impossible (${typename})`);
}

async function lire(base: string, typename: string, cql: string, code: string, champs: string[], timeoutMs: number, o: Required<OptionsExact>): Promise<ResultatExact> {
  const { prep } = await contourExact(code, o.niveau);
  const p0 = await page(base, typename, cql, 0, timeoutMs, o.tri);
  const attendu = p0.numberMatched ?? p0.totalFeatures;
  if (!Number.isFinite(attendu)) throw new Error(`${typename} : le service n'annonce pas le nombre total d'objets, complétude invérifiable`);
  if (attendu > o.limite) throw new ErreurVolume(attendu, o.limite, typename);
  const pages: any[] = new Array(Math.ceil(attendu / PAGE) || 1);
  pages[0] = p0;
  let k = 1;
  const ouvrier = async () => {
    for (;;) {
      const i = k++; if (i >= pages.length) return;
      const p = await page(base, typename, cql, i * PAGE, timeoutMs, o.tri);
      const n = p.numberMatched ?? p.totalFeatures;
      if (n !== attendu) throw new Error(`${typename} : le nombre total annoncé a changé pendant la lecture (${attendu} puis ${n}) : résultat refusé`);
      pages[i] = p;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PARALLELE, pages.length) }, ouvrier));

  const ids = new Set<string>();
  const gardes: Record<string, unknown>[] = [], ecartes: Ecarte[] = [], chevalGids: string[] = [];
  let lus = 0;
  for (let i = 0; i < pages.length; i++) {
    const feats = pages[i]?.features;
    if (!Array.isArray(feats)) throw new Error(`${typename} : page ${i} absente`);
    for (const f of feats) {
      lus++;
      const brut = o.cle === "@id" ? f.id : f.properties?.[o.cle];
      const gid = brut == null ? "" : String(brut);
      if (!gid) throw new Error(`${typename} : objet sans identifiant « ${o.cle} » (tri et dédoublonnage impossibles)`);
      if (ids.has(gid)) throw new Error(`${typename} : identifiant ${gid} en double dans les pages (pagination instable) : résultat refusé`);
      ids.add(gid);
      const p = f.properties ?? {};
      const libelle = p.libelle ?? p.nomass ?? p.nom_site ?? p.nom ?? p.toponyme ?? p.nom_collaboratif_gauche ?? null;
      if (!f.geometry) { ecartes.push({ gid, libelle, raison: "objet sans géométrie : appartenance au territoire invérifiable" }); continue; }
      const pos = prep.position(f.geometry);
      if (pos === "hors") { ecartes.push({ gid, libelle, raison: "aucun point commun avec le contour du territoire (ADMIN EXPRESS, IGN)" }); continue; }
      if (pos === "cheval") chevalGids.push(gid);
      const props: Record<string, unknown> = {};
      for (const c of champs) if (c in p) props[c] = p[c];
      gardes.push(props);
    }
  }
  if (lus !== attendu) throw new Error(`${typename} : ${lus} objets lus pour ${attendu} annoncés : résultat refusé`);
  return { lus, gardes, cheval: chevalGids.length, chevalGids, ecartes, cle: o.cle, niveau: o.niveau, code };
}

export function lireExact(base: string, typename: string, cql: string, code: string, champs: string[], timeoutMs = 60000, opts: OptionsExact = {}): Promise<ResultatExact> {
  const o: Required<OptionsExact> = { niveau: opts.niveau ?? "commune", cle: opts.cle ?? "gid", tri: opts.tri ?? (opts.cle && opts.cle !== "@id" ? opts.cle : "gid"), limite: opts.limite ?? 60000 };
  const cle = createHash("sha1").update(`v3|${typename}|${o.niveau}|${code}|${cql}|${champs.join(",")}|${o.cle}|${o.tri}`).digest("hex");
  const fichier = join(CACHE_DIR, "gpu", typename.replace(/[^\w]/g, "_"), `${o.niveau}-${code}-${cle}.json.gz`);
  try {
    if (existsSync(fichier) && Date.now() - statSync(fichier).mtimeMs < TTL_MS) return Promise.resolve(JSON.parse(gunzipSync(readFileSync(fichier)).toString("utf8")));
  } catch { /* cache illisible : relecture */ }
  let p = enCours.get(fichier);
  if (!p) {
    p = lire(base, typename, cql, code, champs, timeoutMs, o).then((r) => {
      try { mkdirSync(dirname(fichier), { recursive: true }); const tmp = `${fichier}.${process.pid}.tmp`; writeFileSync(tmp, gzipSync(JSON.stringify(r))); renameSync(tmp, fichier); } catch { /* cache facultatif */ }
      return r;
    });
    p.then(() => enCours.delete(fichier), () => enCours.delete(fichier));
    enCours.set(fichier, p);
  }
  return p;
}
