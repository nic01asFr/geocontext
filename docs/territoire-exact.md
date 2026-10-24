# Appartenance exacte à un territoire

Pour une couche « spatiale », la simple boîte englobante d'un territoire ramène des objets situés **à côté**. Dans le mode exact, le serveur décide pour chaque objet s'il appartient ou non au territoire et le dit.

## Règle

Pour chaque objet lu :
- **dedans** : compté ;
- **à cheval** sur la limite : compté, et listé avec une colonne « Position / <niveau> » ;
- **hors** : écarté, et **listé** (jamais abandonné en silence).

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
- **Niveaux parcelle et bâtiment** : le mode exact n'a pas été vérifié à ces niveaux.
- **Vérification indépendante** : pour la région, la comparaison avec un calcul indépendant par `jsts` n'a pas pu être menée à son terme (durée) ; les niveaux commune, EPCI et département ont été comparés.
- Les cas « point » hors commune ne sont pas tous testés.
- Le résultat dépend de l'état du service Géoplateforme au moment de la lecture ; une lecture qui échoue n'est jamais mise en cache.
