/**
 * geocontext — Registry Type Definitions
 *
 * Types fondamentaux du registre de données. Chaque type correspond à une
 * couche du système :
 *
 *   EndpointDef     →  Connexion vers un serveur (URL, protocole, CRS, limites)
 *   SourceDef       →  Une source de données unitaire (couche WFS ou route REST)
 *   PivotStrategy   →  Comment relier une requête au territoire courant
 *   FieldDef        →  Un champ retourné, avec label, type, unité, transformation
 *   UserFilterDef   →  Un filtre exposé à l'utilisateur/LLM
 *   UITreeNode      →  Un nœud de l'arborescence de navigation
 *
 * Convention : tous les identifiants sont en snake_case ASCII.
 * Convention : tous les labels et descriptions sont en français.
 *
 * @see docs/terrid-spec.md    — spécification des données
 * @see docs/data-model.md     — modèle de données
 */

import type { TerritoryLevel, Theme, NavigationContext } from "../types.js";

// ==========================================================================
// Endpoint — définition d'un serveur de données
// ==========================================================================

/**
 * Identifiant unique d'un endpoint.
 * Chaque endpoint correspond à un serveur ou une API distincte.
 */
export type EndpointId =
  | "gpf_wfs"           // data.geopf.fr/wfs — Géoplateforme WFS (principal)
  | "gpf_geocodage"     // data.geopf.fr/geocodage — géocodage/reverse
  | "gpf_altimetrie"    // data.geopf.fr/altimetrie — altitude
  | "bdnb"              // api.bdnb.io — Base de Données Nationale des Bâtiments
  | "georisques_wfs"    // georisques.gouv.fr/services — WFS Georisques
  | "georisques_rest"   // georisques.gouv.fr/api/v1 — REST Georisques
  | "rnb"               // rnb-api.beta.gouv.fr — Référentiel National Bâtiments
  | "dvf"               // api.cquest.org/dvf — Demandes de Valeurs Foncières
  | "ademe_dpe"         // data.ademe.fr — DPE détaillés
  | "insee_sirene"      // api.insee.fr/sirene — répertoire SIRENE
  | "sandre"            // services.sandre.eaufrance.fr — référentiel eau
  | "hubeau"            // hubeau.eaufrance.fr — Hub'Eau
  | "gesteau"           // maps.oieau.fr — SAGE/SDAGE
  | "culture"           // data.culture.gouv.fr — patrimoine
  | "education"         // data.education.gouv.fr — établissements scolaires
  | "drees";            // data.drees.gouv.fr — établissements santé

/**
 * Protocole d'accès d'un endpoint.
 *
 * - wfs       : OGC WFS (GetFeature, DescribeFeatureType, etc.)
 * - rest_json : API REST retournant du JSON
 * - rest_geojson : API REST retournant du GeoJSON
 * - geocodage : API spécifique géocodage Géoplateforme
 */
export type EndpointProtocol = "wfs" | "rest_json" | "rest_geojson" | "geocodage";

/**
 * Système de coordonnées.
 *
 * - EPSG:4326  : WGS84 (lon/lat) — référentiel interne du projet
 * - EPSG:2154  : Lambert-93 — utilisé par Georisques, Sandre, Gest'eau
 * - EPSG:3857  : Web Mercator — uniquement pour l'affichage carte
 */
export type CRS = "EPSG:4326" | "EPSG:2154" | "EPSG:3857";

/**
 * Politique de retry en cas d'erreur réseau ou rate-limiting.
 */
export interface RetryPolicy {
  /** Nombre maximum de tentatives (incluant la première) */
  maxRetries: number;
  /** Délai initial en ms (doublé à chaque retry = backoff exponentiel) */
  initialDelayMs: number;
  /** Codes HTTP déclenchant un retry */
  retryOnStatus: readonly number[];
}

/**
 * Définition d'un endpoint — un serveur de données distant.
 *
 * Chaque endpoint est défini une seule fois. Les SourceDef le référencent
 * par son `id`. L'executor utilise ces informations pour construire et
 * envoyer les requêtes.
 */
