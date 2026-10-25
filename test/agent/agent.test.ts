/**
 * Tests de l'agent intégré — sans réseau externe : un faux modèle (API « chat completions » en flux) et une fausse session.
 */
import { createServer, type Server } from "http";
import type { AddressInfo } from "net";
import {
  routeAgent, agentStatus, sansReflexion, texteResultat, elaguer, adresse, debitOk,
  jetonsUtilises, noterJetons, reinitialiserEtat, blocContexte,
} from "../../src/agent/agent";

// ── faux modèle ──
type Reponse = { status?: number; headers?: Record<string, string>; fragments?: any[]; corps?: string };
const dernier = <T,>(a: T[]): any => a[a.length - 1];
let reponses: Reponse[] = [];
let requetesModele: any[] = [];
let llm: Server;

function sse(fragments: any[]) { return fragments.map((f) => "data: " + JSON.stringify(f) + "\n\n").join("") + "data: [DONE]\n\n"; }
const texte = (t: string, usage = { prompt_tokens: 100, completion_tokens: 20 }): Reponse => ({
  fragments: [{ choices: [{ delta: { content: t } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }, { choices: [], usage }],
});
const appel = (id: string, name: string, args: string, fin = "tool_calls"): Reponse => ({
  fragments: [{ choices: [{ delta: { tool_calls: [{ index: 0, id, function: { name, arguments: args } }] } }] }, { choices: [{ delta: {}, finish_reason: fin }] }, { choices: [], usage: { prompt_tokens: 100, completion_tokens: 10 } }],
});

// ── fausse session ──
function fausseSession() {
  let territoire = false;
  const appels: Array<{ name: string; args: any }> = [];
  return {
    appels,
    getContext: () => ({ level: territoire ? "commune" : null, code: "13005", name: "Marseille 5e", hierarchy: {}, layers: [] as any[] }),
    getSurface: (): any => null,
    getTools: () => [
      { name: "navigate", description: "naviguer", inputSchema: { type: "object", properties: {} } },
      { name: "action", description: territoire ? "ACTION AVEC TERRITOIRE" : "ACTION SANS TERRITOIRE : naviguez d'abord", inputSchema: { type: "object", properties: {} } },
      { name: "back", description: "retour", inputSchema: { type: "object", properties: {} } },
    ],
    handleToolCall: async (name: string, args: any) => {
      appels.push({ name, args });
      if (name === "navigate") territoire = true;
      return { content: [{ type: "text", text: "OK " + name }] };
    },
  } as any;
}

// ── serveur de l'agent ──
let srv: Server; let base = "";
const sessions = new Map<string, any>();
const ENV0 = { ...process.env };

beforeAll(async () => {
  llm = createServer((req, res) => {
    let corps = ""; req.on("data", (d) => (corps += d)); req.on("end", () => {
      requetesModele.push(JSON.parse(corps));
      const r = reponses.shift() || texte("(plus de réponse prévue)");
      res.writeHead(r.status ?? 200, { "Content-Type": "text/event-stream", ...(r.headers || {}) });
      res.end(r.corps ?? sse(r.fragments || []));
    });
  });
  await new Promise<void>((ok) => llm.listen(0, "127.0.0.1", ok));
  srv = createServer((req, res) => { routeAgent(req, res, (req.url || "").split("?")[0], sessions).catch((e) => { res.writeHead(500); res.end(String(e)); }); });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  base = "http://127.0.0.1:" + (srv.address() as AddressInfo).port;
});
afterAll(async () => { llm.closeAllConnections(); srv.closeAllConnections(); llm.close(); srv.close(); });

beforeEach(() => {
  reinitialiserEtat(); reponses = []; requetesModele = []; sessions.clear();
  process.env = { ...ENV0 };
  process.env.AGENT_LLM_BASE_URL = "http://127.0.0.1:" + (llm.address() as AddressInfo).port;
  process.env.AGENT_LLM_MODEL = "faux-modele";
  process.env.AGENT_LLM_RETRIES = "2";
});

async function chat(sid: string, message: string, entetes: Record<string, string> = {}, surEvenement?: (ev: any) => Promise<void>) {
  const r = await fetch(base + "/agent/chat", { method: "POST", headers: { "Content-Type": "application/json", "mcp-session-id": sid, ...entetes }, body: JSON.stringify({ message }) });
  if (r.status !== 200 || !r.headers.get("content-type")?.includes("event-stream")) return { status: r.status, corps: (await r.json()) as any, evenements: [] as any[] };
  const evenements: any[] = []; let reste = "";
  for await (const m of r.body as any) {
    reste += Buffer.from(m).toString("utf-8");
    let i: number;
    while ((i = reste.indexOf("\n\n")) >= 0) {
      const bloc = reste.slice(0, i); reste = reste.slice(i + 2);
      if (!bloc.startsWith("data:")) continue;
      const ev = JSON.parse(bloc.slice(5)); evenements.push(ev);
      if (surEvenement) await surEvenement(ev);
    }
  }
  return { status: 200, corps: null as any, evenements };
}
const accuser = (callId: string) => fetch(base + "/agent/ack", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ callId, ok: true, note: "affiché" }) });

