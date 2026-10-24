/**
 * Liens par références — commune → IRIS (IGN) → indicateurs INSEE (Melodi).
 *
 * Principe : la liste des IRIS vient de l'IGN (référentiel géographique) ; chaque IRIS est ensuite
 * relié, par son code, aux jeux du recensement publiés par l'INSEE via l'API Melodi.
 * Le résultat contient un RAPPORT D'APPARIEMENT : combien d'IRIS IGN ont des données, lesquels n'en ont pas,
 * et un contrôle de cohérence (somme des IRIS vs total communal). Un lien incomplet est signalé, jamais comblé.
 *
 * Aucune valeur n'est inventée : une valeur absente reste null.
 */

const MELODI = "https://api.insee.fr/melodi";
const WFS = "https://data.geopf.fr/wfs/ows";
const CODE_COMMUNE = /^(\d{2}|2A|2B)\d{3}$/;
const DS_POP_IRIS = "DS_RP_POPULATION_PRINC_IRIS";
const DS_LOG_IRIS = "DS_RP_LOGEMENT_PRINC_IRIS";
const DS_POP_COM = "DS_RP_POPULATION_PRINC";
const TAILLE_LOT = 25;
const PAGES_MAX = 20;

export interface IndicateursIris {
  annee: number | null;
  population: number | null;
  moins15: number | null;
  plus65: number | null;
  part_moins15: number | null;
  part_plus65: number | null;
  logements: number | null;
  residences_principales: number | null;
  logements_vacants: number | null;
  part_residences_principales: number | null;
  part_logements_vacants: number | null;
}

export interface IrisLie {
  code_iris: string;
  nom_iris: string;
  type_iris: string;
  indicateurs: IndicateursIris | null;
}

export interface RapportIris {
  commune: string;
  genere_le: string;
  sources: {
    liste_iris: string;
    population: { jeu: string; millesime_geo: string; annee: number | null };
    logement: { jeu: string; millesime_geo: string; annee: number | null };
  };
  iris: IrisLie[];
  rapport: {
    iris_ign: number;
    avec_donnees: number;
    sans_donnees: Array<{ code_iris: string; nom_iris: string; type_iris: string; raison: string }>;
    controle_population: null | {
      somme_iris: number;
      total_commune: number;
      ecart_pct: number;
      annee: number | null;
      verdict: "coherent" | "ecart";
    };
  };
  avertissements: string[];
}

function pause(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function getJson(url: string, libelle: string, tentatives = 3, delaiMs = 20000): Promise<any> {
  let derniere = "";
  for (let i = 0; i < tentatives; i++) {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), delaiMs);
    try {
      const r = await fetch(url, { headers: { Accept: "application/json" }, signal: c.signal });
      clearTimeout(t);
      if (r.ok) return await r.json();
      derniere = "HTTP " + r.status;
      if ([429, 500, 502, 503, 504].indexOf(r.status) < 0) break;
    } catch (e: any) {
      clearTimeout(t);
      derniere = e && e.name === "AbortError" ? "délai de " + delaiMs + " ms dépassé" : String((e && e.message) || e);
    }
    if (i < tentatives - 1) await pause(500 * Math.pow(2, i));
  }
  throw new Error(libelle + " : " + derniere);
}

function observationsDe(d: any): any[] {
  return d && Array.isArray(d.observations) ? d.observations : [];
}

function suivante(d: any): string | null {
  const n = d && d.paging && typeof d.paging.next === "string" ? d.paging.next : null;
  if (!n) return null;
  const u = new URL(n);
  if (u.protocol === "http:") u.protocol = "https:";
  if (u.origin !== new URL(MELODI).origin) throw new Error("Pagination Melodi vers un autre serveur refusée : " + u.origin);
  return u.toString();
}

function valeur(o: any): number | null {
  const v = o && o.measures && o.measures.OBS_VALUE_NIVEAU ? o.measures.OBS_VALUE_NIVEAU.value : undefined;
  return typeof v === "number" && isFinite(v) ? v : null;
}

