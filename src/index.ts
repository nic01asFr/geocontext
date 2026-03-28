/**
 * geocontext — MCP Server Entry Point
 *
 * Démarre le serveur MCP avec tools dynamiques et resources pilotés par la session.
 *
 * Architecture :
 *   - configureServer() configure les handlers tools + resources sur un Server
 *   - Chaque Server a sa propre GeoContextSession (1 session = 1 contexte)
 *
 * Transports :
 *   - TRANSPORT_TYPE=stdio (défaut) → 1 Server, 1 StdioServerTransport
 *   - TRANSPORT_TYPE=http → 1 Server par connexion, StreamableHTTPServerTransport
 *
 * @see docs/navigation-context.md — cycle de navigation
 * @see docs/dynamic-tools.md — surface de tools dynamique
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
  ListPromptsRequestSchema,
  GetPromptRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { dirname, join, extname } from "path";
import { fileURLToPath } from "url";
import { readFileSync, existsSync, createReadStream, statSync } from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { randomUUID } from "crypto";

import { GeoContextSession } from "./session/session.js";
import { registry } from "./session/registry/index.js";
import { THEME_META } from "./session/registry/tree.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkgMetadata = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION: string = pkgMetadata.version;

// ==========================================================================
// Configuration du serveur MCP (tools + resources)
// ==========================================================================

/**
 * Configure les handlers tools et resources sur un Server MCP.
 * Chaque appel crée une GeoContextSession dédiée.
 */
