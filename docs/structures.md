# Structures mises en œuvre

Ce document décrit, à partir du code, les différentes pièces de ce dépôt et la façon dont elles s'articulent. Il distingue ce qui est **implémenté** de ce qui reste une **piste**.

## Vue d'ensemble

```
            ┌──────────────────────────────────────────────────────────────┐
 Client MCP │ Claude Desktop, Cursor, MCP Inspector, …                      │
 (stdio/HTTP)└───────────────┬──────────────────────────────────────────────┘
                             │ tools/call · resources/read · prompts/get
            ┌────────────────▼─────────────────────────────────────────────┐
            │ Serveur MCP (src/index.ts)                                    │
            │   Session (src/session/session.ts)                            │
            │     NavigationContext : niveau, code, bbox, thème, données…   │
            │     outils dynamiques · ressources · prompt « geocontext-guide»│
            │   Registre (src/session/registry/) → exécuteurs (WFS / REST)  │
            ├───────────────────────────────────────────────────────────────┤
 Mode HTTP  │ /mcp  · /tiles/*  · /liens/*  · /agent/*  · fichiers public/  │
 uniquement └───────┬───────────────────────────────┬──────────────────────┘
                    │                               │
        Interface web (public/)           MCP App (ui://geocontext-map)
        carte + panneaux + chat           carte intégrée au client MCP
```

Un seul serveur, un seul modèle de session : chaque interface (client MCP, page web, agent intégré) agit sur un `NavigationContext`.

## 1. Contextualisation (`src/session/`)

Le serveur est **à état** : chaque session conserve un `NavigationContext` (voir [navigation-context.md](navigation-context.md)).

| Élément | Rôle | Où |
|---|---|---|
| Niveau et code du territoire | région, département, EPCI, commune, parcelle, bâtiment | `types.ts` |
| Thème courant | identité, urbanisme, cadastre, risques, environnement, transport, hydrologie, économie, bâti, énergie (les thèmes proposés dépendent du niveau : `THEMES_BY_LEVEL`) | `types.ts` |
| Données et couches | résultats chargés, couches cartographiques actives | `session.ts` |
| Historique | pile utilisée par l'outil `back` | `session.ts` |

**Outils dynamiques** (voir [dynamic-tools.md](dynamic-tools.md)) : `navigate`, `search`, `action`, `map`, `compare`, `select`, `back`. Les sept sont **toujours** listés (`getTools()` dans `session.ts`) ; c'est leur contenu qui dépend du contexte : descriptions et énumérations (thèmes, sous-actions, couches actives) sont recalculées à chaque appel de `tools/list`, et le serveur peut émettre `tools/list_changed`. Les clients qui ne relisent pas la liste en cours de conversation voient donc un contenu d'énumérations qui peut être périmé.

**Ressources** : `geocontext://context` (état résumé), `geocontext://themes/{niveau}`, `geocontext://actions/{thème}`, `geocontext://layers`.

**Prompt** : `geocontext-guide` — rappel du cycle de navigation et des ressources, avec le contexte courant.

**Registre** (`src/session/registry/`) : table déclarative qui associe `(niveau, thème, action)` à des sources (point d'accès, type de couche, champs, filtres, stratégie de pivot). Ajouter une donnée consiste à déclarer une source, pas à écrire un nouvel outil.

**Exécuteurs** (`src/session/executors/`) : construisent les requêtes (CQL, REST), appliquent nouvelle tentative et tri, transforment les champs, et produisent soit un résumé (comptes, statistiques), soit des `layerSpecs`.

### Principe `layerSpec`

Les géométries ne passent **jamais** par MCP (trop volumineuses). Un résultat contient une description de couche (service, couche, filtre, style) ; le client qui affiche la carte récupère lui-même les objets auprès du service source.

## 2. Serveur MCP (`src/index.ts`)

- `TRANSPORT_TYPE=stdio` (défaut) : une session, un client.
- `TRANSPORT_TYPE=http` : un serveur MCP par connexion (`StreamableHTTPServerTransport`), port `PORT` (3000 par défaut). La même instance sert les routes ci-dessous et les fichiers de `public/`.
- Les en-têtes CORS de `/mcp` autorisent toute origine (`*`) : voir [api-http-agent.md](api-http-agent.md) pour les conséquences.

## 3. MCP App (`ui://geocontext-map`)

Plusieurs outils (`navigate`, `action`, `map`, `compare`, `select`) déclarent `_meta.ui.resourceUri = "ui://geocontext-map"`. Les clients qui prennent en charge les MCP Apps peuvent alors afficher le bundle `public/ui/geocontext-map.html` (carte MapLibre, fond Géoplateforme) à côté de la réponse ; les données de contexte sont fournies dans `_meta.ui.data`.

Points d'attention :
- l'affichage dépend du client : un client sans prise en charge ignore simplement ces métadonnées ;
- le bundle charge MapLibre GL JS depuis `unpkg.com` (version 4.7.1) : il requiert donc un accès réseau à ce domaine ;
- ce bundle est distinct de l'interface web ci-dessous (autre carte, autres fonctions).

## 4. Interface web (`public/`)

Application sans étape de compilation, servie par le mode HTTP, qui parle au serveur via `/mcp` (même protocole qu'un client MCP). Trois zones : contexte (hiérarchie, thèmes), carte et données, chat.

| Fichier | Rôle |
|---|---|
| `mcp-client.js`, `state.js` | client MCP HTTP, état partagé |
| `context-panel.js`, `data-panel.js`, `chat.js`, `app.js` | panneaux, tableaux et statistiques, chat, orchestration |
| `geo-fetcher.js` | récupération des objets à partir des `layerSpecs`, reprojection, application des listes d'exclusion du serveur |
| `map-atlas.js` | carte par défaut, fondée sur le composant externe `<atlas-bi>` |
| `map.js` | carte MapLibre, utilisée avec `?carte=maplibre` |

**Dépendance externe à connaître.** La carte par défaut charge le composant Atlas depuis `https://nic01asfr.github.io/Widgets-Grist/atlas/` (voir `public/map-atlas.js`). Cette version n'est pas figée par le dépôt et le composant n'a pas de licence déclarée ici : tant que ce point n'est pas réglé, la carte MapLibre (`?carte=maplibre`) est l'alternative sans cette dépendance.

Le composant ne démarre que lorsque la page est réellement affichée ; l'interface propose « Relancer la carte » si le démarrage échoue.

Sans modèle de langage configuré, tout fonctionne (navigation, panneaux, tableaux) ; seul le chat « agent » est désactivé.

## 5. Routes HTTP annexes

Voir [api-http-agent.md](api-http-agent.md) : `/tiles/*`, `/liens/*`, `/agent/*`.

## Ce qui n'existe pas

- **Pas d'API de recherche sémantique.** La recherche de types de couches utilise MiniSearch (mots-clés, tolérance aux fautes) ; il n'y a ni vecteurs d'embeddings ni index sémantique.
- **Pas d'authentification** sur les routes HTTP.
- **Pas de persistance des sessions** : elles vivent en mémoire du processus.