/**
 * Code GEO Melodi d'un IRIS IGN. Une commune non découpée (type Z) est publiée par Melodi sous son code commune.
 * Constat mesuré : Melodi IGNORE l'année placée en préfixe du code GEO (2027, 2024 ou 1999 renvoient le même enregistrement)
 * et répond avec le millésime réel du jeu. On lit donc le millésime dans la réponse, on ne le devine pas.
 */
function geoDe(prefixe: string, iris: { code_iris: string; type_iris: string }, commune: string): string {
  return iris.type_iris === "Z" ? prefixe + "-COM-" + commune : prefixe + "-IRIS-" + iris.code_iris;
}

/** Clé de rapprochement indépendante du millésime : « IRIS-130050101 » ou « COM-01001 ». */
function cleDe(geo: string): string {
  const k = String(geo).indexOf("-");
  return k < 0 ? String(geo) : String(geo).slice(k + 1);
}
function cleIris(iris: { code_iris: string; type_iris: string }, commune: string): string {
  return iris.type_iris === "Z" ? "COM-" + commune : "IRIS-" + iris.code_iris;
}

async function listeIrisIgn(commune: string): Promise<Array<{ code_iris: string; nom_iris: string; type_iris: string }>> {
  const p = new URLSearchParams({
    service: "WFS", version: "2.0.0", request: "GetFeature",
    typeName: "STATISTICALUNITS.IRISGE:iris_ge", outputFormat: "application/json",
    cql_filter: "code_insee='" + commune + "'", propertyName: "code_iris,nom_iris,type_iris,code_insee", count: "2000",
  });
  const d = await getJson(WFS + "?" + p.toString(), "Liste des IRIS (IGN)");
  const feats: any[] = Array.isArray(d.features) ? d.features : [];
  if (typeof d.numberMatched === "number" && d.numberMatched !== feats.length) {
    throw new Error("Liste des IRIS (IGN) incomplète : " + feats.length + " reçus sur " + d.numberMatched);
  }
  return feats
    .map((f) => ({ code_iris: String(f.properties.code_iris), nom_iris: String(f.properties.nom_iris || ""), type_iris: String(f.properties.type_iris || "") }))
    .sort((a, b) => (a.code_iris < b.code_iris ? -1 : 1));
}

async function lire(dataset: string, geos: string[], filtres: Record<string, string[]>): Promise<any[]> {
  const sortie: any[] = [];
  for (let i = 0; i < geos.length; i += TAILLE_LOT) {
    const p = new URLSearchParams();
    for (const g of geos.slice(i, i + TAILLE_LOT)) p.append("GEO", g);
    for (const k of Object.keys(filtres)) for (const v of filtres[k]) p.append(k, v);
    p.set("maxResult", "1000");
    let url: string | null = MELODI + "/data/" + dataset + "?" + p.toString();
    let pages = 0;
    while (url) {
      const d = await getJson(url, "Melodi " + dataset);
      for (const o of observationsDe(d)) sortie.push(o);
      url = suivante(d);
      if (url && ++pages >= PAGES_MAX) throw new Error("Melodi " + dataset + " : pagination trop longue (résultat incomplet refusé)");
    }
  }
  return sortie;
}

/** Lit un jeu pour une liste d'IRIS ; si le préfixe courant ne donnait rien (comportement de Melodi qui changerait), sonde d'autres années avant de conclure. */
async function lireIris(dataset: string, liste: Array<{ code_iris: string; type_iris: string }>, commune: string, filtres: Record<string, string[]>): Promise<{ obs: any[]; millesimes: string[] }> {
  const courant = new Date().getUTCFullYear();
  let obs: any[] = [];
  for (let a = courant; a >= courant - 3; a--) {
    obs = await lire(dataset, liste.map((i) => geoDe(String(a), i, commune)), filtres);
    if (obs.length > 0) break;
  }
  const millesimes = Array.from(new Set(obs.map((o) => String(o.dimensions.GEO).split("-")[0]))).sort();
  return { obs, millesimes };
}

function arrondi(v: number | null, d = 0): number | null {
  if (v === null) return null;
  const f = Math.pow(10, d);
  return Math.round(v * f) / f;
}

