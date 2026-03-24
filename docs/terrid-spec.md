# Spécification des données — geocontext

## Concept

geocontext est un service de contexte spatial multi-échelle. Il structure les données territoriales françaises en 6 niveaux hiérarchiques, chacun avec des thématiques adaptées et des sources de données spécifiques.

Le service est conçu pour être consommé par :
- Un **agent LLM** via MCP (tool calls dynamiques, resources contextuelles)
- Une **interface cartographique** (carte + panneaux + chat)
- Tout **client MCP conforme** (Claude Desktop, Cursor, etc.)

Les trois modes naviguent le même arbre de données et partagent le même mécanisme de contexte (voir [navigation-context.md](navigation-context.md)).

## Hiérarchie des niveaux et clés

```
RÉGION          code_insee (ex: "27")
  │
  ├── DÉPARTEMENT    code_insee (ex: "25")
  │     │
  │     ├── EPCI          code_siren (ex: "200067874")  ⚠ SIREN pas INSEE
  │     │     │
  │     │     └── COMMUNE       code_insee (ex: "25349")
  │     │           │
  │     │           ├── PARCELLE     idpar 14 chars (ex: "25349000AD0023")
  │     │           │     │
  │     │           │     └── BÂTIMENT    rnb_id / cleabs / batiment_groupe_id
  │     │           │
  │     │           └── (arrondissement municipal pour Paris/Lyon/Marseille)
  │     │
  │     ├── CANTON        code_insee
  │     └── ARRONDISSEMENT code_insee
  │
  └── COLLECTIVITÉ TERRITORIALE  code_insee (Corse, DROM)
```

### Remontée hiérarchique en 1 requête

La couche ADMINEXPRESS-COG.LATEST:commune contient tous les FK ascendants :

| Champ sur commune | Pointe vers | Clé cible |
|---|---|---|
| code_insee | commune elle-même | PK |
| siren_epci | EPCI | code_siren |
| code_insee_du_departement | département | code_insee |
| code_insee_de_la_region | région | code_insee |
| code_insee_du_canton | canton | code_insee |
| code_insee_de_l_arrondissement | arrondissement | code_insee |

## Identifiants pivots

| Identifiant | Format | Portée | Utilisé par |
|---|---|---|---|
| code_insee | 5 chars | Commune (clé universelle) | Toutes les sources |
| code_siren | 9 chars | EPCI | ADMINEXPRESS, wfs_du:document |
| code_dep | 2-3 chars | Département | BDTOPO, cadastre |
| partition | 5 ou 14 chars | Urbanisme/SUP | code_insee ou siren_code_insee |
| idpar | 14 chars | Parcelle cadastrale | DVF, Fichiers Fonciers, DV3F, BDNB, RNB, PCI |
| rnb_id | 12 chars (A1B2-C3D4-E5F6) | Bâtiment (permanent) | RNB, BDTOPO, BDNB |
| cleabs | ~24 chars | Bâtiment BDTOPO (stable) | BDTOPO, BDNB (source) |
| batiment_groupe_id | bdnb-bg-XXXX-XXXX-XXXX | Bâtiment BDNB (par vintage) | BDNB API |
| identifiant_ban | variable | Adresse BAN | DPE, RNB, BDNB |
| idurba | variable | Document urbanisme | zone_urba, prescriptions |

## Tools MCP

geocontext expose des tools dynamiques dont la surface change selon le contexte de session (voir [dynamic-tools.md](dynamic-tools.md)) :

### Tools permanents

```
navigate(target)     — Se déplacer dans l'arbre territorial
search(keywords)     — Chercher un lieu, une donnée, un type WFS
back()               — Remonter d'un cran
```

### Tools contextuels

```
action(action, filter?)    — Consulter une thématique (apparaît quand territoire résolu)
map(operation, layer, params?)  — Agir sur la carte (apparaît quand données chargées)
compare(with_theme)        — Croiser deux thématiques (apparaît quand thème actif)
select(feature_id)         — Sélectionner une feature (apparaît quand features visibles)
```

