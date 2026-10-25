// Captures d'écran de la page vitrine (docs/vitrine/img/).
//
// Usage : node scripts/capture-vitrine.mjs [scénario]
//   scénarios : commune, zonages, filtre, parcelle, hex, agent (tous par défaut)
//
// Prérequis : `npm i --no-save playwright` + un navigateur Chromium, et un serveur
// démarré en HTTP (TRANSPORT_TYPE=http npm start). L'agent demande en plus AGENT_*.
//   GEOCONTEXT_URL  adresse du serveur (défaut http://localhost:3000/)
//   OUT_DIR         dossier de sortie (défaut ./capture-out)
//
// Les images publiées sont ensuite converties en WebP 1280×720 (qualité 70), p. ex. avec sharp.
// Les captures dépendent des données réelles de la Géoplateforme au moment où elles sont
// faites : les comptes affichés peuvent différer de ceux de la vitrine.
import { chromium } from "playwright";
import fs from "fs";

const URL = process.env.GEOCONTEXT_URL ?? "http://localhost:3000/";
const OUT = process.env.OUT_DIR ?? "capture-out";
fs.mkdirSync(OUT, { recursive: true });
const only = process.argv[2];

const browser = await chromium.launch({
  // rendu WebGL logiciel, utile sans GPU (serveur, conteneur)
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--no-sandbox"],
});
const p = await browser.newPage({ viewport: { width: 1440, height: 810 } });
await p.goto(URL, { waitUntil: "load" });
await p.waitForFunction(() => window.GeoMap?.el && typeof GeoMap.el.ping === "function", null, { timeout: 30000 });

const nav = async (texte) => {
  await p.fill("#search-input", texte);
  await p.click("#search-btn");
  await p.waitForFunction(() => GeoState.context && GeoState.context.code, null, { timeout: 30000 });
  await p.waitForTimeout(3000);
};
const act = async (action, ms = 12000) => {
  await p.evaluate((a) => GeoState.emit("action-request", a), action);
  await p.waitForTimeout(ms);
};
const shot = async (nom) => {
  await p.screenshot({ path: `${OUT}/${nom}.jpg`, type: "jpeg", quality: 80 });
  console.log("ok", nom);
};
const etat = () =>
  p.evaluate(() => {
    const e = DataPanel.etatPublic?.();
    return JSON.stringify({ couche: e?.couche, total: e?.total, verifie: e?.verifie });
  });

const scenarios = {
  async commune() { await nav("13022"); await shot("commune"); },
  async zonages() { await nav("13022"); await act("urbanisme", 5000); await act("zonages", 20000); console.log(await etat()); await shot("zonages-ecartes"); },
  async filtre() {
    await nav("13022"); await act("urbanisme", 5000); await act("zonages", 20000);
    const r = await p.evaluate(() => DataPanel.applyOp({ operation: "filter", layer: "urba_zonages", field: "typezone", values: ["U"] }));
    console.log(JSON.stringify(r).slice(0, 300));
    await p.waitForTimeout(8000); console.log(await etat()); await shot("filtre-tableau-carte");
  },
  async parcelle() {
    await nav("13022000CE0185");
    await act("urbanisme", 5000); await act("zonage", 12000);
    await act("bati", 5000); await act("batiments", 20000);
    console.log(await etat()); await shot("parcelle-batiments");
  },
  async hex() {
    await nav("13022"); await act("energie", 5000); await act("dpe_commune", 30000);
    console.log(await etat());
    await p.selectOption(".dp-v-forme", "hex"); await p.waitForTimeout(12000);
    await shot("points-hexagones");
  },
  async agent() {
    await p.click("#chat-toggle"); await p.waitForTimeout(1500);
    await p.fill("#chat-input", "Combien de bâtiments sur la parcelle 13022000CE0185, et quels sont leurs usages ?");
    await p.click("#chat-send");
    // on attend que la réponse cesse d'évoluer (4 relevés identiques)
    const t0 = Date.now(); let dernier = "", stable = 0;
    while (Date.now() - t0 < 150000) {
      await p.waitForTimeout(4000);
      const t = await p.evaluate(() => document.getElementById("chat-messages").innerText);
      if (t === dernier) stable++; else { stable = 0; dernier = t; }
      if (stable >= 4 && t.length > 600) break;
    }
    await p.waitForTimeout(3000);
    await shot("agent");
  },
};

for (const [nom, f] of Object.entries(scenarios)) {
  if (only && only !== nom) continue;
  try { await f(); } catch (e) { console.log("ÉCHEC", nom, String(e.message).slice(0, 150)); }
}
await browser.close();