describe("configuration", () => {
  test("agent désactivé sans modèle, avec la raison", () => {
    delete process.env.AGENT_LLM_BASE_URL;
    const st = agentStatus();
    expect(st.enabled).toBe(false);
    expect(st.reason).toMatch(/AGENT_LLM_BASE_URL/);
  });
  test("session de page inconnue : erreur explicite", async () => {
    const r = await chat("inconnue", "bonjour");
    expect(r.status).toBe(400);
  });
});

describe("tour complet", () => {
  test("outil → accusé de la page → réponse ; la liste d'outils est relue à chaque étape ; « back » n'est pas proposé", async () => {
    const s = fausseSession(); sessions.set("s1", s);
    reponses = [appel("c1", "navigate", '{"query":"Marseille"}'), texte("Voilà.")];
    const r = await chat("s1", "montre Marseille", {}, async (ev) => { if (ev.type === "tool_result" && ev.callId) await accuser(ev.callId); });
    expect(r.evenements.find((e) => e.type === "error")).toBeUndefined();
    expect(dernier(r.evenements).type).toBe("done");
    expect(s.appels).toEqual([{ name: "navigate", args: { query: "Marseille" } }]);
    expect(requetesModele).toHaveLength(2);
    const desc = (req: any) => req.tools.find((t: any) => t.function.name === "action").function.description;
    expect(desc(requetesModele[0])).toMatch(/SANS TERRITOIRE/);
    expect(desc(requetesModele[1])).toMatch(/AVEC TERRITOIRE/); // relue après navigate
    expect(requetesModele[0].tools.some((t: any) => t.function.name === "back")).toBe(false);
    // le résultat d'outil est présenté comme donnée, avec l'état réel de l'affichage
    const tool = requetesModele[1].messages.find((m: any) => m.role === "tool");
    expect(tool.content).toMatch(/DONNÉES D'OUTIL/);
    expect(tool.content).toMatch(/\[affichage\] affiché/);
  });

  test("affichage non confirmé par la page : dit au modèle, jamais supposé", async () => {
    process.env.AGENT_ACK_TIMEOUT_MS = "150";
    const s = fausseSession(); sessions.set("s2", s);
    reponses = [appel("c1", "navigate", "{}"), texte("Je n'ai pas pu confirmer.")];
    await chat("s2", "va");
    const tool = requetesModele[1].messages.find((m: any) => m.role === "tool");
    expect(tool.content).toMatch(/NON CONFIRMÉ/);
  });

  test("arguments JSON invalides : erreur rapportée au modèle, outil non exécuté", async () => {
    const s = fausseSession(); sessions.set("s3", s);
    reponses = [appel("c1", "navigate", "{pas du json"), texte("ok")];
    await chat("s3", "va");
    expect(s.appels).toHaveLength(0);
    expect(requetesModele[1].messages.find((m: any) => m.role === "tool").content).toMatch(/ERREUR : Arguments illisibles/);
  });

  test("appel d'outil coupé par la limite de sortie : erreur explicite, rien n'est exécuté, historique restauré", async () => {
    const s = fausseSession(); sessions.set("s4", s);
    reponses = [appel("c1", "navigate", '{"query":"Mar', "length")];
    const r = await chat("s4", "va");
    expect(dernier(r.evenements)).toMatchObject({ type: "error" });
    expect(dernier(r.evenements).message).toMatch(/coupée par la limite de sortie/);
    expect(s.appels).toHaveLength(0);
    reponses = [texte("ok")]; await chat("s4", "autre");
    expect(dernier(requetesModele).messages.filter((m: any) => m.role === "user")).toHaveLength(1);
  });

  test("limite d'étapes : dite à l'utilisateur", async () => {
    process.env.AGENT_MAX_STEPS = "2";
    const s = fausseSession(); sessions.set("s5", s);
    reponses = [appel("a", "back", "{}"), appel("b", "back", "{}"), appel("c", "back", "{}")];
    const r = await chat("s5", "boucle", {}, async (ev) => { if (ev.type === "tool_result" && ev.callId) await accuser(ev.callId); });
    expect(r.evenements.filter((e) => e.type === "text").map((e) => e.delta).join("")).toMatch(/Limite de 2 étapes/);
  });
});

describe("reprises du modèle", () => {
  test("429 puis succès : une reprise, le tour réussit", async () => {
    sessions.set("r1", fausseSession());
    reponses = [{ status: 429, headers: { "Retry-After": "0" }, corps: "{}" }, texte("bonjour")];
    const r = await chat("r1", "salut");
    expect(r.evenements.map((e) => e.type)).toContain("done");
    expect(requetesModele).toHaveLength(2);
  });
  test("erreur 400 : jamais rejouée, message clair", async () => {
    sessions.set("r2", fausseSession());
    reponses = [{ status: 400, corps: '{"error":"requête invalide"}' }];
    const r = await chat("r2", "salut");
    expect(requetesModele).toHaveLength(1);
    expect(dernier(r.evenements).message).toMatch(/HTTP 400/);
  });
  test("503 persistant : abandon après les reprises prévues, nombre dit", async () => {
    process.env.AGENT_LLM_RETRIES = "1";
    sessions.set("r3", fausseSession());
    reponses = [{ status: 503, headers: { "Retry-After": "0" }, corps: "{}" }, { status: 503, headers: { "Retry-After": "0" }, corps: "{}" }];
    const r = await chat("r3", "salut");
    expect(requetesModele).toHaveLength(2);
    expect(dernier(r.evenements).message).toMatch(/HTTP 503.*après 1 nouvelle/);
  });
  test("température omise sur demande ; clé jamais dans l'erreur", async () => {
    process.env.AGENT_TEMPERATURE = "none"; process.env.AGENT_LLM_API_KEY = "sk-secret-123";
    sessions.set("r4", fausseSession());
    reponses = [{ status: 401, corps: "Bearer sk-secret-123 refusé" }];
    const r = await chat("r4", "salut");
    expect(requetesModele[0].temperature).toBeUndefined();
    expect(JSON.stringify(r.evenements)).not.toMatch(/sk-secret-123/);
  });
});

describe("plafonds", () => {
  test("jetons par session : refus avant tout appel au modèle", async () => {
    process.env.AGENT_MAX_TOKENS_PER_HOUR = "150";
    sessions.set("t1", fausseSession());
    reponses = [texte("un")]; // 120 jetons
    expect(dernier((await chat("t1", "a")).evenements).type).toBe("done");
    reponses = [texte("deux")]; // 120 de plus : 240 ≥ 150 → le suivant est refusé
    await chat("t1", "b");
    const n = requetesModele.length;
    const r = await chat("t1", "c");
    expect(r.status).toBe(429);
    expect(r.corps.error).toMatch(/Plafond de consommation/);
    expect(requetesModele.length).toBe(n);
  });
  test("consommation estimée si le modèle ne donne pas son usage", async () => {
    sessions.set("t2", fausseSession());
    reponses = [{ fragments: [{ choices: [{ delta: { content: "réponse" } }] }, { choices: [{ delta: {}, finish_reason: "stop" }] }] }];
    await chat("t2", "a");
    expect(jetonsUtilises("s:t2")).toBeGreaterThan(0);
  });
  test("contexte trop volumineux : erreur explicite", async () => {
    process.env.AGENT_PROMPT_CHARS = "500";
    sessions.set("t3", fausseSession());
    const r = await chat("t3", "a");
    expect(dernier(r.evenements).message).toMatch(/dépasse la limite de 500/);
  });
  test("messages par session", async () => {
    process.env.AGENT_MAX_MSG_PER_HOUR = "1";
    sessions.set("t4", fausseSession());
    reponses = [texte("a")]; await chat("t4", "1");
    const r = await chat("t4", "2");
    expect(r.status).toBe(429);
  });
  test("X-Forwarded-For ignoré sans proxy de confiance : le plafond par adresse ne se contourne pas", async () => {
    process.env.AGENT_MAX_MSG_PER_HOUR_IP = "1";
    sessions.set("t5", fausseSession()); sessions.set("t6", fausseSession());
    reponses = [texte("a")]; await chat("t5", "1", { "x-forwarded-for": "1.1.1.1" });
    const r = await chat("t6", "2", { "x-forwarded-for": "2.2.2.2" });
    expect(r.status).toBe(429);
  });
});

describe("fonctions pures", () => {
  const req = (xf: string | undefined) => ({ headers: xf ? { "x-forwarded-for": xf } : {}, socket: { remoteAddress: "10.0.0.9" } }) as any;
  test("adresse : XFF seulement si proxy de confiance, et dernière entrée", () => {
    expect(adresse(req("1.2.3.4"), false)).toBe("10.0.0.9");
    expect(adresse(req("6.6.6.6, 1.2.3.4"), true)).toBe("1.2.3.4");
    expect(adresse(req(undefined), true)).toBe("10.0.0.9");
  });
  test("fenêtre glissante des messages et des jetons", () => {
    const t0 = 1_000_000;
    expect(debitOk("x", 2, t0)).toBe(true); expect(debitOk("x", 2, t0 + 1)).toBe(true); expect(debitOk("x", 2, t0 + 2)).toBe(false);
    expect(debitOk("x", 2, t0 + 3_600_001)).toBe(true);
    noterJetons("k", 50, t0); noterJetons("k", 25, t0 + 10);
    expect(jetonsUtilises("k", t0 + 20)).toBe(75);
    expect(jetonsUtilises("k", t0 + 3_600_005)).toBe(25);
  });
  test("purge : les adresses périmées sont oubliées", () => {
    const t0 = 5_000_000;
    debitOk("vieux", 5, t0); debitOk("autre", 5, t0 + 3_700_000);
    expect(debitOk("vieux", 1, t0 + 3_700_001)).toBe(true); // la fenêtre périmée n'occupe plus rien
  });
  test("sansReflexion : balises coupées entre deux paquets", () => {
    const f = sansReflexion(); let sortie = "";
    for (const p of ["avant <thi", "nk>caché</th", "ink> après"]) sortie += f(p);
    sortie += f.fin();
    expect(sortie.replace(/\s+/g, " ").trim()).toBe("avant après");
  });
  test("texteResultat : layerSpecs mises à part, texte tronqué avec mention", () => {
    const specs = { _type: "layerSpecs", layers: [{ id: "a" }] };
    const r = texteResultat({ content: [{ type: "text", text: "Bonjour\n" + JSON.stringify(specs) + "\nFin" }] }, 1000);
    expect(r.specs).toEqual([{ id: "a" }]);
    expect(r.texte).not.toMatch(/layerSpecs/);
    const long = texteResultat({ content: [{ type: "text", text: "x".repeat(50) }] }, 10);
    expect(long.texte).toMatch(/tronqué à 10 caractères; ?|tronqué à 10 caractères/);
  });
  test("elaguer : retire des tours entiers, jamais un résultat d'outil orphelin", () => {
    const h: any[] = [
      { role: "user", content: "a".repeat(100) }, { role: "assistant", content: null, tool_calls: [{ id: "1" }] }, { role: "tool", tool_call_id: "1", content: "b".repeat(100) }, { role: "assistant", content: "ok" },
      { role: "user", content: "c" }, { role: "assistant", content: "d" },
    ];
    elaguer(h, 100);
    expect(h[0].role).toBe("user");
    expect(h.some((m) => m.role === "tool")).toBe(false);
  });
  test("blocContexte : territoire, couche et comptes relus", () => {
    const b = blocContexte({ getContext: () => ({ level: "commune", name: "Lyon", code: "69123", hierarchy: {}, layers: [] as any[] }), getSurface: () => ({ couche: "routes", retenus: 12, total: 20, verifie: true, filtres: [] as any[], champs: [] as any[] }) } as any);
    expect(b).toMatch(/Lyon \(commune 69123\)/);
    expect(b).toMatch(/12 éléments retenus sur 20/);
  });
});

describe("consigne", () => {
  test("règles issues des essais avec un vrai modèle : pas de code de mémoire, demande complète, hors périmètre, observé seulement", async () => {
    sessions.set("p1", fausseSession());
    reponses = [texte("ok")];
    await chat("p1", "salut");
    const consigne: string = requetesModele[0].messages[0].content;
    expect(consigne).toMatch(/JAMAIS de code INSEE/);
    expect(consigne).toMatch(/reprends la demande d'origine complète/);
    expect(consigne).toMatch(/Fort-de-France/);
    expect(consigne).toMatch(/Tu ne décris que ce que tu as observé/);
    expect(consigne).toMatch(/Territoire exact/);
  });
});
