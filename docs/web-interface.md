# Interface web — geocontext

## Principe

L'interface web est un client du serveur MCP geocontext (en mode `http`). Elle combine une carte interactive, des panneaux thématiques et un chat avec agent LLM. Les trois partagent le **même contexte de session MCP**.

## Layout

```
┌──────────────────────────────────────────────────────────────────┐
│ 🔍 [_______________] [niveau ▾]            geocontext      [?][⚙]│
├───────────┬──────────────────────────────────────┬───────────────┤
│           │                                      │               │
│ CONTEXTE  │              CARTE                   │    CHAT       │
│           │                                      │               │
│ ▸ BFC     │         ┌────────────┐               │ User: ...     │
│  ▸ Doubs  │         │   carte    │               │               │
│   ▸ CC..  │         │  MapLibre  │               │ Agent: ...    │
│    ► Loray│         │            │               │               │
│           │         └────────────┘               │               │
│           │                                      │               │
│ THÈMES   │  ┌─────────────────────────────┐     │               │
│ ● Urbanis.│  │  Données thématiques        │     │               │
│ ○ Cadastre│  │  (tableaux, stats, listes)  │     │               │
│ ○ Risques │  └─────────────────────────────┘     │               │
│ ○ Environ.│                                      │               │
│           │                                      │ User: ____    │
└───────────┴──────────────────────────────────────┴───────────────┘
```

### Trois colonnes, un contexte

| Zone | Rôle | Interaction |
|------|------|-------------|
| **Panneau gauche** | Hiérarchie + thèmes | Clics = `navigate()` et `action()` |
| **Carte + données** | Visualisation spatiale + tableaux | Clics carte = `navigate()`, couches = `map()` |
| **Chat** | Langage naturel | Messages → LLM → tool calls MCP |

Toute interaction dans une zone modifie le contexte partagé. Les deux autres zones réagissent.

## La carte comme pivot de navigation

La carte n'est pas décorative. C'est le **pivot central** de la navigation :

| Action sur la carte | Résultat |
|---|---|
| Clic sur un point | Reverse geocoding → fiche commune |
| Clic sur une parcelle (zoom cadastral) | Navigation vers fiche parcelle |
| Clic sur un bâtiment (zoom max) | Navigation vers fiche bâtiment |
| Sélection d'une thématique | Couche superposée sur la carte |
| Hover sur une feature carte | Tooltip avec infos clés |
| Hover sur une ligne du tableau | Feature correspondante surlignée |

### Zoom adaptatif = niveau adaptatif

```
Zoom 6-8    → régions/départements
Zoom 9-11   → EPCI/communes
Zoom 12-16  → parcelles cadastrales
Zoom 17+    → bâtiments individuels
```

Le niveau de zoom détermine le niveau territorial visible. Pas de sélecteur explicite nécessaire (mais disponible dans la barre de recherche pour forcer).

## Le chat avec agent

Le chat intègre un agent LLM standard qui utilise le serveur MCP. L'agent :

1. **Lit le contexte courant** — il sait où l'utilisateur se trouve (territoire, thème, couches)
2. **Reçoit des tools filtrés** — seuls les tools pertinents pour le contexte courant
3. **Peut agir sur la vue** — ses tool calls modifient la carte et les panneaux

### Flux chat

```
User tape: "Montre-moi les zones inondables"
    │
    ▼
Frontend construit le prompt:
  - System: contexte courant (commune Loray, thème urbanisme, bbox...)
  - Tools: filtrés pour ce contexte
  - Message: "Montre-moi les zones inondables"
    │
    ▼
Claude API
  → tool_use: action("risques") ou wfs_getFeatures(GEORISQUES, bbox)
    │
    ▼
Serveur MCP geocontext
  → exécute, retourne GeoJSON
    │
    ▼
Frontend
  → ajoute la couche sur la carte
  → affiche la réponse textuelle dans le chat
  → met à jour le contexte partagé
```

### Actions de l'agent sur la vue

L'agent peut retourner des commandes de vue dans ses réponses :

```typescript
type MapAction =
  | { type: "addLayer"; geojson: GeoJSON; style: LayerStyle; name: string }
  | { type: "removeLayer"; name: string }
  | { type: "setFilter"; layer: string; filter: Expression }
  | { type: "fitBounds"; bbox: BBox }
  | { type: "highlight"; featureIds: string[] }
  | { type: "setTheme"; theme: string }
  | { type: "navigate"; territory: string; level: string }
  | { type: "createThematicMap"; config: ThematicMapConfig }
```

## Fiches par niveau

### Fiche commune (coeur du service)

```
┌─ LORAY (25349) ──────────────────────────────────────────┐
│  Population: 450    Superficie: 14,2 km²    Alt: 810 m   │
│                                                           │
│  ┌─────────┬──────────┬────────┬─────────┬──────────┐    │
│  │Urbanisme│ Cadastre │Risques │ Environ.│ Économie │    │
│  └────┬────┴──────────┴────────┴─────────┴──────────┘    │
│       │                                                   │
│  URBANISME                                                │
│  Document : PLU opposable (15/03/2018)                    │
│  Zonages : ■ U 12ha ■ AU 3ha ■ A 340ha ■ N 580ha        │
│  Prescriptions (2) · Servitudes (1)                       │
└───────────────────────────────────────────────────────────┘
```

### Fiche parcelle

```
┌─ PARCELLE 25349000AB0023 ────────────────────────────────┐
│  Section AB · Contenance: 1 200 m² · Zone PLU: U         │
│                                                           │
│  Transactions DVF                                         │
│  2019-06-12  Vente maison   85 000 €   95 m²             │
│                                                           │
│  Bâtiments (2) via RNB                                    │
│  · Maison 95 m² · 1975 · DPE D                           │
│  · Dépendance 25 m²                                      │
└───────────────────────────────────────────────────────────┘
```

### Fiche bâtiment

```
┌─ BÂTIMENT A1B2-C3D4-E5F6 ───────────────────────────────┐
│  Parcelle: AB0023 · Hauteur: 8 m · Construction: 1975    │
│                                                           │
│  Énergie (BDNB)                                           │
│  DPE : D · 215 kWh/m²/an · Chauffage fioul               │
│  Isolation : non isolé · Surchauffe été : risque moyen    │
└───────────────────────────────────────────────────────────┘
```

## Stack technique envisagée

| Composant | Technologie | Rôle |
|-----------|-------------|------|
| Carte | MapLibre GL JS | Rendu tuiles vectorielles, interactions |
| Fond de carte | Tuiles IGN Plan/Ortho/Cadastre | Fonds cartographiques |
| UI | Vue.js ou Svelte | Interface réactive légère |
| Client MCP | HTTP vers geocontext | Appels tools et resources |
| LLM | Claude API (Sonnet/Haiku) | Agent conversationnel |
| Backend | geocontext en mode http | Serveur MCP unique |

Le frontend n'a pas de backend propre. Il appelle directement le serveur MCP geocontext via HTTP et l'API Claude pour le chat.

## Mode sans LLM

L'interface fonctionne complètement sans LLM. La carte + les panneaux + la recherche suffisent pour naviguer et consulter toutes les données. Le chat est un enrichissement optionnel.

```
SANS LLM                           AVEC LLM
────────                            ────────
Clic carte → données               Idem + langage naturel
Onglets thématiques                 Idem + questions complexes
Recherche textuelle                 Idem + synthèse narrative
Navigation manuelle                 Navigation guidée par l'agent
```
