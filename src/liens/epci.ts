/**
 * Fiche d'un EPCI à fiscalité propre : BANATIC (DGCL, Licence Ouverte 2.0) + contrôle de concordance de sa composition
 * avec ADMIN EXPRESS (IGN) calculé à la demande. Un écart est signalé, jamais gommé.
 *
 * Les fichiers sont retrouvés par l'identifiant stable de leur ressource data.gouv (…/datasets/r/<id> renvoie la dernière version).
 */
import { lireCsv } from "./elus.js";

const PAGE = "https://www.data.gouv.fr/datasets/base-nationale-sur-les-intercommunalites/";
const RES = (id: string) => "https://www.data.gouv.fr/api/1/datasets/r/" + id;
const R_COMPOSITION = "6e05c448-62cc-4470-aa0f-4f31adea0bc4"; // EPCI à fiscalité propre : une ligne par commune membre
const R_COORDONNEES = "c4cdd239-c82d-41ac-b0fb-530cccbab108"; // groupements : nature, président, population, coordonnées
const R_LISTE = "25571b3e-a5ce-4567-bfb4-650504644d7b"; // groupements : nombre de compétences exercées
const WFS = "https://data.geopf.fr/wfs/ows";
const DUREE_CACHE_MS = 12 * 3600 * 1000;
const SIREN = /^\d{9}$/;

interface Base { t: number; maj: string | null; groupements: Map<string, Record<string, string>>; competences: Map<string, string>; membres: Map<string, string[]>; noms: Map<string, string> }
let cache: Base | null = null; let enCours: Promise<Base> | null = null;