export interface EndpointDef {
  id: EndpointId;
  /** URL de base (sans query params) */
  baseUrl: string;
  /** Protocole d'accès */
  protocol: EndpointProtocol;
  /** CRS natif du serveur — les requêtes spatiales et résultats sont dans ce CRS */
  nativeCrs: CRS;
  /** Nombre max de features par requête (WFS maxFeatures, REST page_size) */
  maxFeatures: number;
  /** Timeout par requête en ms */
  timeoutMs: number;
  /** Politique de retry */
  retry: RetryPolicy;
  /** Variable d'environnement contenant la clé API (null si pas d'auth) */
  authEnvVar: string | null;
  /**
   * Version du protocole WFS (uniquement pour protocol="wfs").
   * Ex: "2.0.0" pour Géoplateforme, "1.1.0" pour Georisques.
   */
  wfsVersion?: string;
}

// ==========================================================================
// Pivot — comment relier la requête au territoire courant
// ==========================================================================

/**
 * D'où extraire la valeur du pivot dans le contexte de navigation.
 *
 * Chaque valeur correspond à un chemin dans NavigationContext :
 * - "context.code"                       → context.code (code du territoire courant)
 * - "context.bbox"                       → context.bbox (emprise spatiale)
 * - "context.geometry"                   → géométrie complète (polygone commune, etc.)
 * - "hierarchy.commune.code"             → context.hierarchy.commune.code
 * - "hierarchy.departement.code"         → context.hierarchy.departement.code
 * - "hierarchy.region.code"              → context.hierarchy.region.code
 * - "hierarchy.epci.siren"              → context.hierarchy.epci.siren
 * - "hierarchy.parcelle.idpar"          → context.hierarchy.parcelle.idpar
 * - "hierarchy.batiment.id"             → context.hierarchy.batiment.id
 */
export type PivotFrom =
  | "context.code"
  | "context.bbox"
  | "context.geometry"
  | "hierarchy.commune.code"
  | "hierarchy.departement.code"
  | "hierarchy.region.code"
  | "hierarchy.epci.siren"
  | "hierarchy.parcelle.idpar"
  | "hierarchy.batiment.id";

/**
 * Filtre attributaire simple.
 * Produit : `attribute = 'valeur'` (CQL) ou `?attribute=valeur` (REST).
 */
export interface AttributePivot {
  strategy: "attribute";
  /** Nom de l'attribut côté source (ex: "code_insee", "partition") */
  attribute: string;
  /** D'où prendre la valeur dans le contexte */
  from: PivotFrom;
}

/**
 * Filtre spatial — BBOX ou INTERSECTS sur la géométrie du territoire.
 *
 * Utilisé pour les couches sans attribut territorial (environnement,
 * transport, hydrologie, certains risques).
 *
 * - "bbox" : filtre par emprise rectangulaire (rapide, moins précis)
 * - "intersects" : filtre par intersection géométrique (précis, nécessite
 *   la géométrie complète du territoire)
 */
export interface SpatialPivot {
  strategy: "spatial";
  /** Type de filtre spatial */
  spatialOp: "bbox" | "intersects";
  /** Nom de la colonne géométrie côté source (défaut: "geom" ou "the_geom") */
  geometryColumn?: string;
  /**
   * D'où prendre la géométrie : "context.bbox" pour une bbox,
   * "context.geometry" pour le polygone complet du territoire.
   */
  from: "context.bbox" | "context.geometry";
}

/**
 * Filtre attributaire avec fallback — essaie un format, puis un autre.
 *
 * Cas d'usage principal : la partition urbanisme.
 * - Essai 1 : partition = code_insee (PLU communal)
 * - Essai 2 : partition = siren_epci + "_" + code_insee (PLUi)
 *
 * Le format trouvé est mis en cache dans le contexte pour les requêtes
 * suivantes sur le même territoire.
 */
export interface AttributeWithFallbackPivot {
  strategy: "attribute_with_fallback";
  attribute: string;
  /** Premier essai */
  primary: { from: PivotFrom };
  /** Deuxième essai si le premier retourne 0 résultats */
  fallback: {
    from: PivotFrom[];
    /** Séparateur entre les valeurs concaténées (ex: "_") */
    separator: string;
  };
  /** Clé de cache dans context.data pour mémoriser le format trouvé */
  cacheKey: string;
}

