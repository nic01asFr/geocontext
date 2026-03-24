/**
 * geocontext — Registry Public API
 *
 * Exports publics du registre. Tout consommateur externe importe depuis
 * ce fichier plutôt que depuis les sous-modules.
 *
 * @example
 *   import { registry, executeSource, buildUITree } from "../session/registry/index.js";
 *
 *   const sources = registry.getSources("commune", "urbanisme", "zonages");
 *   const result = await executeSource(sources[0], context);
 *   const tree = buildUITree(context, registry);
 */

// Types
export type {
  EndpointId,
  EndpointDef,
  EndpointProtocol,
  CRS,
  RetryPolicy,
  PivotStrategy,
  PivotFrom,
  AttributePivot,
  SpatialPivot,
  AttributeWithFallbackPivot,
  CompositePivot,
  FieldDef,
  FieldType,
  FieldTransform,
  UserFilterDef,
  UserFilterType,
  SourceDef,
  SourcePriority,
  SourceConstraints,
  SourceResult,
  ExecutionParams,
  RegistryKey,
  UITreeNode,
  UIIcon,
} from "./types.js";

// Registry
export { Registry, registry } from "./registry.js";
export { buildRegistryKey } from "./types.js";

// Endpoints
export { ENDPOINTS, getEndpoint } from "./endpoints.js";

// Pivot
export {
  extractPivotValue,
  buildAttributeCql,
  buildSpatialCql,
  buildFallbackCql,
  buildCompositeCql,
  buildRestParams,
  escapeCql,
  geojsonToWkt,
} from "./pivot.js";

// Fields & Filters
export {
  applyTransform,
  applyFieldTransforms,
  transformFeature,
  transformFeatures,
  extractPrimaryFields,
  formatFieldValue,
  formatFeatureAsText,
} from "./fields.js";

export {
  userFilterToCql,
  combineUserFiltersCql,
  userFilterToParam,
  combineUserFiltersParams,
} from "./filters.js";

// UI Tree
export {
  buildUITree,
  buildActionDescription,
  buildActionEnums,
  THEME_META,
} from "./tree.js";

// Sources (re-exports groupés pour accès direct si besoin)
export { ADMINEXPRESS_SOURCES } from "./sources/adminexpress.js";
export { URBANISME_SOURCES } from "./sources/urbanisme.js";
export { CADASTRE_SOURCES } from "./sources/cadastre.js";
export { RISQUES_SOURCES } from "./sources/risques.js";
export { ENVIRONNEMENT_SOURCES } from "./sources/environnement.js";
export { TRANSPORT_SOURCES } from "./sources/transport.js";
export { HYDROLOGIE_SOURCES } from "./sources/hydrologie.js";
export { BATI_SOURCES } from "./sources/bati.js";
export { ENERGIE_SOURCES } from "./sources/energie.js";
export { ECONOMIE_SOURCES } from "./sources/economie.js";
