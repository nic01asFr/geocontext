# Navigation et contexte — geocontext

## Principe central

> **Le contexte courant EST l'interface. L'interface pilote le contexte. Le contexte filtre les tools. Les tools modifient le contexte.**

Que le pilote soit un humain (clics sur la carte) ou un LLM (tool calls MCP), chaque action est une **navigation** qui redéfinit le contexte. Le contexte résultant détermine les tools, resources et actions disponibles au tour suivant.

C'est identique à un menu de logiciel : chaque clic ouvre un sous-menu contextuel. Ici, chaque tool call ouvre de nouveaux tools.

## NavigationContext — l'état de session

Chaque connexion MCP maintient un état de session :

```typescript
interface NavigationContext {
  // Position dans l'arbre
  level: TerritoryLevel | null;    // region|dept|epci|commune|parcelle|batiment
  code: string | null;             // code_insee, idpar, rnb_id...
  name: string | null;             // nom lisible
  bbox: [number, number, number, number] | null;  // emprise spatiale

  // Hiérarchie résolue
  hierarchy: {
    region?: { code: string; name: string };
    departement?: { code: string; name: string };
    epci?: { code: string; name: string; siren: string };
    commune?: { code: string; name: string };
    parcelle?: { idpar: string };
    batiment?: { id: string; source: string };
  };

  // Thématique active
  theme: string | null;            // urbanisme, cadastre, risques...
  data: Record<string, any>;       // données chargées pour le thème

  // Couches cartographiques
  layers: LayerState[];            // couches actives sur la carte

  // Pile de navigation (pour back)
  history: ContextSnapshot[];
}
```

## Le cycle de navigation

```
TOUR 1 — Contexte vide
═══════════════════════
Contexte: { level: null }
Tools:    navigate, search, back
                │
                ▼
        navigate("Loray")
                │
                ▼
TOUR 2 — Territoire résolu
══════════════════════════
Contexte: { level: "commune", code: "25349", name: "Loray",
            hierarchy: { region: "BFC", dept: "25", epci: "CC Plateau..." } }
Tools:    navigate, search, back, action
                │
                ▼
        action("urbanisme")
                │
                ▼
TOUR 3 — Thème actif
════════════════════
Contexte: { ...précédent, theme: "urbanisme",
            data: { document: "PLU", zonages: 47 } }
Tools:    navigate, search, back, action, map, compare
                │
                ▼
        map("thematic", "PLU_zonage", { color_by: "type_zone" })
                │
                ▼
TOUR 4 — Carte active
═════════════════════
Contexte: { ...précédent, layers: ["PLU_zonage"],
            map: { style: "thematic:type_zone", features: 47 } }
Tools:    navigate, search, back, action, map, compare, select
```

## Analogie avec un logiciel classique

```
Logiciel classique                    Serveur MCP geocontext
──────────────────                    ──────────────────────

Menu principal                        Tools racine
 └─ Fichier                            └─ navigate
 └─ Édition                            └─ search
 └─ Affichage                          └─ back

User clique "Fichier"                 Agent appelle navigate("Loray")
    │                                     │
    ▼                                     ▼
Sous-menu contextuel                  Tools contextuels (tour suivant)
 └─ Nouveau                            └─ action (urbanisme, cadastre...)
 └─ Ouvrir                             └─ navigate (vers thème, vers parent)
 └─ Enregistrer                        └─ search
 └─ Fermer                             └─ back

User clique "Ouvrir"                  Agent appelle action("urbanisme")
    │                                     │
    ▼                                     ▼
Dialogue contextuel                   Tools encore plus ciblés
 └─ Fichiers récents                   └─ action (zonages, prescriptions...)
 └─ Parcourir...                       └─ map (afficher, filtrer, thématiser)
                                       └─ compare (croiser avec autre thème)
```

## Deux pilotes, même arbre

### Interface web (humain)

```
Panneau gauche   │  Clic sur "Risques"  → navigate({ theme: "risques" })
                 │  → contexte change → carte et chat se mettent à jour
                 │
Carte            │  Clic sur parcelle   → navigate({ parcelle: "AB0023" })
                 │  → contexte change → panneaux se mettent à jour
                 │
Chat             │  "Compare avec les risques" → LLM appelle compare(...)
                 │  → contexte change → carte et panneaux se mettent à jour
```

Tout acteur (clic, zoom, chat) modifie le même contexte. Tout le monde réagit.

### Client MCP direct (LLM seul)

```
LLM via Claude Desktop / Cursor
  │
  │── tools/list → [navigate, search, back]
  │── resource geocontext://context → { empty }
  │
  │── navigate("Loray")
  │── ◄ notification: tools/list_changed
  │── tools/list → [navigate, search, back, action]
  │── resource geocontext://context → { commune: "25349", themes: [...] }
  │
  │── action("urbanisme")
  │── ◄ notification: tools/list_changed
  │── tools/list → [navigate, search, back, action, map, compare]
  │
  │   Le LLM "voit" exactement la même chose que l'interface web.
  │   Sa navigation produit le même arbre contextuel.
```

## Le mécanisme MCP standard

Aucune invention de protocole. Tout repose sur des mécanismes MCP natifs :

| Besoin | Mécanisme MCP |
|---|---|
| Le contexte filtre les tools | `tools/list_changed` notification + `tools/list` dynamique |
| Les descriptions s'adaptent | Tool description recalculée par session |
| Les paramètres sont contraints | Zod enums dynamiques dans le schema |
| Le LLM sait où il est | Resource `geocontext://context` |
| Retour en arrière | Pile `history` dans le contexte de session |

## Filtrage contextuel des resources MCP

Au-delà des tools, les **resources** sont aussi filtrées par le contexte :

```
Contexte vide:
  geocontext://context           → { empty: true }

Territoire résolu (commune 25349):
  geocontext://context           → { level, code, name, hierarchy, themes[] }
  geocontext://themes/commune    → thèmes disponibles pour ce niveau

Thème actif (urbanisme):
  geocontext://context           → { ...précédent, theme, data }
  geocontext://actions/urbanisme → actions possibles dans ce thème
  geocontext://layers            → couches cartographiques disponibles
```

Les resources servent aussi les clients MCP directs à se guider :
- `geocontext://context` = "où suis-je"
- `geocontext://themes/{level}` = "que puis-je explorer"
- `geocontext://actions/{theme}` = "que puis-je faire"
