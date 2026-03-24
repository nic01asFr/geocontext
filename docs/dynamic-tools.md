# Tools dynamiques — geocontext

## Principe

Au lieu d'exposer 20+ tools statiques, geocontext expose une **surface minimale de tools dont les descriptions, paramètres et enums changent selon le contexte**. Le mécanisme MCP natif `tools/list_changed` signale au client de re-fetcher `tools/list` après chaque changement de contexte.

## Avantage

```
Approche statique (naïve)           Approche dynamique (geocontext)
─────────────────────────           ────────────────────────────────
20 tools permanents                 4-7 tools selon contexte
descriptions génériques             descriptions contextuelles
paramètres string libre             paramètres contraints (enums)
le LLM doit deviner                 le LLM choisit dans une liste

~3000 tokens pour les tools         ~800 tokens pour les tools
taux d'erreur élevé                 taux d'erreur minimal
```

## Surface de tools

### Tools permanents (toujours visibles)

| Tool | Description | Rôle |
|------|-------------|------|
| `navigate` | Se déplacer : territoire, thème, niveau, parent | Navigation dans l'arbre |
| `search` | Chercher : lieu, type de donnée, feature WFS | Recherche libre |
| `back` | Remonter d'un cran dans la pile | Retour arrière |

### Tools contextuels (apparaissent selon le contexte)

| Tool | Apparaît quand | Rôle |
|------|----------------|------|
| `action` | Territoire résolu | Consulter une thématique ou sous-donnée |
| `map` | Données géo chargées | Créer/modifier la carte (couches, filtres, styles) |
| `compare` | Thème actif + données | Croiser deux thématiques |
| `select` | Features visibles | Sélectionner une feature pour naviguer dedans |

### Nombre de tools selon le contexte

```
Contexte vide         → 3 tools   (navigate, search, back)
Territoire résolu     → 4 tools   (+action)
Thème consulté        → 5-6 tools (+map, +compare)
Features visibles     → 6-7 tools (+select)

Jamais plus de 7 tools exposés au LLM.
```

## Tools dynamiques en détail

### Le tool `action` — polymorphe selon contexte

Le même nom de tool, mais sa **description, ses enums et son schema changent** à chaque tour :

**Contexte : commune Loray, pas de thème**
```
name: "action"
description: "Consulter les données de Loray (25349).
  Thèmes disponibles : identité, urbanisme, cadastre, risques,
  environnement, économie, bâti"
schema:
  action: enum ["identité","urbanisme","cadastre","risques",
                "environnement","économie","bâti"]
```

**Contexte : commune Loray, thème urbanisme**
```
name: "action"
description: "Agir sur les données urbanisme de Loray.
  Actions : zonages, prescriptions, servitudes, reglement.
  Filtres applicables : type_zone, surface_min"
schema:
  action: enum ["zonages","prescriptions","servitudes","reglement"]
  filter: object (optional)
    type_zone: enum ["U","AU","A","N"]
    surface_min: number
```

**Contexte : parcelle AB0023, commune Loray**
```
name: "action"
description: "Agir sur la parcelle AB0023 (Loray).
  Actions : transactions, bâtiments, zonage, risques"
schema:
  action: enum ["transactions","bâtiments","zonage","risques"]
  period: object (optional, pour transactions)
    from: date
    to: date
```

### Le tool `map` — couches dynamiques

N'apparaît que quand des données géographiques sont chargées. Les **enums de couches sont dynamiques** :

```
name: "map"
description: "Carte de Loray — couches : PLU_zonage, GEORISQUES_inondation.
  Opérations : show, hide, highlight, filter, thematic, compare"
schema:
  operation: enum ["show","hide","highlight","filter","thematic","compare"]
  layer: enum ["PLU_zonage","GEORISQUES_inondation"]   ← dynamique !
  params: object (variable selon opération)
```

Le LLM ne peut pas inventer un nom de couche inexistant. Il choisit dans la liste contrainte.

### Le tool `navigate` — cibles contextuelles

Sa description change aussi pour guider le LLM :

**Contexte vide :**
```
description: "Naviguer vers un territoire. Accepte : nom de lieu,
  code INSEE, coordonnées (lon,lat), identifiant parcelle"
```

**Contexte : commune Loray :**
```
description: "Naviguer : vers un thème (urbanisme, cadastre...),
  vers le département 25, vers l'EPCI CC Plateau de Russey,
  vers une parcelle (section + numéro), ou vers une autre commune"
```

## Implémentation — le mécanisme

```typescript
class GeoContextSession {
  context: NavigationContext = { level: null, /* ... */ };

  // Appelé par le framework MCP sur tools/list
  getTools(): Tool[] {
    const tools: Tool[] = [
      this.buildNavigateTool(),  // toujours, description contextuelle
      this.buildSearchTool(),    // toujours
      BACK_TOOL,                 // toujours
    ];

    if (this.context.level) {
      tools.push(this.buildActionTool());
    }
    if (this.context.layers?.length) {
      tools.push(this.buildMapTool());
    }
    if (this.context.theme && this.context.data) {
      tools.push(this.buildCompareTool());
    }
    if (this.context.layers?.some(l => l.features?.length)) {
      tools.push(this.buildSelectTool());
    }

    return tools;
  }

  // Après chaque tool_call
  async handleToolCall(name: string, args: any): Promise<Result> {
    const result = await this.execute(name, args);
    const contextChanged = this.updateContext(name, args, result);

    if (contextChanged) {
      this.notify("tools/list_changed");  // signal MCP standard
    }

    return result;
  }

  // Génère le tool action avec enums dynamiques
  buildActionTool(): Tool {
    const actions = this.context.theme
      ? THEME_ACTIONS[this.context.theme]
      : LEVEL_THEMES[this.context.level!];
    const filters = this.context.theme
      ? AVAILABLE_FILTERS[this.context.theme]
      : undefined;

    return {
      name: "action",
      description: this.context.theme
        ? `Agir sur ${this.context.theme} de ${this.context.name}. `
          + `Actions : ${actions.map(a => a.label).join(", ")}.`
          + (filters ? ` Filtres : ${filters.join(", ")}` : "")
        : `Consulter les données de ${this.context.name}. `
          + `Thèmes : ${actions.map(a => a.label).join(", ")}`,
      schema: z.object({
        action: z.enum(actions.map(a => a.id) as [string, ...string[]]),
        filter: filters
          ? z.object(/* filtres dynamiques */).optional()
          : z.never().optional()
      })
    };
  }
}
```

## Compatibilité avec les tools existants

Les tools statiques actuels (`GeocodeTool`, `AdminexpressTool`, etc.) sont conservés comme **backends**. La couche session les orchestre :

```
Tool dynamique "action"
  │
  ├── action("urbanisme")  → appelle UrbanismeTool.execute()
  ├── action("cadastre")   → appelle CadastreTool.execute()
  ├── action("identité")   → appelle AdminexpressTool.execute()
  ├── action("servitudes")→ appelle AssietteSupTool.execute()
  └── action("zonages")    → appelle GpfWfsGetFeaturesTool.execute()

Tool dynamique "navigate"
  │
  ├── navigate("Loray")    → appelle GeocodeTool + AdminexpressTool
  └── navigate({parcelle})  → appelle CadastreTool

Tool dynamique "search"
  │
  └── search("zones inondables") → appelle GpfWfsSearchTypesTool
```

Les modules `src/gpf/` restent inchangés. La couche `src/session/` vient au-dessus.