function configureServer(server: Server): GeoContextSession {
  const session = new GeoContextSession(server);

  // --------------------------------------------------------------------
  // Tools
  // --------------------------------------------------------------------

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: session.getTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return session.handleToolCall(name, args ?? {});
  });

  // --------------------------------------------------------------------
  // Resources
  // --------------------------------------------------------------------

  /**
   * resources/list — resources dynamiques selon le contexte.
   *
   *   geocontext://context           — toujours (état courant)
   *   geocontext://themes/{level}    — quand territoire résolu
   *   geocontext://actions/{theme}   — quand thème actif
   *   geocontext://layers            — quand couches géo chargées
   */
  server.setRequestHandler(ListResourcesRequestSchema, async () => {
    const ctx = session.getContext();
    const resources: Array<{
      uri: string;
      name: string;
      description: string;
      mimeType: string;
    }> = [];

    resources.push({
      uri: "geocontext://context",
      name: "Contexte de navigation",
      description: "État courant : territoire, thème, données, couches",
      mimeType: "application/json",
    });

    if (ctx.level) {
      resources.push({
        uri: `geocontext://themes/${ctx.level}`,
        name: `Thèmes — ${ctx.name ?? ctx.level}`,
        description: `Thèmes disponibles pour ${ctx.name ?? ctx.level}`,
        mimeType: "application/json",
      });
    }

    if (ctx.level && ctx.theme) {
      resources.push({
        uri: `geocontext://actions/${ctx.theme}`,
        name: `Actions — ${THEME_META[ctx.theme].label}`,
        description: `Actions dans ${THEME_META[ctx.theme].label}`,
        mimeType: "application/json",
      });
    }

    if (ctx.layers.length > 0) {
      resources.push({
        uri: "geocontext://layers",
        name: "Couches cartographiques",
        description: `${ctx.layers.length} couche(s) active(s)`,
        mimeType: "application/json",
      });
    }

    return { resources };
  });

  /**
   * resources/read — contenu d'une resource.
   */
  // --------------------------------------------------------------------
  // Prompts — guide contextuel pour le LLM
  // --------------------------------------------------------------------

  /**
   * prompts/list — expose un prompt de guide d'utilisation.
   *
   * Le prompt "geocontext-guide" donne au LLM un aperçu complet du
   * cycle de navigation, des outils et des ressources disponibles.
   * Il sert de contexte système enrichi pour orienter les conversations.
   */
  server.setRequestHandler(ListPromptsRequestSchema, async () => ({
    prompts: [
      {
        name: "geocontext-guide",
        description: "Guide d'utilisation du service geocontext — navigation territoriale et données thématiques",
      },
    ],
  }));

  server.setRequestHandler(GetPromptRequestSchema, async (request) => {
    const { name } = request.params;

    if (name === "geocontext-guide") {
      const ctx = session.getContext();
      const contextSummary = ctx.level
        ? `Contexte actuel : ${ctx.name} (${ctx.level}, ${ctx.code})${ctx.theme ? ` · thème ${ctx.theme}` : ""}.`
        : "Aucun territoire sélectionné.";

      return {
        description: "Guide geocontext — navigation et données territoriales France",
        messages: [
          {
            role: "user" as const,
            content: {
              type: "text" as const,
              text: `Tu as accès au service geocontext — assistant de navigation spatiale pour les territoires français.

${contextSummary}

## Cycle de navigation

1. **navigate("lieu")** — résoudre un territoire (commune, département, EPCI, parcelle, coordonnées)
2. **action("thème")** — sélectionner un thème et charger les données de synthèse
3. **action("sous-action")** — charger une donnée spécifique (cross-thème résolu automatiquement)
4. **compare("thème2")** — croiser deux thématiques sur le même territoire
5. **select("id")** — naviguer vers une feature spécifique (parcelle, bâtiment)
6. **map("opération", "couche")** — visualiser, filtrer ou thématiser une couche

## Thèmes disponibles

identite, urbanisme, cadastre, risques, environnement, transport, hydrologie, economie, bati

## Ressources MCP (état de session)

- \`geocontext://context\` — état complet : territoire, hiérarchie, thème, couches, données
- \`geocontext://themes/{level}\` — thèmes et actions disponibles pour le niveau courant
- \`geocontext://actions/{theme}\` — actions et filtres du thème actif
- \`geocontext://layers\` — couches cartographiques actives

## Interface cartographique

Les données géographiques sont visualisables via l'interface web intégrée au service.
Les résultats d'actions incluent des layerSpecs pour le rendu direct sur carte.

## Conseils d'utilisation

- Les actions cross-thème sont résolues automatiquement (ex: action("radon") sans avoir fait action("risques"))
- Lire \`geocontext://context\` pour connaître l'état exact de la session
- Les filtres s'ajoutent via le paramètre filter: {"key": "value"} dans action()`,
            },
          },
        ],
      };
    }

    throw new Error(`Prompt inconnu : ${name}`);
  });

  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const { uri } = request.params;
    const ctx = session.getContext();

    if (uri === "geocontext://context") {
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            level: ctx.level,
            code: ctx.code,
            name: ctx.name,
            bbox: ctx.bbox,
            hierarchy: ctx.hierarchy,
            theme: ctx.theme,
            themes: ctx.level ? registry.getThemes(ctx.level) : [],
            layerCount: ctx.layers.length,
            dataKeys: Object.keys(ctx.data),
            historyDepth: ctx.history.length,
          }, null, 2),
        }],
      };
    }

    if (uri.startsWith("geocontext://themes/") && ctx.level) {
      const themes = registry.getThemes(ctx.level);
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            level: ctx.level,
            name: ctx.name,
            themes: themes.map((t) => ({
              id: t,
              label: THEME_META[t].label,
              description: THEME_META[t].description,
              icon: THEME_META[t].icon,
              actions: registry.getActions(ctx.level!, t),
            })),
          }, null, 2),
        }],
      };
    }

    if (uri.startsWith("geocontext://actions/") && ctx.level && ctx.theme) {
      const actionDefs = registry.getActionDefs(ctx.level, ctx.theme);
      const sources = registry.getSources(ctx.level, ctx.theme);
      const filterDefs = sources
        .flatMap((s) => s.userFilters ?? [])
        .filter((f, i, arr) => arr.findIndex((x) => x.key === f.key) === i);

      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            theme: ctx.theme,
            label: THEME_META[ctx.theme].label,
            actions: actionDefs,
            filters: filterDefs.map((f) => ({ key: f.key, label: f.label, type: f.type })),
          }, null, 2),
        }],
      };
    }

    if (uri === "geocontext://layers") {
      return {
        contents: [{
          uri,
          mimeType: "application/json",
          text: JSON.stringify({
            layers: ctx.layers.map((l) => ({
              name: l.name,
              visible: l.visible,
              featureCount: l.featureCount ?? 0,
              style: l.style,
            })),
          }, null, 2),
        }],
      };
    }

    throw new Error(`Resource inconnue : ${uri}`);
  });

  return session;
}

