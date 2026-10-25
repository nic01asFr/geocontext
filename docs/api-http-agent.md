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

### Fonctionnement
- À **chaque étape**, la liste d'outils (descriptions et énumérations dépendant du contexte) et le bloc « contexte actuel » (territoire, couches, comptes relus à l'écran, filtres, champs filtrables) sont relus : un outil appelé à l'étape précédente a pu les changer.
- Après chaque outil qui change l'affichage, la page accuse ce qu'elle a réellement affiché (`/agent/ack`) ; l'agent ne poursuit qu'avec cet état réel ou une erreur. Sans accusé dans le délai : « NON CONFIRMÉ », jamais « fait ».
- Les résultats d'outils sont transmis au modèle comme **données** (préfixe explicite, et règle du prompt : jamais exécutés comme des instructions).
- Le prompt système porte les règles de vérité (aucun chiffre hors résultat d'outil, erreurs rapportées telles quelles, résultats partiels dits) et décrit le mode de territoire exact (objets écartés et à cheval, refus de volume rapporté tel quel, aucun total approché).
- Un tour qui échoue restaure l'historique : ni appel d'outil orphelin, ni demi-réponse.
- L'historique est conservé **en mémoire, par session** : il disparaît avec la session ou le redémarrage du processus, comme la session elle-même (conserver l'un sans l'autre donnerait une conversation sans le contexte qu'elle suppose).

### Modèle
- API « chat completions » compatible OpenAI, en flux, avec appels d'outils : `AGENT_LLM_BASE_URL`, `AGENT_LLM_API_KEY`, `AGENT_LLM_MODEL`. Sans `BASE_URL` et `MODEL`, l'agent est désactivé (`/agent/status`). D'autres formats d'API (Anthropic natif, « Responses ») ne sont pas gérés : il faut une passerelle compatible.
- Le contenu de raisonnement (`<think>…</think>` dans le texte ; champs `reasoning_content` / `reasoning`) n'est ni affiché ni renvoyé au modèle.
- `AGENT_TEMPERATURE` (0,2 par défaut ; `none` pour l'omettre si le modèle la refuse).
- **Reprises** : jusqu'à `AGENT_LLM_RETRIES` (2 par défaut, 5 au plus) avec attente croissante (ou `Retry-After`, 20 s au plus) pour les seules erreurs passagères (429, 5xx, réseau) et avant tout flux reçu. Une erreur de requête (400, 401…) n'est jamais rejouée. Le nombre de tentatives est dit dans l'erreur.
- Une réponse coupée par la limite de sortie en plein appel d'outil n'est **pas exécutée** (erreur explicite) ; une réponse texte coupée porte la mention.

### Bornes (toutes configurables ; toute limite atteinte est dite à l'utilisateur)
| Variable | Défaut | Rôle |
|---|---|---|
| `AGENT_MAX_STEPS` | 10 | étapes par message |
| `AGENT_STEP_TIMEOUT_MS` | 90 000 | durée d'une étape du modèle, reprises comprises |
| `AGENT_TOOL_TIMEOUT_MS` | 150 000 | durée d'un outil |
| `AGENT_ACK_TIMEOUT_MS` | 120 000 | attente de l'accusé de la page |
| `AGENT_MAX_MSG_PER_HOUR` / `_IP` | 40 / 120 | messages par heure, par session / par adresse |
| `AGENT_MAX_TOKENS_PER_HOUR` / `_IP` | 300 000 / 1 000 000 | **jetons** par heure (valeur annoncée par le modèle ; à défaut, estimation ≈ 3,5 caractères par jeton, signalée dans le journal) |
| `AGENT_MAX_USER_CHARS` | 2 000 | taille d'un message |
| `AGENT_HISTORY_CHARS` | 48 000 | taille de l'historique conservé (tours entiers retirés) |
| `AGENT_PROMPT_CHARS` | 150 000 | total envoyé au modèle : consigne + contexte + outils + historique ; au-delà, erreur explicite |
| `AGENT_TOOL_RESULT_CHARS` | 7 000 | résultat d'outil montré au modèle (la troncature est dite) |
| `AGENT_MAX_OUTPUT_TOKENS` | 1 500 | sortie du modèle par étape |
| `AGENT_TRUST_PROXY` | non | à `1` seulement derrière un proxy inverse de confiance : l'adresse est alors la dernière entrée de `X-Forwarded-For` ; sinon l'adresse de la connexion |

La clé n'est écrite ni dans les réponses, ni dans les journaux, ni dans les erreurs. Les compteurs sont en mémoire et purgés quand ils sont périmés.

### Tests
`test/agent/agent.test.ts` (sans réseau externe : faux modèle en flux et fausse session) couvre : tour complet avec accusé, relecture des outils à chaque étape, accusé manquant, arguments invalides, appel coupé, limite d'étapes, reprises (429, 503, 400), température et clé, plafonds (jetons, messages, adresse), contexte trop grand, élagage de l'historique, filtre de raisonnement.

## Recherche : état réel et pistes

**Aujourd'hui** : l'outil `search` et la recherche de types de couches utilisent MiniSearch (correspondance par mots, tolérante aux fautes). Il n'y a **aucune recherche sémantique** (pas d'embeddings, pas d'index vectoriel) et **aucune API publique dédiée** à la recherche : elle n'est accessible que par l'outil MCP `search` ou, via `/agent/chat`, par un agent.

**Pistes, non implémentées** (à étudier avant toute décision) :
1. Exposer en HTTP une route de recherche sur le registre de sources (aujourd'hui interne), sans modèle : simple, déterministe, vérifiable.
2. Ajouter une recherche par embeddings sur les descriptions du registre. Coût : un modèle d'embeddings, un index à tenir à jour, et un risque de résultats plausibles mais hors sujet à encadrer (seuil, affichage du score, repli explicite).
3. Pour un usage « question en langue naturelle → données », l'agent actuel suffit à enchaîner les outils ; une API dédiée à cet usage supposerait de décider de l'authentification, du suivi de coût et du format de réponse (réponse + sources + états d'affichage).

Chaque piste est une hypothèse de conception, pas un engagement.