function part(a: number | null, b: number | null): number | null {
  return a === null || b === null || b <= 0 ? null : arrondi((a / b) * 100, 1);
}

const cacheRapports = new Map<string, { t: number; r: RapportIris }>();
const DUREE_CACHE_MS = 60 * 60 * 1000;

async function indicateursIrisCommune(commune: string): Promise<RapportIris> {
  if (!CODE_COMMUNE.test(commune)) throw new Error("Code commune invalide : « " + commune + " » (5 caractères attendus)");
  const memo = cacheRapports.get(commune);
  if (memo && Date.now() - memo.t < DUREE_CACHE_MS) return memo.r;

  const avertissements: string[] = [];
  const liste = await listeIrisIgn(commune);
  if (liste.length === 0) throw new Error("Aucun IRIS trouvé à l'IGN pour la commune " + commune + " (code inconnu ou commune absente du référentiel IRIS)");

  // — Population —
  const filtresPop: Record<string, string[]> = { RP_MEASURE: ["POP"], SEX: ["_T"], IMMI: ["_T"], HAR: ["_T"], NATIONALITY_TYPE: ["_T"], AGE: ["_T", "Y_LT15", "Y_GE65"] };
  const pop = await lireIris(DS_POP_IRIS, liste, commune, filtresPop);
  if (pop.obs.length === 0) throw new Error("Melodi ne publie aucune donnée de population pour les IRIS de " + commune + " (jeu " + DS_POP_IRIS + ")");

  // — Logement —
  const filtresLog: Record<string, string[]> = { RP_MEASURE: ["DWELLINGS"], OCS: ["_T", "DW_MAIN", "DW_VAC"] };
  for (const k of ["NRG_SRC", "CARS", "BUILD_END", "UFS", "TDW", "TSH", "CARPARK", "NOR", "L_STAY"]) filtresLog[k] = ["_T"];
  const log = await lireIris(DS_LOG_IRIS, liste, commune, filtresLog);
  if (log.obs.length === 0) avertissements.push("Logement : aucune donnée Melodi pour les IRIS de cette commune (jeu " + DS_LOG_IRIS + ").");

  // — Assemblage par IRIS, par code (indépendant du millésime) : dernière année disponible, aucune valeur inventée —
  const regrouper = (obs: any[]) => { const m = new Map<string, any[]>(); for (const o of obs) { const k = cleDe(o.dimensions.GEO); const l = m.get(k); if (l) l.push(o); else m.set(k, [o]); } return m; };
  const parIrisPop = regrouper(pop.obs);
  const parIrisLog = regrouper(log.obs);
  function derniere(lignes: any[]): { annee: number | null; lignes: any[] } {
    let annee: number | null = null;
    for (const o of lignes) { const y = Number(o.dimensions.TIME_PERIOD); if (isFinite(y) && (annee === null || y > annee)) annee = y; }
    return { annee, lignes: lignes.filter((o) => Number(o.dimensions.TIME_PERIOD) === annee) };
  }

  const resultat: IrisLie[] = [];
  const sans: RapportIris["rapport"]["sans_donnees"] = [];
  let sommeIris = 0;
  let anneePop: number | null = null;
  let anneeLog: number | null = null;
  for (const i of liste) {
    const cle = cleIris(i, commune);
    const rp = derniere(parIrisPop.get(cle) || []);
    const rl = derniere(parIrisLog.get(cle) || []);
    const pickPop = (age: string): number | null => { const o = rp.lignes.find((x) => x.dimensions.AGE === age); return o ? valeur(o) : null; };
    const pickLog = (ocs: string): number | null => { const o = rl.lignes.find((x) => x.dimensions.OCS === ocs); return o ? valeur(o) : null; };
    const p = pickPop("_T");
    const m15 = pickPop("Y_LT15");
    const p65 = pickPop("Y_GE65");
    const lt = pickLog("_T");
    const rpri = pickLog("DW_MAIN");
    const vac = pickLog("DW_VAC");
    if (p === null && lt === null) {
      resultat.push({ ...i, indicateurs: null });
      sans.push({ ...i, raison: "Aucune valeur publiée par Melodi pour ce code IRIS (jeux population et logement) ; cause (IRIS non diffusé, non concerné ou code différent) non déterminée" });
      continue;
    }
    if (p !== null && m15 !== null && p65 !== null && m15 + p65 > p * 1.001 + 0.5) {
      avertissements.push("IRIS " + i.code_iris + " : moins de 15 ans + 65 ans et plus dépasse la population totale (incohérence de la source).");
    }
    if (p !== null) sommeIris += p;
    if (rp.annee !== null && (anneePop === null || rp.annee > anneePop)) anneePop = rp.annee;
    if (rl.annee !== null && (anneeLog === null || rl.annee > anneeLog)) anneeLog = rl.annee;
    resultat.push({
      ...i,
      indicateurs: {
        annee: rp.annee !== null ? rp.annee : rl.annee,
        population: arrondi(p), moins15: arrondi(m15), plus65: arrondi(p65),
        part_moins15: part(m15, p), part_plus65: part(p65, p),
        logements: arrondi(lt), residences_principales: arrondi(rpri), logements_vacants: arrondi(vac),
        part_residences_principales: part(rpri, lt), part_logements_vacants: part(vac, lt),
      },
    });
  }

  // — Contrôle indépendant : somme des IRIS vs total communal publié séparément par l'INSEE —
  let controle: RapportIris["rapport"]["controle_population"] = null;
  try {
    const obs = await lire(DS_POP_COM, [String(new Date().getUTCFullYear()) + "-" + (estArrondissement(commune) ? "ARM" : "COM") + "-" + commune], { RP_MEASURE: ["POP"], SEX: ["_T"], AGE: ["_T"] });
    let annee: number | null = null;
    for (const o of obs) { const y = Number(o.dimensions.TIME_PERIOD); if (isFinite(y) && (annee === null || y > annee)) annee = y; }
    const ligne = obs.find((o) => Number(o.dimensions.TIME_PERIOD) === anneePop) || obs.find((o) => Number(o.dimensions.TIME_PERIOD) === annee);
    const total = ligne ? valeur(ligne) : null;
    if (ligne && total !== null && total > 0) {
      const an = Number(ligne.dimensions.TIME_PERIOD);
      const ecart = arrondi(((sommeIris - total) / total) * 100, 2) as number;
      controle = { somme_iris: arrondi(sommeIris) as number, total_commune: arrondi(total) as number, ecart_pct: ecart, annee: an, verdict: Math.abs(ecart) <= 0.5 ? "coherent" : "ecart" };
      if (anneePop !== null && an !== anneePop) avertissements.push("Contrôle : total communal d'une autre année (" + an + ") que les IRIS (" + anneePop + ").");
      if (controle.verdict === "ecart") avertissements.push("Contrôle population : somme des IRIS " + controle.somme_iris + " ≠ total communal " + controle.total_commune + " (" + ecart + " %). Des IRIS manquent ou ne sont pas diffusés.");
    } else {
      avertissements.push("Contrôle population impossible : total communal non trouvé dans " + DS_POP_COM + ".");
    }
  } catch (e: any) {
    avertissements.push("Contrôle population non effectué : " + String((e && e.message) || e));
  }

  if (sans.length > 0) avertissements.push(sans.length + " IRIS sur " + liste.length + " sans donnée INSEE : leurs indicateurs restent vides (jamais mis à zéro).");
  avertissements.push("Les effectifs IRIS du recensement sont des estimations publiées avec décimales par l'INSEE ; ils sont arrondis à l'unité ici.");

  const rapport: RapportIris = {
    commune,
    genere_le: new Date().toISOString(),
    sources: {
      liste_iris: "IGN — STATISTICALUNITS.IRISGE:iris_ge",
      population: { jeu: DS_POP_IRIS, millesime_geo: pop.millesimes.join(", "), annee: anneePop },
      logement: { jeu: DS_LOG_IRIS, millesime_geo: log.millesimes.join(", "), annee: anneeLog },
    },
    iris: resultat,
    rapport: { iris_ign: liste.length, avec_donnees: resultat.filter((r) => r.indicateurs !== null).length, sans_donnees: sans, controle_population: controle },
    avertissements,
  };
  cacheRapports.set(commune, { t: Date.now(), r: rapport });
  return rapport;
}