/**
 * Filtre composite — combine plusieurs attributs.
 * Produit : `attr1 = 'val1' AND attr2 = 'val2'`.
 */
export interface CompositePivot {
  strategy: "composite";
  parts: Array<{
    attribute: string;
    from: PivotFrom;
  }>;
}

/**
 * Union des stratégies de pivot possibles.
 */
export type PivotStrategy =
  | AttributePivot
  | SpatialPivot
  | AttributeWithFallbackPivot
  | CompositePivot;

// ==========================================================================
// Field — définition d'un champ retourné
// ==========================================================================

/**
 * Type d'un champ retourné par une source.
 *
 * - string   : texte libre
 * - number   : numérique (entier ou décimal)
 * - date     : date (parsée depuis le format source)
 * - boolean  : vrai/faux
 * - enum     : valeur parmi un ensemble fini connu
 * - geometry : géométrie GeoJSON (non affichée en texte, utilisée pour la carte)
 */
export type FieldType = "string" | "number" | "date" | "boolean" | "enum" | "geometry";

/**
 * Transformation à appliquer sur la valeur brute reçue de la source.
 *
 * - parse_date_iso     : "2024-03-15" → Date
 * - parse_date_fr      : "15/03/2024" → Date
 * - format_date_fr     : Date → "15 mars 2024" (affichage)
 * - round_2            : arrondi à 2 décimales
 * - m2_to_ha           : conversion m² → hectares
 * - cents_to_euros     : conversion centimes → euros
 * - uppercase          : mise en majuscules
 * - trim               : suppression espaces avant/après
 * - default            : valeur par défaut si null/undefined
 */
export type FieldTransform =
  | "parse_date_iso"
  | "parse_date_fr"
  | "format_date_fr"
  | "round_2"
  | "m2_to_ha"
  | "cents_to_euros"
  | "uppercase"
  | "trim"
  | { type: "default"; value: string | number | boolean };

/**
 * Définition d'un champ retourné par une source.
 *
 * Chaque SourceDef liste ses champs explicitement. C'est ce qui permet de :
 * - Ne demander que les attributs nécessaires au serveur (propertyName WFS)
 * - Afficher des labels en français dans l'interface
 * - Appliquer les bonnes transformations (dates, unités, arrondis)
 * - Distinguer les champs prioritaires (résumé LLM) des champs secondaires
 */
export interface FieldDef {
  /** Nom technique de l'attribut côté source (ex: "typezone", "valeur_fonciere") */
  key: string;
  /** Label en français pour l'interface (ex: "Type de zone", "Valeur foncière") */
  label: string;
  /** Type du champ */
  type: FieldType;
  /** Unité d'affichage (ex: "m²", "€", "hab", "ha") */
  unit?: string;
  /**
   * Valeurs possibles pour un champ de type "enum".
   * Clé = valeur technique, valeur = label français.
   * Ex: { "U": "Urbaine", "AU": "À Urbaniser", "A": "Agricole", "N": "Naturelle" }
   */
  enumValues?: Record<string, string>;
  /** Transformations à appliquer dans l'ordre sur la valeur brute */
  transforms?: FieldTransform[];
  /**
   * Champ prioritaire — inclus dans le résumé envoyé au LLM.
   * Les champs non-primary sont disponibles mais pas mis en avant.
   * Défaut : false.
   */
  primary?: boolean;
}

// ==========================================================================
// User Filter — filtre exposé à l'utilisateur / LLM
// ==========================================================================

/**
 * Type d'un filtre utilisateur.
 *
 * - enum        : choix dans une liste fermée (ex: type de zone U/AU/A/N)
 * - date_range  : période entre deux dates
 * - number_min  : seuil minimum (ex: surface_min)
 * - number_max  : seuil maximum
 * - number_range: fourchette min-max (ex: prix entre X et Y)
 * - text        : recherche textuelle libre (ex: nom d'entreprise)
 */
export type UserFilterType =
  | "enum"
  | "date_range"
  | "number_min"
  | "number_max"
  | "number_range"
  | "text";

