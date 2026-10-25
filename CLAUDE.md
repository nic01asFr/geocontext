# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

geocontext is an MCP (Model Context Protocol) server that provides spatial context for LLMs by interfacing with France's Géoplateforme services. It exposes **dynamic tools** that adapt to a navigation context (territory, theme, data), **resources** for state introspection, and a **web interface** with an interactive map.

Two client types, identical treatment:
- **Direct MCP clients** (Claude Desktop, Cursor) — via stdio transport
- **Web interface** (map + panels + chat) — via HTTP transport at `http://localhost:3000`

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript + mcp-build (tsc && npx mcp-build)
npm test             # Run tests (uses --experimental-vm-modules for ESM)
npm run coverage     # Run tests with coverage
npm start            # Start the server in stdio mode (node dist/index.js)
npm run watch        # TypeScript watch mode
```

Start with HTTP transport (web interface):
```bash
TRANSPORT_TYPE=http npm start
# → http://localhost:3000
```

Run a single test file:
```bash
node --no-warnings --experimental-vm-modules ./node_modules/jest/bin/jest.js test/gpf/geocode.test.ts
```

Debug with MCP Inspector:
```bash
npx -y @modelcontextprotocol/inspector node dist/index.js
```

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Web Interface (public/)                                 │
│  MapLibre + Context Panel + Data Panel + Chat            │
│         ↕ HTTP /mcp (JSON-RPC + SSE)                    │
├─────────────────────────────────────────────────────────┤
│  MCP Server (src/index.ts)                               │
│  tools/list, tools/call, resources/list, resources/read  │
│  Transport: stdio (1 session) | HTTP (N sessions)        │
├─────────────────────────────────────────────────────────┤
│  Session Layer (src/session/)                            │
│  session.ts → 7 handlers + dynamic tool builders         │
│  navigate.ts → 6 territory resolution strategies         │
│  registry/ → 49 sources, 10 themes, field transforms │
│  executors/ → WFS/REST execution with CQL, retry, sort   │
├─────────────────────────────────────────────────────────┤
│  Géoplateforme Clients (src/gpf/)                        │
│  geocode, altitude, adminexpress, cadastre, wfs, etc.    │
└─────────────────────────────────────────────────────────┘
```

### Entry Point & Transport (`src/index.ts`)

Uses the MCP SDK directly (not mcp-framework) for dynamic tool/resource control. `configureServer()` wires up handlers on a `Server` instance. Two transports:
- **stdio** — 1 Server, 1 session, 1 client
- **HTTP** — 1 Server per connection via `StreamableHTTPServerTransport`, serves `public/` for the web UI

### Session Layer (`src/session/`)

Core of the application. Each session maintains a `NavigationContext` (territory level, code, bbox, theme, data, layers, history).

| File | Role |
|------|------|
| `session.ts` | `GeoContextSession` — 7 tool handlers (navigate, action, search, back, map, select, compare) + 7 dynamic tool builders |
| `navigate.ts` | Territory resolution: INSEE code, parcelle ID, coordinates, département, SIREN EPCI, free text |
| `registry/` | Data registry mapping `(level, theme, action)` → sources with endpoints, fields, pivots, filters |
| `executors/executor.ts` | Executes WFS/REST sources: CQL construction, fetch with retry, field transforms, layerSpecs |

**Dynamic tools principle**: the 7 tools are always exposed (`getTools()`); their descriptions and enums depend on the context and are recomputed on each `tools/list`. `tools/list_changed` may be emitted, but clients do not always re-fetch within a conversation (see header of `session.ts`).

**LayerSpecs pattern**: GeoJSON is NOT returned through MCP (too large). Instead, tool results include `layerSpec` objects (WFS URL, typename, CQL filter, style). The frontend fetches GeoJSON directly from Géoplateforme.

### Registry (`src/session/registry/`)

| File | Role |
|------|------|
| `endpoints.ts` | 16 endpoint definitions (WFS, REST), 8 used by sources; URLs, retry policies, CRS |
| `sources/*.ts` | 49 source definitions organized by theme (urbanisme, cadastre, risques…) |
| `types.ts` | All type definitions: SourceDef, EndpointDef, PivotStrategy, FieldDef, LayerSpec |
| `pivot.ts` | CQL filter construction from context (attribute, spatial, composite, fallback) |
| `fields.ts` | Field transformations (date parsing, unit conversion, enum mapping) |
| `filters.ts` | User filter → CQL/REST params conversion |
| `tree.ts` | UI tree builder, action descriptions, enum generation for dynamic tools |
| `registry.ts` | Singleton registry with lookup methods: getThemes, getActions, getSources |

