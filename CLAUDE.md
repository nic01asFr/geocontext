# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

geocontext is an experimental MCP (Model Context Protocol) server that provides spatial context for LLMs by interfacing with France's Géoplateforme services. Built with `mcp-framework`, it exposes tools for geocoding, altitude lookup, administrative/cadastral/urbanisme queries, and WFS vector data exploration.

## Commands

```bash
npm install          # Install dependencies
npm run build        # Compile TypeScript + mcp-build (tsc && npx mcp-build)
npm test             # Run tests (uses --experimental-vm-modules for ESM)
npm run coverage     # Run tests with coverage
npm start            # Start the server (node dist/index.js)
npm run watch        # TypeScript watch mode
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

### Entry Point & Transport

`src/index.ts` — Creates an `MCPServer` (from mcp-framework) with auto-discovery of tools in `src/tools/`. Transport is configured via `TRANSPORT_TYPE` env var: `"stdio"` (default) or `"http"` (port 3000 with CORS).

### Tools (`src/tools/`)

Each tool extends `MCPTool` from mcp-framework and defines `name`, `description`, `schema` (using Zod), and an `execute()` method. Tools are auto-discovered by mcp-framework from this directory. To add a new tool, create a new file exporting a default class extending `MCPTool`, or use `mcp add tool <name>`.

Tool categories:
- **Geocoding/Altitude**: `GeocodeTool`, `AltitudeTool` — point lookups via Géoplateforme APIs
- **Spatial queries** (lon,lat → info): `AdminexpressTool`, `CadastreTool`, `UrbanismeTool`, `AssietteSupTool`
- **WFS exploration**: `GpfWfsSearchTypesTool`, `GpfWfsDescribeTypeTool`, `GpfWfsGetFeaturesTool`, `GpfWfsListTypesTool` (deprecated)

### Géoplateforme Clients (`src/gpf/`)

Backend modules that call Géoplateforme REST/WFS APIs. Mix of `.js` and `.ts` files. `wfs.ts` provides `WfsClient` (wrapping `@camptocamp/ogc-client`) with `FeatureTypeSearch` (using MiniSearch for fuzzy keyword search over WFS capabilities). A singleton `wfsClient` is exported.

### Helpers (`src/helpers/`)

- `http.js` — `fetchJSON()` wrapper using `node-fetch` with proxy support (`HTTP_PROXY` env var) and logging
- `distance.js` — Geometric distance utilities using `jsts`

### Tests (`test/`)

Tests mirror the `src/gpf/` structure. They call real Géoplateforme APIs (no mocking), so they require network access and have a 60s timeout. `test/samples.ts` provides reusable GeoJSON test fixtures (points for Paris, Chamonix, Marseille, etc.).

### Session & Navigation Context (`src/session/`)

Stateful session layer (in development) that powers dynamic MCP tools and the web interface. Each MCP connection maintains a `NavigationContext` tracking: territory level, code, bbox, active theme, loaded data, map layers, and navigation history. See `src/session/types.ts` for type definitions.

The session determines which tools and resources are exposed to the LLM at each turn via the MCP `tools/list_changed` notification mechanism.

### Design Documentation (`docs/`)

| Document | Content |
|----------|---------|
| `docs/architecture.md` | Global architecture — components, structure, transports |
| `docs/data-model.md` | Data model — 6 levels, themes, pivot keys, sources |
| `docs/navigation-context.md` | Core principle: context=interface, navigation cycle |
| `docs/dynamic-tools.md` | Dynamic MCP tool surface — how tools adapt to context |
| `docs/web-interface.md` | Web interface — map + panels + chat |
| `docs/terrid-spec.md` | Data sources specification — endpoints, constraints |

## Key Conventions

- ESM module system (`"type": "module"` in package.json, ESNext module/target in tsconfig)
- Tool descriptions and user-facing strings are in French
- The project uses `.js` imports in TypeScript files (e.g., `import { geocode } from "../gpf/geocode.js"`)
- Logging via `winston` (`src/logger.js`)
- Node.js >= 18.19.0 required; CI runs on Node 22