/**
 * Définition d'un filtre exposé à l'utilisateur ou au LLM.
 *
 * Ces filtres apparaissent dans le schema du tool `action` comme paramètres
 * optionnels, et dans l'interface comme contrôles de filtrage.
 */
export interface UserFilterDef {
  /** Identifiant du filtre (ex: "type_zone", "period", "naf") */
  key: string;
  /** Label en français (ex: "Type de zone", "Période", "Code NAF") */
  label: string;
  /** Type de filtre */
  type: UserFilterType;
  /**
   * Valeurs possibles pour type "enum".
   * Clé = valeur technique, valeur = label français.
   */
  values?: Record<string, string>;
  /** Valeur par défaut si pertinent */
  defaultValue?: unknown;
  /**
   * Comment convertir la valeur utilisateur en filtre de requête.
   *
   * - Pour WFS (CQL) : template CQL avec {value} comme placeholder
   *   Ex: "typezone = '{value}'"
   * - Pour REST : nom du query param
   *   Ex: "code_naf"
   *
   * Cette information est utilisée par l'executor pour construire la requête.
   */
  toCql?: string;
  toParam?: string;
}

// ==========================================================================
// Source — définition d'une source de données unitaire
// ==========================================================================

/**
 * Priorité d'une source.
 *
 * Détermine l'ordre de chargement et le comportement en cas d'indisponibilité :
 * - required  : la source doit répondre, sinon erreur
 * - recommended : on la tente, mais on continue sans si elle échoue
 * - optional  : chargée uniquement sur demande explicite
 */
export type SourcePriority = "required" | "recommended" | "optional";

/**
 * Contraintes spécifiques à une source.
 *
 * Chaque contrainte déclenche un comportement particulier dans l'executor.
 */
export interface SourceConstraints {
  /**
   * La source n'a pas d'attribut territorial — filtre spatial obligatoire.
   * L'executor doit d'abord s'assurer que context.bbox (ou geometry) est rempli.
   * Couches concernées : environnement, transport, hydrologie.
   */
  spatialOnly?: boolean;

  /**
   * La source nécessite la géométrie complète du territoire (pas juste la bbox)
   * pour un filtre INTERSECTS précis. L'executor résout la géométrie si absente.
   */
  requiresGeometry?: boolean;

  /**
   * Le résultat peut dépasser maxFeatures — l'executor doit paginer
   * (WFS: startIndex, REST: page/offset).
   */
  paginable?: boolean;

  /**
   * Activer le mécanisme de fallback partition urbanisme.
   * @see AttributeWithFallbackPivot
   */
  partitionFallback?: boolean;

  /**
   * Champ contenant la date principale des données.
   * Permet le tri chronologique automatique et le filtre temporel uniforme.
   */
  dateField?: string;

  /**
   * Override du maxFeatures de l'endpoint pour cette source spécifique.
   */
  maxFeaturesOverride?: number;
}

/**
 * Définition d'une source de données unitaire.
 *
 * C'est la brique fondamentale du registre. Chaque source décrit :
 * - QUOI appeler (endpoint + typename/path)
 * - COMMENT filtrer (pivot strategy)
 * - QUOI retourner (fields)
 * - QUOI proposer comme filtres (userFilters)
 * - QUELLES contraintes respecter (constraints)
 *
 * Une entrée du registre (level × theme × action) pointe vers une ou
 * plusieurs SourceDef. Quand il y en a plusieurs, elles sont exécutées
 * en parallèle et leurs résultats sont fusionnés.
 */
export interface SourceDef {
  /** Identifiant unique (ex: "gpf_zone_urba", "georisques_radon", "dvf_mutations") */
  id: string;

  /** Label en français (ex: "Zonages PLU", "Potentiel radon", "Transactions DVF") */
  label: string;

  /** Description courte pour le LLM (ex: "Zones U/AU/A/N du PLU en vigueur") */
  description: string;

  /** Endpoint à utiliser */
  endpoint: EndpointId;

  /**
   * Nom de la couche WFS (pour protocol="wfs").
   * Ex: "URBANISME:zone_urba", "BDTOPO_V3:batiment"
   */
  typename?: string;

