# Appartenance exacte à un territoire

Pour une couche « spatiale », la simple boîte englobante d'un territoire ramène des objets situés **à côté**. Dans le mode exact, le serveur décide pour chaque objet s'il appartient ou non au territoire et le dit.

## Règle

Pour chaque objet lu :
- **dedans** : compté ;
- **à cheval** sur la limite : compté, et listé avec une colonne « Position / <niveau> » ;
- **hors** : écarté, et **listé** (jamais abandonné en silence).

Le décompte est fait sur la **géométrie exacte** de l'objet recoupée avec le contour exact du territoire : jamais sur un rectangle. Le rectangle englobant ne sert qu'à ramener les candidats ; au-delà de la limite de volume, le serveur ne renvoie **aucun objet ni total** du rectangle, seulement un refus explicite (côté MCP comme côté page).

**Zone visible de la carte** (case « Limiter à la zone visible ») : la zone est un rectangle, et un objet n'est dans la zone que si sa géométrie (point, ligne, surface avec trous) a au moins un point commun avec ce rectangle. L'emprise rectangulaire de l'objet n'est qu'un préfiltre.

Le total affiché sur la carte est celui du tableau. Si l'on ne peut pas le garantir, la couche est **refusée avec un message explicite** — il n'y a ni échantillon, ni total approché.

## Mise en œuvre

- `src/emprise.ts` : contour du territoire (commune, EPCI, département, région) et décision par objet ;
- `src/territoire.ts` : décision rapide des cas certains (grille de cellules, bandes d'arêtes de la limite) ;
- `jsts` arbitre les cas ambigus (contact, alignement avec la limite) ;
- `src/exact-gpu.ts` : lecture complète par pages avec contrôles (nombre annoncé constant, pas de doublon, nombre lu égal au nombre attendu) ;
- `src/session/executors/executor.ts` : choix du mode ; erreur `ErreurVolume` au-delà de la limite (30 000 objets pour les couches lues par boîte englobante, 60 000 par défaut) ;
- `public/geo-fetcher.js` : le navigateur applique la liste d'exclusion du serveur (par identifiant) et ne refait un contrôle indépendant que lorsque c'est peu coûteux.

## Couches concernées

Couches lues par boîte englobante aux niveaux commune, EPCI, département, région : zones naturelles (ZNIEFF I et II, Natura 2000, parcs naturels régionaux, réserves naturelles nationales, parcs nationaux), cours d'eau, plans d'eau, routes, voies ferrées. Pour le bâti d'une commune, une lecture par tuiles exacte existe séparément (`src/tiles.ts`). Les documents d'urbanisme et servitudes (Géoportail de l'Urbanisme) sont lus par partition de document.

## Limites connues

- **Volumes** : les routes d'un département ou d'une région dépassent la limite (ordre de grandeur de la boîte englobante : plusieurs centaines de milliers à plusieurs millions d'objets) ; elles sont refusées explicitement à ces niveaux.
- **Niveau parcelle** : la géométrie exacte de la parcelle est portée par le contexte (`ctx.geometry`) et sert aux filtres `INTERSECTS` (zonage de la parcelle, bâtiments sur la parcelle). Le WKT est envoyé avec `SRID=4326;` : sans lui, le service lit les coordonnées en ordre latitude/longitude et ne renvoie rien. Vérifié contre un calcul indépendant (`jsts` sur les candidats du rectangle) sur 4 parcelles de Cassis : mêmes comptes pour les zonages et les bâtiments. Sources parcelle encore en erreur explicite : `argiles`, `ppr`, transactions.
- **Niveau bâtiment** : non navigable (refus explicite d'un identifiant BDTOPO) ; les bâtiments se chargent depuis la commune ou la parcelle.
- **DVF** : comptage seul, sans table ni couche. **SIRENE** : injoignable depuis le pod de test (erreur explicite).
- **Cartes de chaleur / hexagones** : la somme des cellules n'est pas relisible via l'API d'Atlas, donc non vérifiée contre le tableau.
- **Vérification indépendante** : pour la région, la comparaison avec un calcul indépendant par `jsts` n'a pas pu être menée à son terme (durée) ; les niveaux commune, EPCI et département ont été comparés.
- Les cas « point » hors commune ne sont pas tous testés.
- Le résultat dépend de l'état du service Géoplateforme au moment de la lecture ; une lecture qui échoue n'est jamais mise en cache.