/** Découpage légal des trois communes à arrondissements : l'IGN publie les IRIS par arrondissement, l'INSEE le total par arrondissement (niveau ARM). */
function suite(a: number, b: number): string[] { const l: string[] = []; for (let i = a; i <= b; i++) l.push(String(i)); return l; }
const ARRONDISSEMENTS: Record<string, string[]> = {
  "13055": suite(13201, 13216), // Marseille
  "69123": suite(69381, 69389), // Lyon
  "75056": suite(75101, 75120), // Paris
};
function estArrondissement(code: string): boolean {
  for (const k of Object.keys(ARRONDISSEMENTS)) if (ARRONDISSEMENTS[k].indexOf(code) >= 0) return true;
  return false;
}
const cacheAgregats = new Map<string, { t: number; r: RapportIris }>();

export async function indicateursIris(commune: string): Promise<RapportIris> {
  if (!CODE_COMMUNE.test(commune)) throw new Error("Code commune invalide : « " + commune + " » (5 caractères attendus)");
  const arr = ARRONDISSEMENTS[commune];
  if (!arr) return indicateursIrisCommune(commune);
  const memo = cacheAgregats.get(commune);
  if (memo && Date.now() - memo.t < DUREE_CACHE_MS) return memo.r;
  const rapports: RapportIris[] = [];
  for (let i = 0; i < arr.length; i += 4) {
    const lot = await Promise.all(arr.slice(i, i + 4).map((c) => indicateursIrisCommune(c)));
    for (const r of lot) rapports.push(r);
  }
  const avert: string[] = ["Commune à arrondissements : les IRIS de " + arr.length + " arrondissements (" + arr[0] + " à " + arr[arr.length - 1] + ") sont regroupés."];
  for (const r of rapports) for (const a of r.avertissements) if (avert.indexOf(a) < 0) avert.push(a);
  const controles = rapports.map((r) => r.rapport.controle_population);
  let controle: RapportIris["rapport"]["controle_population"] = null;
  if (controles.every((c) => c !== null)) {
    const somme = controles.reduce((n, c) => n + (c as any).somme_iris, 0);
    const total = controles.reduce((n, c) => n + (c as any).total_commune, 0);
    const ecart = total > 0 ? (arrondi(((somme - total) / total) * 100, 2) as number) : 0;
    const annees = Array.from(new Set(controles.map((c) => (c as any).annee)));
    controle = { somme_iris: somme, total_commune: total, ecart_pct: ecart, annee: annees.length === 1 ? (annees[0] as number | null) : null, verdict: Math.abs(ecart) <= 0.5 ? "coherent" : "ecart" };
  } else {
    avert.push("Contrôle population incomplet : au moins un arrondissement n'a pas pu être contrôlé.");
  }
  const agg: RapportIris = {
    commune, genere_le: new Date().toISOString(), sources: rapports[0].sources,
    iris: rapports.reduce((l: IrisLie[], r) => l.concat(r.iris), []),
    rapport: {
      iris_ign: rapports.reduce((n, r) => n + r.rapport.iris_ign, 0),
      avec_donnees: rapports.reduce((n, r) => n + r.rapport.avec_donnees, 0),
      sans_donnees: rapports.reduce((l: RapportIris["rapport"]["sans_donnees"], r) => l.concat(r.rapport.sans_donnees), []),
      controle_population: controle,
    },
    avertissements: avert,
  };
  cacheAgregats.set(commune, { t: Date.now(), r: agg });
  return agg;
}

/** Route HTTP : GET /liens/iris?commune=13005 — erreurs explicites (jamais de réponse partielle présentée comme complète). */
export async function routeLiens(req: any, res: any, pathname: string, url: string): Promise<boolean> {
  if (pathname !== "/liens/iris") return false;
  const code = new URL(url, "http://x").searchParams.get("commune") || "";
  try {
    const r = await indicateursIris(code);
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(r));
  } catch (e: any) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ erreur: String((e && e.message) || e) }));
  }
  return true;
}