  /**
   * Chemin de l'API REST (pour protocol="rest_*").
   * Ex: "/v1/batiments_groupes", "/radon"
   * Les placeholders {id} sont remplacés par la valeur du pivot.
   */
  path?: string;

  /** Niveaux territoriaux où cette source est pertinente */
  levels: TerritoryLevel[];

  /** Thème auquel cette source appartient */
  theme: Theme;

  /**
   * Action au sein du thème (ex: "document", "zonages", "parcelles").
   * Correspond au sous-chemin sémantique : commune.urbanisme.{action}.
   * Si null, la source alimente le résumé du thème (vue d'ensemble).
   */
  action: string | null;

  /** Stratégie de pivot — comment relier au territoire courant */
  pivot: PivotStrategy;

  /** Champs retournés */
  fields: FieldDef[];

  /** Filtres exposés à l'utilisateur (optionnel) */
  userFilters?: UserFilterDef[];

  /** Contraintes d'exécution */
  constraints?: SourceConstraints;

  /** Priorité de la source */
  priority: SourcePriority;

  /**
   * Tri par défaut des résultats.
   * Ex: { field: "date_mutation", order: "desc" } pour DVF.
   */
  defaultSort?: {
    field: string;
    order: "asc" | "desc";
  };

  /**
   * Style d'affichage par défaut pour la couche cartographique.
   * Utilisé par le frontend pour renderer les features GeoJSON.
   */
  displayStyle?: {
    color?: string;
    opacity?: number;
    stroke?: string;
    strokeWidth?: number;
  };
}

// ==========================================================================
// Registry Entry — une entrée indexée du registre
// ==========================================================================

/**
 * Clé composite du registre : level.theme.action
 *
 * Exemples :
 * - "commune.urbanisme.zonages"
 * - "parcelle.transactions"  (action = null → "parcelle.cadastre")
 * - "batiment.energie.dpe"
 */
export type RegistryKey = string;

/**
 * Construit la clé de registre à partir de ses composants.
 */
export function buildRegistryKey(
  level: TerritoryLevel,
  theme: Theme,
  action?: string | null,
): RegistryKey {
  let key: string = `${level}.${theme}`;
  if (action) key += `.${action}`;
  return key;
}

// ==========================================================================
// UI Tree — arborescence de navigation pour l'interface
// ==========================================================================

/**
 * Icône pour un nœud de l'arborescence.
 * Utilise un sous-ensemble d'icônes standard (Lucide / Material).
 */
export type UIIcon =
  | "info"            // identité
  | "building"        // urbanisme
  | "map-pin"         // cadastre
  | "alert-triangle"  // risques
  | "leaf"            // environnement
  | "truck"           // transport
  | "droplets"        // hydrologie
  | "briefcase"       // économie
  | "home"            // bâti
  | "zap"             // énergie
  | "layers"          // générique données
  | "globe"           // territoire
  | "search"          // recherche
  | "chevron-right";  // navigation

/**
 * Nœud de l'arborescence de navigation.
 *
 * L'arbre est construit dynamiquement à partir du registre et du contexte
 * courant. Chaque nœud représente un thème, une action, ou un sous-niveau.
 *
 * L'interface web affiche cet arbre dans le panneau latéral.
 * Le LLM reçoit les labels et descriptions dans les enums du tool `action`.
 */
export interface UITreeNode {
  /** Identifiant unique du nœud (ex: "urbanisme", "urbanisme.zonages") */
  id: string;

  /** Label en français (ex: "Urbanisme", "Zonages PLU") */
  label: string;

  /** Description courte (ex: "Zones U/AU/A/N du PLU en vigueur") */
  description?: string;

  /** Icône */
  icon: UIIcon;

  /** Sous-nœuds (actions d'un thème, ou sous-thèmes) */
  children?: UITreeNode[];

  /**
   * IDs des sources dans le registre qui alimentent ce nœud.
   * Permet de savoir quelles requêtes déclencher quand l'utilisateur
   * clique sur ce nœud ou que le LLM appelle cette action.
   */
  sourceIds: string[];

