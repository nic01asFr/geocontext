/**
 * geocontext — MCP Server Entry Point
 *
 * Démarre le serveur MCP avec tools dynamiques pilotés par la session.
 *
 * Utilise le SDK MCP direct (Server bas niveau) au lieu de mcp-framework
 * pour pouvoir :
 *   - Retourner des tools dynamiques via tools/list (getTools)
 *   - Émettre tools/list_changed après chaque changement de contexte
 *   - Adapter descriptions et enums à chaque tour
 *
 * Transports :
 *   - TRANSPORT_TYPE=stdio (défaut) → StdioServerTransport
 *   - TRANSPORT_TYPE=http → StreamableHTTPServerTransport (port 3000)
 *
 * @see docs/navigation-context.md — cycle de navigation
 * @see docs/dynamic-tools.md — surface de tools dynamique
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";

import { GeoContextSession } from "./session/session.js";

// Get the directory of the current module (dist directory)
const __dirname = dirname(fileURLToPath(import.meta.url));

// Get version from package.json
const pkgMetadata = JSON.parse(
  readFileSync(join(__dirname, "../package.json"), "utf-8"),
);
const VERSION = pkgMetadata.version;

async function main() {
  const TRANSPORT_TYPE = process.env.TRANSPORT_TYPE || "stdio";
  if (TRANSPORT_TYPE !== "stdio" && TRANSPORT_TYPE !== "http") {
    throw new Error(`Invalid transport type: ${TRANSPORT_TYPE}`);
  }

  // Créer le serveur MCP bas niveau avec capacité tools/list_changed
  const server = new Server(
    { name: "geocontext", version: VERSION },
    {
      capabilities: {
        tools: { listChanged: true },
      },
    },
  );

  // Une session par instance stdio (1 client = 1 session)
  const session = new GeoContextSession(server);

  // Handler tools/list → retourne les tools dynamiques de la session
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: session.getTools(),
  }));

  // Handler tools/call → dispatch à la session
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return session.handleToolCall(name, args ?? {});
  });

  // Transport
  if (TRANSPORT_TYPE === "stdio") {
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } else {
    // HTTP : pour l'instant, même pattern que stdio
    // TODO: créer une session par connexion HTTP entrante
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error(
      "[geocontext] HTTP transport not yet implemented for dynamic session, falling back to stdio",
    );
  }
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