### Chemins sémantiques

Le LLM et l'interface naviguent avec des chemins thématiques :

```
commune.identité             → stats admin, population, surface
commune.urbanisme.document   → PLU/POS/CC/PSMV en vigueur
commune.urbanisme.zonages    → zones U/AU/A/N
commune.urbanisme.prescriptions
commune.urbanisme.servitudes
commune.cadastre.parcelles   → liste des parcelles
commune.cadastre.sections    → sections cadastrales
commune.risques              → aléas, PPRI, cavités, radon
commune.environnement        → ZNIEFF, Natura 2000, PNR
commune.économie             → entreprises SIRENE par NAF
parcelle.identité            → section, contenance, zonage
parcelle.transactions        → historique DVF
parcelle.bâtiments           → bâtiments RNB sur la parcelle
bâtiment.identité            → adresse, hauteur, année
bâtiment.énergie             → DPE, isolation, chauffage (via BDNB)
bâtiment.risques             → aléas ponctuels
```

## Endpoints

| # | Endpoint | Données | Priorité |
|---|----------|---------|----------|
| 1 | data.geopf.fr/wfs | ADMINEXPRESS, BDTOPO, cadastre, urbanisme, SUP, PROTECTEDAREAS, IRIS, OCS GE, RPG, BD Forêt, PEB | Principal |
| 2 | data.geopf.fr/geocodage | Géocodage/autocomplétion/reverse | Principal |
| 3 | data.geopf.fr/altimetrie | Altitude | Principal |
| 4 | api.bdnb.io | 400+ champs par bâtiment | Principal |
| 5 | georisques.gouv.fr/services (WFS) | PPR, sites pollués, ICPE, cavités | Secondaire |
| 6 | georisques.gouv.fr/api (REST) | GASPAR, radon, CatNat, argile | Secondaire |
| 7 | rnb-api.beta.gouv.fr | ID universel bâtiment | Secondaire |
| 8 | api.cquest.org/dvf | Transactions immobilières | Secondaire |
| 9 | data.ademe.fr | DPE détaillés | Secondaire |
| 10 | api.insee.fr/sirene | Entreprises par commune/NAF | Tertiaire |
| 11 | services.sandre.eaufrance.fr | Masses d'eau, captages, BD TOPAGE | Tertiaire |
| 12 | hubeau.eaufrance.fr | Qualité eau, hydrométrie | Tertiaire |
| 13 | maps.oieau.fr/ows/OIEau/gesteau | SAGE, SDAGE | Tertiaire |
| 14 | data.culture.gouv.fr | Monuments historiques | Tertiaire |
| 15 | data.education.gouv.fr | Établissements scolaires | Tertiaire |
| 16 | data.drees.gouv.fr | Établissements santé | Tertiaire |

## Contraintes techniques

| Contrainte | Mitigation |
|---|---|
| Max 2 couches/requête WFS (15/06/2026) | Requêtes unitaires parallélisées |
| Rate limits Géoplateforme | Retry backoff exponentiel |
| Couches environnement = spatial only | Récupérer bbox/géométrie entité d'abord |
| partition variable (PLU vs PLUi) | Tester les 2 formats |
| EPCI = SIREN pas INSEE | commune.siren_epci comme pont |
| BDNB régénère ses IDs par vintage | Utiliser rnb_id ou cleabs comme pivot stable |
| DPE → parcelle non fiable | Passer par BDNB (matching via BAN) |

## Bilan quantitatif

| Dimension | Nombre |
|---|---|
| Niveaux hiérarchiques | 6 |
| Couches WFS Géoplateforme | ~60 |
| Couches WFS Georisques | ~20 |
| Couches WFS Sandre/Gest'eau | ~12 |
| APIs REST | ~12 |
| Jeux CSV | ~6 |
| Total sources | ~110 |
| Entrées registre | ~150 |
| Données open | ~90% |