  /**
   * Badge — compteur dynamique rempli après chargement.
   * null = pas encore chargé, number = nombre d'éléments.
   * Ex: 47 zonages, 234 parcelles, 3 arrêtés CatNat.
   */
  badge?: number | null;

  /** Le nœud est-il accessible dans le contexte courant ? */
  enabled: boolean;
}

// ==========================================================================
// Execution result — résultat normalisé d'un appel source
// ==========================================================================

/**
 * Résultat normalisé retourné par un executor après appel d'une source.
 *
 * Quel que soit le protocole (WFS, REST), le résultat est uniforme.
 * C'est ce que consomment le LLM (via le tool `action`) et l'interface.
 */
export interface SourceResult {
  /** ID de la source appelée */
  sourceId: string;

  /** Succès ou échec */
  success: boolean;

  /** Message d'erreur si échec */
  error?: string;

  /**
   * Données retournées — tableau d'objets clé/valeur.
   * Les clés correspondent aux FieldDef.key de la source.
   * Les valeurs sont déjà transformées (dates parsées, unités converties, etc.)
   */
  features: Record<string, unknown>[];

  /**
   * GeoJSON FeatureCollection pour affichage cartographique.
   * Présent uniquement si la source contient des géométries.
   * Toujours en EPSG:4326 (reprojection faite par l'executor si nécessaire).
   */
  geojson?: GeoJSON.FeatureCollection;

  /**
   * Spécification de couche pour fetch direct côté frontend.
   *
   * Le frontend utilise cette spec pour récupérer le GeoJSON directement
   * depuis Géoplateforme, sans transiter par le transport MCP
   * (qui a une limite de taille).
   *
   * Présent uniquement pour les sources WFS avec géométries.
   */
  layerSpec?: LayerSpec;

  /** Nombre total de résultats côté serveur (si connu, ex: WFS numberMatched) */
  totalCount?: number;

  /** true si le résultat est tronqué (nombre retourné < nombre total) */
  truncated?: boolean;

  /** Filtre partition trouvé (pour le cache) */
  resolvedPartition?: string;
}

/**
 * Spécification de couche pour fetch GeoJSON direct côté frontend.
 *
 * Le frontend construit l'URL WFS GetFeature et fetch le GeoJSON
 * directement depuis Géoplateforme. Cela évite de transiter les
 * géométries (potentiellement volumineuses) par le transport MCP.
 */
export interface LayerSpec {
  /** URL de base du service WFS */
  wfsUrl: string;

  /** TypeName WFS (ex: CADASTRALPARCELS.PARCELLAIRE_EXPRESS:parcelle) */
  typename: string;

  /** Filtre CQL complet (pivot + filtres utilisateur) */
  cqlFilter: string;

  /** CRS de sortie (toujours EPSG:4326 pour MapLibre) */
  srsName: string;

  /** Nombre max de features */
  maxFeatures: number;

  /** CRS natif de l'endpoint (pour reprojection si nécessaire) */
  nativeCrs?: string;

  /** Style suggéré pour l'affichage */
  style?: {
    color?: string;
    opacity?: number;
    stroke?: string;
    strokeWidth?: number;
  };
}

// ==========================================================================
// Executor config — paramètres passés à l'executor
// ==========================================================================

/**
 * Paramètres d'exécution construits par le registry pour l'executor.
 *
 * C'est le contrat entre le registry (qui sait QUOI appeler) et
 * l'executor (qui sait COMMENT appeler).
 */
export interface ExecutionParams {
  /** Définition de l'endpoint */
  endpoint: EndpointDef;

  /** Définition de la source */
  source: SourceDef;

  /** Contexte de navigation courant */
  context: NavigationContext;

  /**
   * Filtres utilisateur passés par le LLM ou l'interface.
   * Clé = UserFilterDef.key, valeur = valeur saisie.
   */
  userFilters?: Record<string, unknown>;

  /** Géométrie du territoire courant (si résolue) */
  geometry?: GeoJSON.Geometry;

  /** Override de pagination (pour demander une page spécifique) */
  pagination?: {
    startIndex: number;
    maxFeatures: number;
  };
}
