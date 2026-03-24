# Architecture globale — geocontext

## Vision

geocontext est un serveur MCP qui fournit du contexte spatial structuré. Il sert deux types de clients de manière identique :

- **Interface web** (carte + panneaux + chat) — l'humain navigue par clics et langage naturel
- **Client MCP direct** (Claude Desktop, Cursor, etc.) — le LLM navigue par tool calls

Les deux parcourent le **même arbre de navigation**, produisent le **même contexte**, reçoivent les **mêmes tools filtrés**.

## Principe fondamental

> Le contexte courant EST l'interface. L'interface pilote le contexte. Le contexte filtre les tools. Les tools modifient le contexte.

```
          ┌──────────────────────────────────────┐
          │                                      │
          ▼                                      │
   ┌─────────────┐                               │
   │  CONTEXTE   │ ── détermine ──► tools/list   │
   │  courant    │                  resources     │
   └──────┬──────┘                  descriptions  │
          │                         enums         │
          │                              │        │
          │                              ▼        │
          │                     ┌──────────────┐  │
          │                     │  LLM ou USER │  │
          │                     │  choisit une │  │
          │                     │  action      │  │
          │                     └──────┬───────┘  │
          │                            │          │
          │                            ▼          │
          │                     ┌──────────────┐  │
          │                     │  tool_call   │  │
          │                     │  exécuté     │  │
          │                     └──────┬───────┘  │
          │                            │          │
          │  met à jour                │          │
          └────────────────────────────┘          │
                                                  │
                  tools/list_changed ──────────────┘
```

## Composants

```
┌─────────────────────────────────────────────────────────────┐
│                    SERVEUR MCP geocontext                    │
│                                                             │
│  ┌───────────────────────────────────────────────────────┐  │
│  │                  SESSION (stateful)                    │  │
│  │                                                       │  │
│  │  NavigationContext                                     │  │
│  │    level, code, bbox, theme, data, layers, history     │  │
│  │                                                       │  │
│  └──────────┬──────────────────────────────┬─────────────┘  │
│             │                              │                 │
│    ┌────────▼─────────┐        ┌───────────▼────────────┐   │
│    │  TOOLS DYNAMIQUES │        │  RESOURCES DYNAMIQUES  │   │
│    │  (tools/list)     │        │  (resources/list)      │   │
│    │                   │        │                        │   │
│    │  Recalculés à     │        │  geocontext://context   │   │
│    │  chaque changement│        │  geocontext://themes   │   │
│    │  de contexte      │        │  geocontext://actions  │   │
│    └────────┬──────────┘        └───────────┬────────────┘   │
│             │                               │                │
│    ┌────────▼───────────────────────────────▼────────────┐   │
│    │              CLIENTS GPF (existants)                 │   │
│    │                                                     │   │
│    │  geocode  altitude  wfs  adminexpress  cadastre     │   │
│    │  urbanisme  parcellaire-express                     │   │
│    └─────────────────────┬───────────────────────────────┘   │
│                          │                                   │
└──────────────────────────┼───────────────────────────────────┘
                           │
                           ▼
                  APIs Géoplateforme + sources externes
```

## Structure du code

```
src/
├── index.ts                 # Point d'entrée, transport stdio/http
├── logger.js                # Logging Winston
│
├── session/                 # NOUVEAU — gestion du contexte
│   ├── types.ts             # NavigationContext, ViewState, ContextEntry
│   ├── context.ts           # GeoContextSession — logique de navigation
│   ├── dynamic-tools.ts     # Génération tools/list selon contexte
│   └── tool-handlers.ts     # Dispatch action/map/compare → gpf/
│
├── tools/                   # Tools MCP (auto-découverts par mcp-framework)
│   ├── GeocodeTool.ts       # Statique — géocodage
│   ├── AltitudeTool.ts      # Statique — altitude
│   ├── AdminexpressTool.ts  # Backend pour action(identité)
│   ├── CadastreTool.ts      # Backend pour action(cadastre)
│   ├── UrbanismeTool.ts     # Backend pour action(urbanisme)
│   ├── AssietteSupTool.ts   # Backend pour action(servitudes)
│   ├── GpfWfsSearchTypesTool.ts   # Backend pour search
│   ├── GpfWfsDescribeTypeTool.ts  # Backend pour action(describe)
│   ├── GpfWfsGetFeaturesTool.ts   # Backend pour action + map
│   └── GpfWfsListTypesTool.ts     # Déprécié
│
├── gpf/                     # Clients Géoplateforme (inchangés)
│   ├── geocode.js
│   ├── altitude.js
│   ├── adminexpress.js
│   ├── cadastre.js → parcellaire-express.js
│   ├── urbanisme.js
│   └── wfs.ts
│
└── helpers/
    ├── http.js              # fetchJSON avec proxy
    └── distance.js          # Utilitaires géométriques jsts
```

## Transports

| Mode | Usage | Config |
|------|-------|--------|
| `stdio` | Client MCP classique (Claude Desktop, Cursor) | Par défaut |
| `http` | Interface web, MCP Inspector, Docker | `TRANSPORT_TYPE=http`, port 3000, CORS |

## Documents associés

| Document | Contenu |
|----------|---------|
| [data-model.md](data-model.md) | Modèle de données — 6 niveaux, thématiques, clés |
| [navigation-context.md](navigation-context.md) | Principe contexte=interface, cycle de navigation |
| [dynamic-tools.md](dynamic-tools.md) | Surface de tools dynamiques MCP |
| [web-interface.md](web-interface.md) | Interface cartographique + chat |
| [terrid-spec.md](terrid-spec.md) | Spécification détaillée des sources de données |
