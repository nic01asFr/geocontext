/**
 * Fiche d'un territoire : élu exécutif (RNE) et mairie (annuaire de l'administration).
 *
 * Sources : Répertoire national des élus (data.gouv, Licence Ouverte 2.0) pour le maire, le président du conseil départemental
 * et le président du conseil régional ; Annuaire de l'administration (service-public.fr) pour la mairie.
 * Règles : aucune donnée inventée (une absence est dite, avec le millésime du fichier), aucune donnée personnelle superflue
 * (nom, prénom, fonction, début de fonction seulement), erreurs explicites.
 */

const DS = "https://www.data.gouv.fr/api/1/datasets/repertoire-national-des-elus-1/";
const PAGE_RNE = "https://www.data.gouv.fr/datasets/repertoire-national-des-elus-1";
const ANNUAIRE = "https://api-lannuaire.service-public.fr/api/explore/v2.1/catalog/datasets/api-lannuaire-administration/records";
const DUREE_CACHE_MS = 12 * 3600 * 1000;
const CODE_COMMUNE = /^(\d{2}|2A|2B)\d{3}$|^97[1-8]\d{2}$|^98\d{3}$/;
const CODE_DEP = /^(\d{2,3}|2A|2B)$/;
const CODE_REG = /^\d{2}$/;

export interface Elu { nom: string; prenom: string; fonction: string; debut_fonction: string | null }
interface Fichier { t: number; millesime: string; lignes: Map<string, Elu> }

export function lireCsv(texte: string): Array<Record<string, string>> {
  const t = texte.charCodeAt(0) === 0xfeff ? texte.slice(1) : texte;
  const lignes: string[][] = []; let cur: string[] = [], champ = "", q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { champ += '"'; i++; } else q = false; } else champ += c; }
    else if (c === '"') q = true;
    else if (c === ";") { cur.push(champ); champ = ""; }
    else if (c === "\n") { cur.push(champ.replace(/\r$/, "")); lignes.push(cur); cur = []; champ = ""; }
    else champ += c;
  }
  if (champ !== "" || cur.length) { cur.push(champ.replace(/\r$/, "")); lignes.push(cur); }
  const [ent, ...corps] = lignes;
  return corps.filter((l) => l.length > 1).map((l) => Object.fromEntries(ent.map((h, i) => [h, l[i] ?? ""])));
}

async function json(url: string): Promise<any> {
  const r = await fetch(url, { headers: { "User-Agent": "geocontext-fork" }, signal: AbortSignal.timeout(25_000) });
  if (!r.ok) throw new Error("HTTP " + r.status + " sur " + new URL(url).host);
  return r.json();
}

const caches = new Map<string, Fichier>();
const enCours = new Map<string, Promise<Fichier>>();

/** Charge un fichier du RNE (retrouvé par le motif de son nom : l'URL change à chaque mise à jour) et l'indexe par code. */
function charger(cle: string, motif: string, colCode: string, fonction: string | null, colFonction: string | null): Promise<Fichier> {
  const memo = caches.get(cle);
  if (memo && Date.now() - memo.t < DUREE_CACHE_MS) return Promise.resolve(memo);
  const deja = enCours.get(cle); if (deja) return deja;
  const p = (async () => {
    const ds = await json(DS);
    const res = (ds.resources || []).find((r: any) => String(r.title).includes(motif));
    if (!res) throw new Error("Fichier « " + motif + " » introuvable dans le jeu de données du répertoire des élus");
    const r = await fetch(res.url, { signal: AbortSignal.timeout(60_000) });
    if (!r.ok) throw new Error("Téléchargement du répertoire des élus : HTTP " + r.status);
    const lignes = new Map<string, Elu>();
    for (const l of lireCsv(await r.text())) {
      if (fonction && colFonction && l[colFonction] !== fonction) continue;
      const code = (l[colCode] || "").trim(); if (!code || lignes.has(code)) continue;
      lignes.set(code, { nom: l["Nom de l'élu"] || "", prenom: l["Prénom de l'élu"] || "", fonction: fonction || "Maire", debut_fonction: l["Date de début de la fonction"] || l["Date de début du mandat"] || null });
    }
    if (lignes.size === 0) throw new Error("Fichier « " + motif + " » lu mais vide : structure inattendue");
    const f: Fichier = { t: Date.now(), millesime: String(res.last_modified || ds.last_modified || "").slice(0, 10), lignes };
    caches.set(cle, f); return f;
  })().finally(() => enCours.delete(cle));
  enCours.set(cle, p); return p;
}

