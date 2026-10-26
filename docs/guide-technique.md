# Guide technique : architecture, méthode, MCP

Ce document présente la conception de geocontext pour des équipes qui veulent en comprendre le fonctionnement, le reprendre ou s'en inspirer. Il est écrit d'après le code ; ce qui n'est pas fait est dit comme tel. C'est un **prototype** : voir [usages-professionnels.md](usages-professionnels.md) pour ce qu'on peut en attendre.

## 1. Ce que c'est, en deux phrases

Un serveur MCP qui donne à un assistant (ou à une personne) un **contexte territorial** — où l'on est, quelles données existent là, lesquelles sont chargées — et qui lit les données **à la demande** chez leur producteur, principalement sur la Géoplateforme. Une interface web, un agent intégré et un client MCP quelconque agissent sur **le même contexte**.

Le point de départ est le projet [mborne/geocontext](https://github.com/mborne/geocontext) incubé avec ignfab. Cette branche en reprend l'idée (rendre la Géoplateforme exploitable par un LLM en lisant les données à la demande, sans base de données propre ; seules les tuiles de l'interface web sont mises en cache sur disque) et l'étend à la navigation, à l'affichage et à la vérification des résultats.

## 2. Vue d'ensemble

```
   Client MCP              Interface web             MCP App             Agent intégré
 (Claude Desktop,      (carte + panneaux           (carte dans le         (boucle côté serveur,
  Cursor, Inspector)      + chat)                    client MCP)            LLM au choix)
        │                      │                         │                       │
        └──────────────────────┴───────────┬─────────────┴───────────────────────┘
                                           ▼
                            ┌──────────────────────────────┐
                            │  Serveur MCP (src/index.ts)  │
                            │   Session (par connexion)    │
                            │   NavigationContext          │
                            │   7 outils · ressources      │
                            └──────────────┬───────────────┘
                                           ▼
                            ┌──────────────────────────────┐
                            │ Registre déclaratif (sources)│
                            │ Exécuteurs WFS / REST        │
                            │ Mode « territoire exact »    │
                            └──────────────┬───────────────┘
                                           ▼
                       Géoplateforme (WFS, géocodage, altimétrie…)
                       + autres services publics (Géorisques, RNB, ADEME…)
```

Transports : `stdio` (une session, un client) ou `http` (une session par connexion, plus l'interface web et les routes annexes).

### Deux modes d'usage, un contexte commun

Les quatre accès se rangent selon deux axes. **Acteur** : ce qui est piloté par un modèle qui appelle les outils (client MCP, agent intégré). **Surface** : ce qui affiche (MCP App, interface web). Chaque acteur a sa surface, et tous agissent sur le même contexte.

| | Acteur | Surface |
|---|---|---|
| **Mode client MCP** (l'utilisateur apporte son client et son modèle) | Client MCP | MCP App |
| **Mode site web** (l'exploitant fournit l'interface et le modèle) | Agent intégré | Interface web |

Ce qui sépare les deux modes n'est pas le transport mais *qui fournit l'interface et le modèle* ; d'où des conditions d'exploitation différentes (coût du modèle, authentification, exposition réseau), détaillées dans la [vitrine](vitrine/index.html#exploitation). Le protocole d'accusé d'affichage (§8) n'est utilisé aujourd'hui que par l'interface web, pas par la MCP App.

## 3. Le contexte de navigation

La session conserve un `NavigationContext` : niveau (région, département, EPCI, commune, parcelle, bâtiment), code, nom, emprise, géométrie exacte quand elle est connue (parcelle), hiérarchie, thème courant, données chargées, couches, historique.

Le cycle est toujours le même : **naviguer → choisir un thème → charger une donnée → filtrer ou comparer**. Chaque étape modifie le contexte, et le contexte détermine ce qui est proposé ensuite. Détails : [navigation-context.md](navigation-context.md).

Ce principe a une conséquence pratique : une personne qui clique et un modèle qui appelle un outil passent par les mêmes étapes, et voient le même état.

## 4. Les outils, les ressources, le prompt

Sept outils, toujours listés : `navigate`, `search`, `back`, `action`, `map`, `compare`, `select`. Leurs descriptions et leurs listes de valeurs (thèmes, actions, couches) sont recalculées selon le contexte, ce qui limite les noms inventés. Détails et valeurs relevées : [dynamic-tools.md](dynamic-tools.md).

Les ressources `geocontext://context`, `…/themes/{niveau}`, `…/actions/{thème}`, `…/layers` donnent l'état de la session ; le prompt `geocontext-guide` résume le cycle.

Limite connue : un client MCP peut ne pas relire `tools/list` entre deux messages. C'est la raison pour laquelle les outils ne disparaissent jamais ; seules leurs descriptions changent.

## 5. Le registre : ajouter une donnée sans écrire de code d'exécution

Le registre (`src/session/registry/`) est une table déclarative. Une **source** décrit : le niveau, le thème et l'action où elle apparaît, le point d'accès, le type de couche, les champs (avec types, libellés, énumérations), les filtres possibles, et la **stratégie de pivot** qui relie le contexte à la requête :

| Stratégie | Principe | Exemple |
|---|---|---|
| `attribute` | filtre sur une clé du contexte | code INSEE de la commune |
| `spatial` | emprise (`bbox`) ou intersection avec la géométrie du contexte | zonage de la parcelle |
| `attribute_with_fallback` | essai d'une clé, puis d'une seconde | partition d'un PLU ou d'un PLUi |
| `composite` | combinaison | — |

À ce jour : **49 sources**, **10 thèmes**, lues auprès de **8 services** (31 sur le WFS de la Géoplateforme, 7 sur l'API REST de Géorisques, les autres sur RNB, BDNB, ADEME, Hub'Eau, DVF, SIRENE). Les exécuteurs (`src/session/executors/`) construisent la requête (CQL ou REST), appliquent nouvelles tentatives, tri et transformations de champs, et produisent un résumé plus une description de couche.

## 6. Les géométries ne passent pas par MCP

Un résultat d'outil contient des **comptes, des statistiques et une description de couche** (`layerSpec` : service, couche, filtre, style) — jamais les géométries. Le client qui affiche la carte récupère lui-même les objets auprès de la Géoplateforme. Pourquoi : limiter la taille des réponses (donc les jetons et les erreurs d'un modèle) et éviter de recopier les données.

## 7. Appartenance exacte à un territoire

Une boîte englobante ramène des objets voisins. Pour les couches concernées, le serveur décide pour chaque objet s'il est **dedans**, **à cheval** ou **hors** du contour exact du territoire (ADMIN EXPRESS), avec la géométrie de l'objet et non son rectangle. Les objets hors territoire sont **écartés et listés** ; ceux à cheval sont conservés et marqués. Si le volume dépasse ce qu'on sait contrôler, la réponse est un **refus explicite**, sans total approché ni échantillon.

Au niveau parcelle, la géométrie exacte de la parcelle est portée par le contexte et sert de filtre d'intersection (zonage, bâtiments). Règles et limites : [territoire-exact.md](territoire-exact.md).

## 8. La surface d'affichage et l'accusé

Le serveur ne sait pas ce qui est affiché : seule la surface d'affichage (la page web, une MCP App) le sait. Le protocole est donc le suivant :

1. une opération d'affichage (`map`: filtrer, masquer…) est **validée**, puis mise en file côté serveur ;
2. la surface la récupère (`ui_poll`), l'applique et **relit l'état réel** (comptes, couches visibles) ;
3. elle l'**accuse** (`ui_ack`) ; l'outil `map` ne renvoie un succès qu'avec cet accusé, sinon une erreur explicite ;
4. la surface publie aussi son état (`ui_state`) : filtres actifs, comptes relus, couche suivie.

Ces trois outils ne sont pas annoncés aux modèles. L'effet : ce qu'un assistant affirme avoir affiché est ce qui a été **relu**, pas ce qui a été demandé.

## 9. Tableau = carte

Dans l'interface web, chaque couche a un tableau et une carte. Après chaque chargement, filtre ou coloration, la page compare le nombre d'objets de la carte (relu via Atlas) à celui du tableau. S'ils diffèrent, l'opération est **annulée avec un message**. Si la carte ne peut pas être relue, la page le dit au lieu d'afficher un nombre. C'est visible à l'écran : « carte vérifiée 4 / 4 ».

## 10. L'agent intégré (acteur du mode site web)

`src/agent/agent.ts` : une boucle d'agent côté serveur, branchée sur les **mêmes outils** et la **même session** que la page. Elle parle à une API de type « chat completions » compatible OpenAI (modèle au choix de l'exploitant).

- À chaque étape, la liste d'outils et le contexte actuel (territoire, couches, comptes relus à l'écran, filtres) sont relus.
- Après chaque outil qui change l'affichage, la page **accuse** ce qu'elle a affiché (`/agent/ack`) ; sans accusé, l'agent dit « non confirmé », jamais « fait ».
- Les résultats d'outils sont donnés au modèle comme des **données**, jamais comme des instructions.
- Bornes configurables (étapes, durées, jetons par heure, taille de l'historique) ; toute limite atteinte est dite à l'utilisateur.

Bornes et variables : [api-http-agent.md](api-http-agent.md). Sans modèle configuré, tout fonctionne sauf le chat.

## 11. Interface web et MCP App (les deux surfaces)

- **Interface web** (`public/`) : application sans étape de compilation, qui parle au serveur par `/mcp` comme n'importe quel client MCP. La carte par défaut est le composant externe `<atlas-bi>` (contrat « carte BI 0.3 »), qui fournit couches, filtres, formes de représentation (symboles, cercles proportionnels, chaleur, hexagones, grille), temps, fond de plan et relief. Une carte MapLibre simple reste disponible (`?carte=maplibre`).
- **MCP App** (`ui://geocontext-map`) : un bundle HTML déclaré par les outils `navigate`, `action`, `map`, `compare` et `select`. Les clients qui prennent en charge les MCP Apps peuvent l'afficher dans la conversation. Elle a sa propre carte MapLibre ; elle n'offre pas les mêmes fonctions que l'interface web. Elle n'a pas été testée dans un client MCP Apps réel dans le cadre de cette documentation.

## 12. Comment c'est vérifié

- Tests unitaires et d'intégration (`npm test`) : registre, exécuteurs avec réseau simulé, navigation, agent avec faux modèle ; les tests d'intégration appellent la Géoplateforme réelle.
- Comparaisons avec un calcul indépendant (`jsts`) pour l'appartenance exacte : communes, EPCI et départements ; pour la région, la comparaison n'est pas terminée.
- Parcelles : zonages et bâtiments comparés à un calcul indépendant sur quatre parcelles d'une même commune.
- Interface : scénarios joués dans un navigateur réel (filtres, représentations, zone visible), avec relecture de la carte.

Ce n'est pas une validation complète : voir les limites ci-dessous.

## 13. Limites connues

- Dépendance aux services amont : pas de reprise de service ; un résultat dépend de l'état du service au moment de la lecture.
- Pas d'authentification ni de gestion d'utilisateurs ; les en-têtes CORS de `/mcp` autorisent toute origine. À protéger avant toute exposition.
- Sessions en mémoire : perdues au redémarrage.
- Carte par défaut fondée sur un composant externe dont la version n'est pas figée par le dépôt.
- Certaines sources ne sont pas vérifiées au même niveau : DVF (comptage seul), SIRENE (non joignable depuis l'environnement de test), `argiles`, `ppr` et transactions au niveau parcelle (erreurs explicites). Niveau bâtiment : non navigable.
- Aucune valeur juridique : consulter la source officielle pour tout acte.

## 14. Pistes, non implémentées

- Route HTTP de recherche sur le registre de sources (sans modèle).
- Recherche sémantique (il n'y en a pas aujourd'hui).
- Interface de requête en langage naturel renvoyant directement une « scène » (couches, représentation, comptes) sous forme d'API.
- Épinglage du composant cartographique ; authentification ; suivi des coûts de l'agent.

Ce sont des hypothèses de conception, pas des engagements.

## Pour aller plus loin

[architecture.md](architecture.md) · [structures.md](structures.md) · [data-model.md](data-model.md) · [web-interface.md](web-interface.md) · [api-http-agent.md](api-http-agent.md) · [territoire-exact.md](territoire-exact.md) · [vitrine](vitrine/index.html)
