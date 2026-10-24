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
├── index.ts            # Serveur MCP, transports stdio/http, routes HTTP, fichiers statiques
├── emprise.ts          # Contour d'un territoire et décision d'appartenance (voir territoire-exact.md)
├── territoire.ts       # Décision rapide des cas certains (grille + bandes d'arêtes)
├── exact-gpu.ts        # Lecture complète et contrôlée d'une couche WFS
├── tiles.ts            # Route /tiles/* (cache disque)
├── agent/agent.ts      # Agent intégré (/agent/*)
├── liens/              # Fiches par références : elus.ts, epci.ts, iris.ts (/liens/*)
├── session/
│   ├── session.ts      # GeoContextSession : outils, ressources, contexte
│   ├── navigate.ts     # Résolution de territoire
│   ├── types.ts        # NavigationContext, niveaux, thèmes
│   ├── registry/       # Points d'accès, sources par thème, pivots, champs, filtres
│   ├── executors/      # Exécution WFS/REST, mode exact
│   └── styling/        # Génération déterministe de styles de couche
├── tools/              # Outils historiques (mcp-framework), utilisés comme briques
├── gpf/                # Clients Géoplateforme
└── helpers/
public/                 # Interface web ; public/ui/ = MCP App
```

Pour le détail de chaque pièce : [structures.md](structures.md).

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
| [structures.md](structures.md) | Les pièces du dépôt et leur articulation |
| [territoire-exact.md](territoire-exact.md) | Appartenance exacte à un territoire |
| [api-http-agent.md](api-http-agent.md) | Routes HTTP, agent, sécurité, recherche |
| [usages-professionnels.md](usages-professionnels.md) | Fiabilité et limites |
