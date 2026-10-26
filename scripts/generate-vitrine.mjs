// Génère docs/vitrine/index.html à partir de docs/vitrine/vitrine.json.
//
//   node scripts/generate-vitrine.mjs           écrit index.html
//   node scripts/generate-vitrine.mjs --verifier  échoue si index.html n'est pas à jour
//
// La fiche est la source ; ne pas retoucher index.html à la main. Format : voir docs/vitrine/SPEC.md.
// Le générateur refuse ce qu'il ne sait pas lire (champ inconnu, image absente, lien de doc vers un
// fichier qui n'existe pas) : un champ ignoré en silence est une erreur.
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dossier = path.join(racine, "docs", "vitrine");
const fiche = JSON.parse(fs.readFileSync(path.join(dossier, "vitrine.json"), "utf8"));

const HAUT = ["nom", "pitch", "couleur", "tags", "depot", "liensDocs", "constat", "points", "usages", "statut", "journal", "produit"];
const PRODUIT = ["eyebrow", "accroche", "chiffres", "titreContextes", "introContextes", "contextes", "titreSequence", "sequence",
  "architecture", "exploitation", "technique", "savoir", "docs", "pied"];
const erreurs = [];
const inconnus = (obj, permis, ou) => { for (const k of Object.keys(obj)) if (!permis.includes(k)) erreurs.push(`champ inconnu : ${ou}.${k}`); };
inconnus(fiche, HAUT, "fiche");
inconnus(fiche.produit ?? {}, PRODUIT, "produit");
for (const k of ["nom", "pitch", "couleur", "depot", "liensDocs"]) if (!fiche[k]) erreurs.push(`champ requis absent : ${k}`);
if (fiche.couleur && !/^#[0-9A-Fa-f]{6}$/.test(fiche.couleur)) erreurs.push("couleur : #RRGGBB attendu");

const e = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const paras = (s) => String(s).split(/\n\n+/).map((p) => `<p>${e(p)}</p>`).join("\n");
const lienDoc = (nom) => {
  if (!fs.existsSync(path.join(racine, "docs", nom))) erreurs.push(`doc introuvable : docs/${nom}`);
  return fiche.liensDocs + nom;
};
const p = fiche.produit ?? {};

function image(i) {
  const f = path.join(dossier, i.src);
  if (!fs.existsSync(f)) erreurs.push(`image introuvable : ${i.src}`);
  if (!i.alt) erreurs.push(`texte alternatif absent : ${i.src}`);
  return `<a href="${e(i.src)}"><img src="${e(i.src)}" width="1280" height="720" loading="lazy" alt="${e(i.alt)}"></a>`;
}

const hero = `<div class="wrap hero">
  ${p.eyebrow ? `<p class="eyebrow">${e(p.eyebrow)}</p>` : ""}
  <h1>${e(fiche.nom)}</h1>
  <p class="lead">${e(fiche.pitch)}</p>
  <p>${(fiche.tags ?? []).map((t) => `<span class="badge">${e(t)}</span>`).join("")}${fiche.statut ? `<span class="badge statut">${e(fiche.statut.niveau)}</span>` : ""}</p>
  <p><a class="bouton" href="${e(fiche.depot)}">Le code</a> <a class="bouton sec" href="#contextes">Voir des captures</a> <a class="bouton sec" href="#technique">Pour les équipes techniques</a></p>
</div>`;

const chiffres = !(p.chiffres ?? []).length ? "" : `<section class="chiffres"><div class="wrap">
  ${p.accroche ? `<p class="accroche">${e(p.accroche)}</p>` : ""}
  <ul>${p.chiffres.map((c) => `<li><strong>${e(c.valeur)}</strong><span>${e(c.libelle)}</span></li>`).join("")}</ul>
</div></section>`;

const constat = !fiche.constat ? "" : `<section id="constat"><div class="wrap">
  <h2>Le problème de départ</h2>
  <div class="texte">${paras(fiche.constat)}</div>
</div></section>`;

const contextes = !(p.contextes ?? []).length ? "" : `<section id="contextes"><div class="wrap">
  <h2>${e(p.titreContextes ?? "Ce que ça donne")}</h2>
  ${p.introContextes ? `<p class="intro">${e(p.introContextes)}</p>` : ""}
  ${p.contextes.map((c) => `<figure class="shot">
    ${(c.images ?? []).map(image).join("\n    ")}
    <figcaption><strong>${e(c.titre)}.</strong> ${e(c.texte)}${c.pourquoi ? ` <span class="pourquoi">${e(c.pourquoi)}</span>` : ""}</figcaption>
  </figure>`).join("\n  ")}
</div></section>`;

const sequence = !(p.sequence ?? []).length ? "" : `<section id="sequence"><div class="wrap">
  <h2>${e(p.titreSequence ?? "Comment on s'en sert")}</h2>
  <ol class="sequence">${p.sequence.map((s) => `<li><h3>${e(s.titre)}</h3><p>${e(s.texte)}</p></li>`).join("")}</ol>
</div></section>`;

const points = !(fiche.points ?? []).length ? "" : `<section id="principes"><div class="wrap">
  <h2>Ce qu'il fait, et pourquoi ainsi</h2>
  <div class="grid2">${fiche.points.map((x) => `<div class="card"><h3>${e(x.titre)}</h3><p>${e(x.texte)}</p></div>`).join("")}</div>
</div></section>`;

let architecture = "";
if (p.architecture) {
  const a = p.architecture;
  const svgf = path.join(dossier, a.schema);
  if (!fs.existsSync(svgf)) erreurs.push(`schéma introuvable : ${a.schema}`);
  architecture = `<section id="surfaces"><div class="wrap">
  <h2>${e(a.titre)}</h2>
  <p class="intro">${e(a.intro)}</p>
  ${fs.existsSync(svgf) ? fs.readFileSync(svgf, "utf8") : ""}
  <div class="grid2" style="margin-top:26px">${(a.cartes ?? []).map((c) => `<div class="card"><h3>${e(c.titre)}</h3><p>${e(c.texte)}</p></div>`).join("")}</div>
</div></section>`;
}

let technique = "";
if (p.technique) {
  const t = p.technique;
  technique = `<section id="technique"><div class="wrap">
  <h2>${e(t.titre)}</h2>
  <p class="intro">${e(t.intro)}</p>
  <div class="scroll"><table>
    <thead><tr><th>Sujet</th><th>Ce qui est fait</th><th>Où</th></tr></thead>
    <tbody>${t.lignes.map((l) => `<tr><td>${e(l.sujet)}</td><td>${e(l.fait)}</td><td>${l.ou?.doc ? `<a href="${e(lienDoc(l.ou.doc))}">${e(l.ou.libelle)}</a>` : `<code>${e(l.ou?.libelle ?? "")}</code>`}</td></tr>`).join("")}</tbody>
  </table></div>
  ${t.essayer ? `<h3 style="margin-top:28px">${e(t.essayerTitre ?? "Essayer")}</h3><pre><code>${e(t.essayer)}</code></pre>` : ""}
  ${t.essayerNote ? `<p>${e(t.essayerNote)}</p>` : ""}
</div></section>`;
}

const usages = !(fiche.usages ?? []).length ? "" : `<section id="usages"><div class="wrap">
  <h2>Usages</h2>
  <ul class="plain">${fiche.usages.map((u) => `<li><strong>${e(u.titre)}</strong> : ${e(u.texte)}</li>`).join("")}</ul>
</div></section>`;

const savoir = !p.savoir ? "" : `<section id="limites"><div class="wrap">
  <h2>${e(p.savoir.titre)}</h2>
  <p class="intro">${e(p.savoir.intro)}</p>
  ${fiche.statut ? `<p class="note"><strong>${e(fiche.statut.niveau)}.</strong> ${e(fiche.statut.texte)}</p>` : ""}
  <div class="grid2" style="margin-top:18px">${p.savoir.blocs.map((b) => `<div class="card"><h3>${e(b.titre)}</h3><ul class="plain">${b.items.map((i) => `<li>${e(i)}</li>`).join("")}</ul></div>`).join("")}</div>
</div></section>`;

const exploitation = !p.exploitation ? "" : `<section id="exploitation"><div class="wrap">
  <h2>${e(p.exploitation.titre)}</h2>
  <p class="intro">${e(p.exploitation.intro)}</p>
  <div class="scroll"><table>
    <thead><tr><th></th>${p.exploitation.colonnes.map((c) => `<th>${e(c)}</th>`).join("")}</tr></thead>
    <tbody>${p.exploitation.lignes.map((l) => `<tr><td><strong>${e(l.critere)}</strong></td><td>${e(l.a)}</td><td>${e(l.b)}</td></tr>`).join("")}</tbody>
  </table></div>
</div></section>`;

const journal = !(fiche.journal ?? []).length ? "" : `<section id="journal"><div class="wrap">
  <h2>Journal</h2>
  <ul class="plain">${fiche.journal.map((j) => `<li><strong>${e(j.version)}</strong> : ${e(j.texte)}</li>`).join("")}</ul>
</div></section>`;

const docs = !(p.docs ?? []).length ? "" : `<section id="docs"><div class="wrap">
  <h2>Documentation</h2>
  <ul class="plain">${p.docs.map((d) => `<li><a href="${e(lienDoc(d.doc))}">${e(d.libelle)}</a></li>`).join("")}</ul>
</div></section>`;

const nav = [["#contextes", "Captures"], ["#sequence", "Cycle"], ["#surfaces", "Deux modes"], ["#technique", "Technique"], ["#limites", "Limites"]]
  .map(([h, l]) => `<a href="${h}">${l}</a>`).join("\n      ");

const css = `
  :root { --bg:#fff; --bg2:#f4f7f8; --ink:#182026; --muted:#55646d; --line:#d9e1e5; --accent:${fiche.couleur}; --accent-soft:#e3eff3; --warn-bg:#fff6e5; --warn-ink:#6b4a00; }
  @media (prefers-color-scheme: dark) { :root { --bg:#12171a; --bg2:#1a2125; --ink:#e6ecef; --muted:#9fb0b8; --line:#2c373d; --accent:#6fb7cf; --accent-soft:#1b2e36; --warn-bg:#2b2412; --warn-ink:#e8cf8a; } }
  * { box-sizing:border-box; } html { scroll-behavior:smooth; }
  body { margin:0; background:var(--bg); color:var(--ink); font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  a { color:var(--accent); }
  code { font:.9em ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--bg2); padding:.1em .35em; border-radius:4px; }
  pre { background:var(--bg2); border:1px solid var(--line); border-radius:8px; padding:14px 16px; overflow-x:auto; font:.88em/1.5 ui-monospace,SFMono-Regular,Menlo,monospace; }
  pre code { background:none; padding:0; }
  .wrap { max-width:1040px; margin:0 auto; padding:0 20px; }
  header.top { border-bottom:1px solid var(--line); background:var(--bg2); }
  header.top .wrap { display:flex; flex-wrap:wrap; align-items:center; justify-content:space-between; gap:8px 24px; padding-top:12px; padding-bottom:12px; }
  .brand { font-weight:700; font-size:1.1rem; color:var(--accent); }
  nav a { margin-right:16px; text-decoration:none; font-size:.92rem; } nav a:hover { text-decoration:underline; }
  .hero { padding:56px 20px 30px; }
  .eyebrow { font-size:.78rem; letter-spacing:.12em; text-transform:uppercase; color:var(--muted); margin:0 0 8px; }
  .hero h1 { font-size:clamp(1.8rem,4vw,2.5rem); line-height:1.2; margin:0 0 14px; }
  .hero p.lead { font-size:1.15rem; color:var(--muted); max-width:46em; margin:0 0 18px; }
  .badge { display:inline-block; font-size:.82rem; border:1px solid var(--line); color:var(--muted); padding:2px 10px; border-radius:999px; margin:0 6px 6px 0; }
  .badge.statut { border-color:var(--accent); color:var(--accent); }
  .bouton { display:inline-block; background:var(--accent); color:var(--bg); text-decoration:none; padding:8px 16px; border-radius:8px; font-weight:600; margin:4px 8px 4px 0; }
  .bouton.sec { background:none; color:var(--accent); border:1px solid var(--accent); }
  section { padding:36px 0; border-top:1px solid var(--line); }
  section h2 { font-size:1.5rem; margin:0 0 8px; line-height:1.3; }
  p.intro { color:var(--muted); max-width:46em; margin:0 0 22px; }
  .texte { max-width:46em; }
  h3 { font-size:1.08rem; margin:0 0 6px; }
  .chiffres { background:var(--bg2); padding:26px 0; }
  .chiffres .accroche { font-size:1.1rem; margin:0 0 14px; }
  .chiffres ul { list-style:none; padding:0; margin:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(170px,1fr)); gap:14px; }
  .chiffres strong { display:block; font-size:2rem; color:var(--accent); line-height:1.1; }
  .chiffres span { color:var(--muted); font-size:.92rem; }
  .grid2 { display:grid; grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); gap:18px; }
  .card { border:1px solid var(--line); border-radius:10px; padding:16px 18px; background:var(--bg); } .card p { margin:6px 0 0; color:var(--muted); font-size:.95rem; }
  figure.shot { margin:0 0 34px; } figure.shot img { width:100%; height:auto; display:block; border:1px solid var(--line); border-radius:10px; }
  figure.shot figcaption { margin-top:10px; font-size:.95rem; color:var(--muted); max-width:52em; } figure.shot figcaption strong { color:var(--ink); }
  .pourquoi { display:block; margin-top:4px; font-style:italic; }
  ol.sequence { list-style:none; counter-reset:s; padding:0; margin:0; display:grid; grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); gap:14px; }
  ol.sequence li { counter-increment:s; border:1px solid var(--line); border-radius:10px; padding:14px 16px; }
  ol.sequence li::before { content:counter(s); display:inline-block; width:1.6em; height:1.6em; line-height:1.6em; text-align:center; border-radius:50%; background:var(--accent-soft); color:var(--accent); font-weight:700; margin-bottom:6px; }
  ol.sequence p { margin:4px 0 0; color:var(--muted); font-size:.93rem; }
  .note { background:var(--warn-bg); color:var(--warn-ink); border-radius:8px; padding:12px 16px; font-size:.95rem; max-width:46em; }
  table { border-collapse:collapse; width:100%; font-size:.93rem; } th,td { text-align:left; padding:8px 10px; border-bottom:1px solid var(--line); vertical-align:top; } th { color:var(--muted); font-weight:600; }
  .scroll { overflow-x:auto; }
  svg.diag { width:100%; height:auto; max-width:900px; display:block; margin:0 auto; }
  svg.diag text { font:13px system-ui,sans-serif; fill:var(--ink); } svg.diag .t2 { fill:var(--muted); font-size:11.5px; }
  svg.diag .col { fill:none; stroke:var(--line); stroke-width:1.2; stroke-dasharray:5 4; } svg.diag .box { fill:var(--bg); stroke:var(--line); stroke-width:1.2; } svg.diag .core { fill:var(--accent-soft); stroke:var(--accent); stroke-width:1.4; } svg.diag .arrow { stroke:var(--muted); stroke-width:1.3; fill:none; }
  ul.plain { padding-left:1.2em; margin:8px 0; } ul.plain li { margin:4px 0; }
  footer { border-top:1px solid var(--line); padding:28px 0 48px; color:var(--muted); font-size:.9rem; background:var(--bg2); }
  .skip { position:absolute; left:-999px; } .skip:focus { left:8px; top:8px; background:var(--bg); padding:6px 10px; z-index:9; }`;

const html = `<!doctype html>
<!-- Généré par scripts/generate-vitrine.mjs depuis vitrine.json : ne pas modifier à la main. -->
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(fiche.nom)} — contexte territorial pour assistants et interfaces</title>
<meta name="description" content="${e(fiche.pitch)}">
<style>${css}
</style>
</head>
<body>
<a class="skip" href="#contenu">Aller au contenu</a>
<header class="top"><div class="wrap">
  <span class="brand">${e(fiche.nom)}</span>
  <nav aria-label="Sections">
      ${nav}
  </nav>
</div></header>
<main id="contenu">
${[hero, chiffres, constat, contextes, sequence, points, architecture, exploitation, technique, usages, savoir, journal, docs].filter(Boolean).join("\n\n")}
</main>
<footer><div class="wrap"><p>${e(p.pied ?? "")}</p></div></footer>
</body>
</html>
`;

if (erreurs.length) { console.error("Vitrine non générée :\n- " + erreurs.join("\n- ")); process.exit(1); }
const cible = path.join(dossier, "index.html");
if (process.argv.includes("--verifier")) {
  const actuel = fs.existsSync(cible) ? fs.readFileSync(cible, "utf8") : "";
  if (actuel !== html) { console.error("docs/vitrine/index.html n'est pas à jour : relancer scripts/generate-vitrine.mjs"); process.exit(1); }
  console.log("index.html à jour");
} else {
  fs.writeFileSync(cible, html);
  console.log("écrit", path.relative(racine, cible), `(${html.length} octets)`);
}