// ==========================================================================
// Factories de serveur
// ==========================================================================

function createMcpServer(): Server {
  return new Server(
    { name: "geocontext", version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
        resources: { listChanged: true },
        prompts: {},
      },
    },
  );
}

// ==========================================================================
// Transports
// ==========================================================================

/**
 * Mode stdio : un seul serveur, un seul client.
 */
async function startStdio(): Promise<void> {
  const server = createMcpServer();
  configureServer(server);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

/**
 * Mode HTTP : un serveur + une session par connexion.
 *
 * Chaque requête POST /mcp crée un transport Streamable HTTP
 * avec gestion de session. Les sessions sont identifiées par
 * un UUID généré côté serveur.
 */
async function startHttp(): Promise<void> {
  const PORT = parseInt(process.env.PORT ?? "3000", 10);
  const PUBLIC_DIR = join(__dirname, "../public");

  // MIME types pour les fichiers statiques
  const MIME_TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
  };

  // Map de transports actifs par sessionId
  const transports = new Map<string, StreamableHTTPServerTransport>();

  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const url = req.url ?? "/";
    const pathname = url.split("?")[0];

    // Log requêtes /mcp entrantes
    if (pathname === "/mcp") {
      const sid = req.headers["mcp-session-id"] ?? "new";
      console.error(`[mcp] ${req.method} /mcp session=${sid}`);
    }

    // CORS pour /mcp
    if (pathname === "/mcp") {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, mcp-session-id");
      res.setHeader("Access-Control-Expose-Headers", "mcp-session-id");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }
    }

    // ── Fichiers statiques (public/) ──
    if (pathname !== "/mcp") {
      const safePath = pathname === "/" ? "/index.html" : pathname;
      // Empêcher la traversée de répertoire
      if (safePath.includes("..")) {
        res.writeHead(403);
        res.end("Forbidden");
        return;
      }

      const filePath = join(PUBLIC_DIR, safePath);
      if (existsSync(filePath) && statSync(filePath).isFile()) {
        const ext = extname(filePath);
        const mime = MIME_TYPES[ext] || "application/octet-stream";
        res.writeHead(200, { "Content-Type": mime });
        createReadStream(filePath).pipe(res);
        return;
      }

      res.writeHead(404, { "Content-Type": "text/plain" });
      res.end("Not found");
      return;
    }

    // Récupérer la session existante ou en créer une nouvelle
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && transports.has(sessionId)) {
      // Session existante — déléguer au transport
      const transport = transports.get(sessionId)!;
      await transport.handleRequest(req, res);
      return;
    }

    // Nouvelle session — créer un serveur MCP + transport + session
    if (req.method === "POST") {
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      const server = createMcpServer();
      configureServer(server);

      // Nettoyer à la fermeture
      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) transports.delete(sid);
      };

      await server.connect(transport);
      await transport.handleRequest(req, res);

      // Stocker le transport après handleRequest (sessionId assigné lors de initialize)
      if (transport.sessionId) {
        transports.set(transport.sessionId, transport);
      }
      return;
    }

    // Requête sans session et non-POST
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Bad request. Start with POST /mcp" }));
  });

  httpServer.listen(PORT, () => {
    console.error(`[geocontext] HTTP server listening on http://localhost:${PORT}/mcp`);
  });
}

// ==========================================================================
// Main
// ==========================================================================

async function main() {
  const TRANSPORT_TYPE = process.env.TRANSPORT_TYPE || "stdio";

  switch (TRANSPORT_TYPE) {
    case "stdio":
      await startStdio();
      break;
    case "http":
      await startHttp();
      break;
    default:
      throw new Error(`Invalid transport type: ${TRANSPORT_TYPE}`);
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
