# Outils dynamiques

## Principe

Le serveur expose **sept outils, toujours les mêmes**. Ce qui change avec le contexte de navigation, ce sont leurs **descriptions** et leurs **listes de valeurs autorisées** (`enum`), recalculées à chaque `tools/list`.

L'idée : un modèle qui n'a que des choix valides devant lui se trompe moins qu'un modèle qui doit deviner un nom de thème, de couche ou d'action. Par exemple, `action` ne propose que les thèmes qui existent pour le niveau courant, et `map` ne propose que les couches réellement chargées.

> **Choix d'implémentation.** Une première version faisait apparaître et disparaître des outils selon le contexte. Elle a été abandonnée : plusieurs clients MCP ne relisent pas `tools/list` entre deux messages d'une même conversation, même après une notification `tools/list_changed`. Un outil absent à la première lecture restait donc inutilisable. Les sept outils sont donc toujours listés (`getTools()` dans `src/session/session.ts`). La notification `tools/list_changed` est tout de même émise, pour les clients qui la prennent en compte.

## Les sept outils

| Outil | Rôle | Valeurs contraintes selon le contexte |
|---|---|---|
| `navigate` | Résoudre un territoire (nom, code INSEE, coordonnées, identifiant de parcelle, département, SIREN d'EPCI) | description : propose le lieu courant comme point de départ |
| `search` | Rechercher un lieu, une donnée ou un type de couche | — |
| `back` | Revenir à l'état précédent (pile de 20 entrées) | — |
| `action` | Charger un thème ou une donnée précise | `enum` = thèmes du niveau courant ; avec un thème actif, ses sous-actions puis les autres thèmes |
| `map` | `show`, `hide`, `filter`, `clear_filter` sur une couche | `layer` = couches actives |
| `compare` | Croiser le thème courant avec un autre | `theme` = autres thèmes disponibles |
| `select` | Se positionner sur un objet d'une couche (parcelle, etc.) | — |

Trois autres outils (`ui_poll`, `ui_ack`, `ui_state`) ne sont **pas annoncés** aux modèles : ils servent à la surface d'affichage (voir [guide-technique.md](guide-technique.md#8-la-surface-daffichage-et-laccusé)).

## Exemple : ce que voit un client selon le contexte

Valeurs relevées sur le code, pour la commune de Cassis (13022) :

- **Aucun territoire** : `action` est décrit comme « Naviguez d'abord vers un territoire », sans liste de valeurs.
- **Commune sans thème** : `action` propose `identite, urbanisme, cadastre, risques, environnement, transport, hydrologie, bati, energie, economie`.
- **Commune, thème urbanisme** : `action` propose `document, zonages, prescriptions, servitudes`, suivis des autres thèmes, et accepte un paramètre `filter`.
- **Aucune couche chargée** : `map` indique qu'il faut d'abord exécuter une action ; **avec couches** : sa description liste les couches actives et précise que le résultat est l'état **relu sur la carte**.

Les thèmes proposés dépendent du niveau (région, département, EPCI, commune, parcelle, bâtiment) : voir `THEMES_BY_LEVEL` dans `src/session/types.ts` et [data-model.md](data-model.md).

## Ressources et prompt

En plus des outils, le serveur publie :

- `geocontext://context` : état résumé (territoire, hiérarchie, thème, couches) ;
- `geocontext://themes/{niveau}` et `geocontext://actions/{thème}` ;
- `geocontext://layers` ;
- le prompt `geocontext-guide` : rappel du cycle de navigation avec le contexte courant.

## Relation avec les outils d'origine

Le projet d'origine exposait un outil MCP par service (`geocode`, `altitude`, `adminexpress`, `cadastre`, `urbanisme`, `assiette_sup`, `gpf_wfs_*`). Ces fichiers sont conservés dans `src/tools/`, mais **le serveur actuel ne les expose plus** : `src/index.ts` ne publie que les outils de la session. La couche `src/session/` s'appuie sur les clients de `src/gpf/` (géocodage, altimétrie, WFS…) et ajoute la navigation, le contexte et les vérifications.