async function texte(url: string): Promise<{ txt: string; maj: string | null }> {
  const r = await fetch(url, { signal: AbortSignal.timeout(60_000), redirect: "follow" });
  if (!r.ok) throw new Error("Téléchargement BANATIC : HTTP " + r.status);
  const buf = new Uint8Array(await r.arrayBuffer());
  let txt: string;
  try { txt = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { txt = new TextDecoder("windows-1252").decode(buf); }
  const lm = r.headers.get("last-modified");
  return { txt, maj: lm ? new Date(lm).toISOString().slice(0, 10) : null };
}

function charger(): Promise<Base> {
  if (cache && Date.now() - cache.t < DUREE_CACHE_MS) return Promise.resolve(cache);
  if (enCours) return enCours;
  enCours = (async () => {
    const [c, l, m] = await Promise.all([texte(RES(R_COORDONNEES)), texte(RES(R_LISTE)), texte(RES(R_COMPOSITION))]);
    const groupements = new Map<string, Record<string, string>>();
    for (const x of lireCsv(c.txt)) if (x["N° SIREN"]) groupements.set(x["N° SIREN"].trim(), x);
    const competences = new Map<string, string>();
    for (const x of lireCsv(l.txt)) if (x["N° SIREN"]) competences.set(x["N° SIREN"].trim(), x["Nombre de compétences exercées"] || "");
    const membres = new Map<string, string[]>(), noms = new Map<string, string>();
    for (const x of lireCsv(m.txt)) {
      const s = (x["siren"] || "").trim(), insee = (x["insee"] || "").trim(); if (!s || !insee) continue;
      (membres.get(s) || membres.set(s, []).get(s)!).push(insee); noms.set(insee, x["nom_membre"] || "");
    }
    if (groupements.size === 0 || membres.size === 0) throw new Error("Fichiers BANATIC lus mais vides : structure inattendue");
    cache = { t: Date.now(), maj: c.maj || m.maj, groupements, competences, membres, noms };
    return cache;
  })().finally(() => { enCours = null; });
  return enCours;
}

async function communesAdminExpress(siren: string): Promise<string[]> {
  const q = new URLSearchParams({ service: "WFS", version: "2.0.0", request: "GetFeature", typeNames: "ADMINEXPRESS-COG.LATEST:commune", outputFormat: "application/json",
    cql_filter: "codes_siren_des_epci LIKE '%" + siren + "%'", propertyName: "code_insee,codes_siren_des_epci", count: "2000" });
  const r = await fetch(WFS + "?" + q.toString(), { signal: AbortSignal.timeout(40_000) });
  if (!r.ok) throw new Error("ADMIN EXPRESS (WFS IGN) : HTTP " + r.status);
  const d: any = await r.json();
  if (typeof d.numberMatched === "number" && d.numberMatched > (d.features || []).length) throw new Error("ADMIN EXPRESS : réponse tronquée (" + d.features.length + " sur " + d.numberMatched + ")");
  return (d.features || []).filter((f: any) => String(f.properties.codes_siren_des_epci || "").split(/[,/]/).map((x) => x.trim()).includes(siren)).map((f: any) => String(f.properties.code_insee));
}

const nz = (v: string | undefined) => (v && v.trim() ? v.trim() : null);

export async function ficheEpci(siren: string) {
  if (!SIREN.test(siren)) throw new Error("SIREN invalide : « " + siren + " » (9 chiffres attendus)");
  const b = await charger();
  const g = b.groupements.get(siren);
  if (!g) {
    return { siren, etat: "absent", message: "EPCI absent de BANATIC (fichier du " + (b.maj || "date inconnue") + ").", source: { nom: "BANATIC (DGCL)", licence: "Licence Ouverte 2.0", url: PAGE, maj: b.maj } };
  }
  const bmembres = (b.membres.get(siren) || []).slice().sort();
  let ae: string[] | null = null, erreurAe: string | null = null;
  try { ae = (await communesAdminExpress(siren)).sort(); } catch (e: any) { erreurAe = String((e && e.message) || e); }
  let concordance: any;
  if (bmembres.length === 0) {
    concordance = { verdict: "non_applicable", banatic: 0, admin_express: ae ? ae.length : null, raison: "Le fichier de composition de BANATIC ne couvre que les EPCI à fiscalité propre : la liste des communes membres de cette nature de groupement (" + (nz(g["Nature juridique"]) || "inconnue") + ") n'y figure pas, la concordance n'est pas contrôlable." };
  } else if (ae) {
    const sa = new Set(ae), sb = new Set(bmembres);
    const enPlusAe = ae.filter((x) => !sb.has(x)), enPlusBanatic = bmembres.filter((x) => !sa.has(x));
    concordance = { verdict: enPlusAe.length === 0 && enPlusBanatic.length === 0 ? "identique" : "ecart", banatic: bmembres.length, admin_express: ae.length,
      seulement_admin_express: enPlusAe, seulement_banatic: enPlusBanatic.map((c) => ({ code: c, nom: b.noms.get(c) || "" })) };
  } else concordance = { verdict: "non_verifie", banatic: bmembres.length, raison: erreurAe };
  const pres = [nz(g["Civilité Président"]), nz(g["Prénom Président"]), nz(g["Nom Président"])].filter(Boolean).join(" ");
  return {
    siren, etat: "ok",
    nom: nz(g["Nom du groupement"]), nature: nz(g["Nature juridique"]), financement: nz(g["Mode de financement"]), cree_le: nz(g["Date de création"]),
    siege: nz(g["Commune siège"]), departement_siege: nz(g["Département"]), population: g["Population totale"] ? Number(String(g["Population totale"]).replace(/\s/g, "")) : null,
    president: pres || null, membres: nz(g["Nombre de membres"]) ? Number(g["Nombre de membres"]) : null, competences: nz(b.competences.get(siren)) ? Number(b.competences.get(siren)) : null,
    telephone: nz(g["Téléphone du siège"]), courriel: nz(g["Courriel du siège"]), site: nz(g["Site internet du siège"]),
    concordance,
    source: { nom: "BANATIC (DGCL)", licence: "Licence Ouverte 2.0", url: PAGE, maj: b.maj },
  };
}

/** Route HTTP : GET /liens/epci?siren=200054807 */
export async function routeEpci(req: any, res: any, pathname: string, url: string): Promise<boolean> {
  if (pathname !== "/liens/epci") return false;
  try {
    const r = await ficheEpci(new URL(url, "http://x").searchParams.get("siren") || "");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(r));
  } catch (e: any) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ erreur: String((e && e.message) || e) }));
  }
  return true;
}