### Static Tools (`src/tools/`)

Tools of the original project (`MCPTool` from mcp-framework). Kept in the repository but **not exposed** by the current server: `src/index.ts` only publishes the session tools (`session.getTools()`). The session layer relies on the clients in `src/gpf/`.

### Géoplateforme Clients (`src/gpf/`)

Backend modules calling Géoplateforme REST/WFS APIs. Mix of `.js` and `.ts`. `wfs.ts` provides `WfsClient` with `FeatureTypeSearch` (MiniSearch fuzzy search over WFS capabilities).

### Web Interface (`public/`)

Single-page app (vanilla JS, no build step) with 3-column layout:

| File | Role |
|------|------|
| `mcp-client.js` | MCP Streamable HTTP client (JSON-RPC + SSE, session management) |
| `state.js` | Global state pub/sub, syncs with MCP resources |
| `map.js` | MapLibre GL JS, IGN Plan v2 tiles, dynamic GeoJSON layers |
| `geo-fetcher.js` | Fetches GeoJSON directly from Géoplateforme via layerSpecs, Lambert-93 reprojection |
| `context-panel.js` | Territory hierarchy tree + theme/action buttons |
| `data-panel.js` | Data tables, stats, feature highlight |
| `chat.js` | Chat with direct MCP commands (works without LLM) |
| `app.js` | Orchestration, search bar, event routing |

### Additional modules

| Path | Role |
|------|------|
| `src/emprise.ts`, `src/territoire.ts`, `src/exact-gpu.ts` | Exact territory membership (see `docs/territoire-exact.md`). Never return a partial or approximate total: raise an explicit error. |
| `src/tiles.ts` | `/tiles/*` GeoJSON tiles with disk cache |
| `src/liens/` | `/liens/*` reference-based sheets (elected officials, EPCI, IRIS) |
| `src/agent/agent.ts` | Integrated agent (`/agent/*`), OpenAI-compatible LLM via `AGENT_*` env vars |
| `public/map-atlas.js` | Default web map, based on an external `<atlas-bi>` component (`?carte=maplibre` uses `public/map.js`) |
| `public/ui/geocontext-map.html` | MCP App bundle (`ui://geocontext-map`) |

### Tests (`test/`)

| Test file | Type | Network? |
|-----------|------|----------|
| `test/session/registry.test.ts` | Unit (39 tests) | No |
| `test/session/executor.test.ts` | Unit with mock fetch (6 tests) | No |
| `test/session/navigate.test.ts` | Integration | Yes (Géoplateforme) |
| `test/session/session.test.ts` | Integration | Yes (Géoplateforme) |
| `test/gpf/*.test.ts` | Integration | Yes (Géoplateforme) |

### Design Documentation (`docs/`)

| Document | Content |
|----------|---------|
| `docs/architecture.md` | Global architecture — components, structure, transports |
| `docs/data-model.md` | Data model — 6 levels, themes, pivot keys, sources |
| `docs/navigation-context.md` | Core principle: context=interface, navigation cycle |
| `docs/dynamic-tools.md` | Dynamic MCP tool surface — how tools adapt to context |
| `docs/web-interface.md` | Web interface — map + panels + chat |
| `docs/terrid-spec.md` | Data sources specification — endpoints, constraints |
| `docs/structures.md` | Pieces of the repository and how they fit together |
| `docs/territoire-exact.md` | Exact territory membership: rules and limits |
| `docs/api-http-agent.md` | HTTP routes, agent, security, search (no semantic search exists) |
| `docs/usages-professionnels.md` | Reliability and limits |

## Key Conventions

- ESM module system (`"type": "module"` in package.json, ESNext module/target in tsconfig)
- Tool descriptions and user-facing strings are in French
- The project uses `.js` imports in TypeScript files (e.g., `import { geocode } from "../gpf/geocode.js"`)
- Logging via `winston` (`src/logger.js`)
- Node.js >= 18.19.0 required; CI runs on Node 22
- GeoJSON never transits through MCP — use layerSpecs for frontend direct fetch
- ADMINEXPRESS field names: `nom_officiel`, `code_insee`, `code_insee_du_departement`, `code_insee_de_la_region`
