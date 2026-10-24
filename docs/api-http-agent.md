# Routes HTTP, agent intégré et recherche

Ces routes n'existent qu'en mode `TRANSPORT_TYPE=http`.

## Routes

| Route | Rôle |
|---|---|
| `POST/GET/DELETE /mcp` | protocole MCP (Streamable HTTP) |
| `GET /tiles/{jeu}/{z}/{x}/{y}.json` | tuiles GeoJSON avec cache disque (`TILE_CACHE_DIR`), filtre de territoire exact optionnel ; `GET /tiles/stats` |
| `GET /liens/elus`, `/liens/mairie` | élu exécutif (Répertoire national des élus) et mairie (Annuaire de l'administration) |
| `GET /liens/epci` | fiche EPCI (BANATIC) avec contrôle de concordance de composition |
| `GET /liens/iris` | IRIS de la commune et indicateurs de recensement (API Melodi INSEE), avec rapport d'appariement |
| `GET /agent/status` | l'agent est-il configuré ? |
| `POST /agent/chat` | un tour de conversation, réponse en flux d'événements (SSE) |
| `POST /agent/ack` | accusé de la page : ce qu'elle a réellement affiché |
| `POST /agent/reset` | efface l'historique de la session |
| autres chemins | fichiers de `public/` |

## Agent intégré (`src/agent/agent.ts`)

Une boucle d'agent côté serveur, branchée sur **les mêmes outils** que le serveur MCP et sur **la même session** que la page : ce que l'agent fait se voit à l'écran.

- Fournisseur interchangeable, API « chat completions » compatible OpenAI : `AGENT_LLM_BASE_URL`, `AGENT_LLM_API_KEY`, `AGENT_LLM_MODEL`. Sans `BASE_URL` et `MODEL`, l'agent est désactivé (`/agent/status`).
- Bornes, toutes configurables : `AGENT_MAX_STEPS` (10), `AGENT_STEP_TIMEOUT_MS`, `AGENT_TOOL_TIMEOUT_MS`, `AGENT_ACK_TIMEOUT_MS`, `AGENT_MAX_MSG_PER_HOUR` (40 par session), `AGENT_MAX_MSG_PER_HOUR_IP` (120), `AGENT_MAX_USER_CHARS`, `AGENT_HISTORY_CHARS`, `AGENT_TOOL_RESULT_CHARS`, `AGENT_MAX_OUTPUT_TOKENS`. Toute limite atteinte est dite à l'utilisateur.
- Après chaque outil qui change l'affichage, la page accuse ce qu'elle a réellement affiché ; l'agent ne poursuit qu'avec cet état réel ou une erreur.
- La clé n'est pas écrite dans les réponses ni les journaux.
- L'historique est conservé en mémoire, par session.

## Sécurité : à lire avant tout déploiement

- **Aucune authentification** sur `/mcp`, `/agent/*`, `/tiles/*`, `/liens/*`, et CORS ouvert (`*`) sur `/mcp`. Le service est conçu pour un poste local ou un réseau de confiance.
- Si `AGENT_LLM_API_KEY` est renseignée, toute personne qui atteint `/agent/chat` consomme ce crédit, dans la limite des plafonds par session et par adresse. Un déploiement exposé doit se placer **derrière une authentification** (proxy inverse).
- Les plafonds par adresse reposent sur l'adresse vue par le serveur ; derrière un proxy, vérifier ce qu'elle représente.

## Recherche : état réel et pistes

**Aujourd'hui** : l'outil `search` et la recherche de types de couches utilisent MiniSearch (correspondance par mots, tolérante aux fautes). Il n'y a **aucune recherche sémantique** (pas d'embeddings, pas d'index vectoriel) et **aucune API publique dédiée** à la recherche : elle n'est accessible que par l'outil MCP `search` ou, via `/agent/chat`, par un agent.

**Pistes, non implémentées** (à étudier avant toute décision) :
1. Exposer en HTTP une route de recherche sur le registre de sources (aujourd'hui interne), sans modèle : simple, déterministe, vérifiable.
2. Ajouter une recherche par embeddings sur les descriptions du registre. Coût : un modèle d'embeddings, un index à tenir à jour, et un risque de résultats plausibles mais hors sujet à encadrer (seuil, affichage du score, repli explicite).
3. Pour un usage « question en langue naturelle → données », l'agent actuel suffit à enchaîner les outils ; une API dédiée à cet usage supposerait de décider de l'authentification, du suivi de coût et du format de réponse (réponse + sources + états d'affichage).

Chaque piste est une hypothèse de conception, pas un engagement.
