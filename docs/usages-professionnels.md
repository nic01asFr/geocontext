# Usages professionnels : ce qui est fiable, ce qui ne l'est pas

Ce projet reste un **prototype**. Ce document aide à décider de ce qu'on peut en attendre ; il ne constitue pas une garantie.

## Principes de fonctionnement qui servent un usage sérieux

- **Les données restent chez leur producteur.** Rien n'est copié : les objets sont lus à la demande auprès de la Géoplateforme et d'autres services publics.
- **Pas de résultat incomplet présenté comme complet.** Une lecture partielle, un total qui ne concorde pas ou un volume trop grand produisent une **erreur explicite** (voir [territoire-exact.md](territoire-exact.md)).
- **Tableau = carte.** Le nombre affiché est celui des objets effectivement listés ; les objets écartés sont listés.
- **Aucune valeur inventée.** Une donnée absente est dite absente (avec, quand il existe, le millésime de la source).
- **Liens par références contrôlés.** Les rapprochements (communes ↔ IRIS ↔ indicateurs, EPCI ↔ communes) s'accompagnent d'un rapport d'appariement ; un écart est signalé, pas comblé.

## Selon le mode d'usage

| Usage | Intérêt | Précautions |
|---|---|---|
| Consultation par un humain (interface web) | tableaux, cartes et totaux cohérents ; limites des territoires respectées | vérifier le millésime des sources ; la carte par défaut dépend d'un composant externe (voir [structures.md](structures.md)) |
| Client MCP (assistant) | l'assistant s'appuie sur des outils plutôt que sur sa mémoire | un modèle peut mal interpréter un résultat exact : demander les chiffres et sources, ne pas se fier à la seule synthèse |
| Agent intégré | enchaîne les outils et dit ce qui est réellement affiché | modèle choisi par l'exploitant ; protéger l'accès (voir [api-http-agent.md](api-http-agent.md)) |

## Ce qui n'est pas couvert

- Aucune valeur juridique : consulter la source officielle pour tout acte (zonage, servitude, transaction).
- Disponibilité dépendante des services amont ; pas de reprise de service garantie.
- Pas de gestion d'utilisateurs, de droits, d'historique d'audit.
- Certaines couches sont refusées à grande échelle (volumes) ; le message l'indique.
- Les niveaux parcelle et bâtiment, et certaines sources (transactions foncières, hydrométrie, entreprises), n'ont pas fait l'objet de la même vérification que les couches spatiales exactes.

## Pour aller plus loin

À étudier avant de recommander un usage à plus grande échelle : authentification, suivi des coûts de l'agent, épinglage de la version du composant cartographique externe, recherche sémantique (voir [api-http-agent.md](api-http-agent.md)), et cadre de maintenance si le projet est repris.