const fr = (iso: string) => (/^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(8, 10) + "/" + iso.slice(5, 7) + "/" + iso.slice(0, 4) : iso);

export async function fichElu(niveau: string, code: string) {
  let f: Fichier, libelle: string;
  if (niveau === "commune") {
    if (!CODE_COMMUNE.test(code)) throw new Error("Code commune invalide : « " + code + " »");
    f = await charger("maires", "elus-maires", "Code de la commune", null, null); libelle = "maire";
  } else if (niveau === "departement") {
    if (!CODE_DEP.test(code)) throw new Error("Code département invalide : « " + code + " »");
    f = await charger("cd", "conseillers-departementaux", "Code du département", "Président du conseil départemental", "Libellé de la fonction"); libelle = "président du conseil départemental";
  } else if (niveau === "region") {
    if (!CODE_REG.test(code)) throw new Error("Code région invalide : « " + code + " »");
    f = await charger("cr", "conseillers-regionaux", "Code de la région", "Président du conseil régional", "Libellé de la fonction"); libelle = "président du conseil régional";
  } else throw new Error("Niveau non pris en charge : « " + niveau + " » (commune, departement ou region)");
  const e = f.lignes.get(code) || null;
  return {
    niveau, code, etat: e ? "ok" : "absent", elu: e,
    message: e ? null : "Aucun " + libelle + " enregistré au répertoire des élus (version du " + fr(f.millesime) + "). Cela ne prouve pas que le poste soit vacant : la donnée peut être en retard ou non remontée.",
    source: { nom: "Répertoire national des élus", millesime: f.millesime, licence: "Licence Ouverte 2.0", url: PAGE_RNE },
  };
}

function parseListe(v: any, avert: string[], champ: string): any[] {
  if (v == null || v === "" || v === "[]") return [];
  if (Array.isArray(v)) return v;
  try { const x = JSON.parse(String(v)); return Array.isArray(x) ? x : []; } catch { avert.push("Champ « " + champ + " » illisible dans l'annuaire, non affiché"); return []; }
}

export async function ficheMairie(commune: string) {
  if (!CODE_COMMUNE.test(commune)) throw new Error("Code commune invalide : « " + commune + " »");
  const where = 'code_insee_commune="' + commune + '" and pivot like "mairie"';
  const d = await json(ANNUAIRE + "?limit=5&where=" + encodeURIComponent(where));
  const total = Number(d.total_count ?? (d.results || []).length);
  const avertissements: string[] = [];
  const mairies = (d.results || []).map((r: any) => {
    const adr = parseListe(r.adresse, avertissements, "adresse")[0];
    return {
      nom: r.nom || null,
      telephones: parseListe(r.telephone, avertissements, "téléphone").map((x: any) => x.valeur).filter(Boolean),
      sites: parseListe(r.site_internet, avertissements, "site internet").map((x: any) => x.valeur).filter(Boolean),
      courriel: r.adresse_courriel || null,
      adresse: adr ? [adr.numero_voie, [adr.code_postal, adr.nom_commune].filter(Boolean).join(" ")].filter(Boolean).join(", ") : null,
      modifie_le: r.date_modification || null,
    };
  });
  return {
    commune, etat: total === 0 ? "absente" : total === 1 ? "ok" : "plusieurs", total, mairies, avertissements,
    message: total === 0 ? "Mairie non référencée dans l'annuaire de l'administration pour ce code commune." : null,
    source: { nom: "Annuaire de l'administration (service-public.fr)", url: "https://lannuaire.service-public.fr/" },
  };
}

/** Routes HTTP : GET /liens/elus?niveau=commune|departement|region&code=…  et  GET /liens/mairie?commune=… */
export async function routeElus(req: any, res: any, pathname: string, url: string): Promise<boolean> {
  if (pathname !== "/liens/elus" && pathname !== "/liens/mairie") return false;
  const q = new URL(url, "http://x").searchParams;
  try {
    const r = pathname === "/liens/elus" ? await fichElu(q.get("niveau") || "", q.get("code") || "") : await ficheMairie(q.get("commune") || "");
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(JSON.stringify(r));
  } catch (e: any) {
    res.writeHead(502, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-cache" });
    res.end(JSON.stringify({ erreur: String((e && e.message) || e) }));
  }
  return true;
}
