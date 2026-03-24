/**
 * geocontext — User Filter Construction
 *
 * Transforme les filtres utilisateur (choisis dans l'interface ou par le LLM)
 * en fragments de requête concrets (CQL pour WFS, query params pour REST).
 *
 * Chaîne :
 *   UserFilterDef + valeur saisie → fragment CQL ou query param → ajouté à la requête
 *
 * Les UserFilterDef sont déclarés dans chaque SourceDef.
 * Ce module fournit les fonctions de conversion.
 *
 * @see registry/types.ts — UserFilterDef, UserFilterType
 */

import type { UserFilterDef } from "./types.js";
import { escapeCql } from "./pivot.js";

// ==========================================================================
// Conversion filtre → CQL (pour WFS)
// ==========================================================================

/**
 * Convertit un filtre utilisateur en fragment CQL.
 *
 * @param filter — définition du filtre
 * @param value  — valeur saisie par l'utilisateur/LLM
 * @returns fragment CQL à combiner avec AND, ou null si non applicable
 *
 * @example
 *   // Filtre enum "type de zone"
 *   userFilterToCql(
 *     { key: "type_zone", type: "enum", toCql: "typezone = '{value}'", ... },
 *     "U"
 *   ) → "typezone = 'U'"
 *
 *   // Filtre date_range "période"
 *   userFilterToCql(
 *     { key: "period", type: "date_range", toCql: "date_mutation", ... },
 *     { from: "2020-01-01", to: "2023-12-31" }
 *   ) → "date_mutation >= '2020-01-01' AND date_mutation <= '2023-12-31'"
 *
 *   // Filtre number_min "surface minimale"
 *   userFilterToCql(
 *     { key: "surface_min", type: "number_min", toCql: "superficie", ... },
 *     500
 *   ) → "superficie >= 500"
 */
export function userFilterToCql(filter: UserFilterDef, value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (!filter.toCql) return null;

  switch (filter.type) {
    case "enum": {
      if (typeof value !== "string") return null;
      // Template avec {value} remplacé
      return filter.toCql.replace("{value}", escapeCql(value));
    }

    case "text": {
      if (typeof value !== "string" || value.trim() === "") return null;
      // Recherche textuelle avec LIKE
      return filter.toCql.replace("{value}", escapeCql(value));
    }

    case "date_range": {
      const range = value as { from?: string; to?: string };
      const clauses: string[] = [];
      if (range.from) {
        clauses.push(`${filter.toCql} >= '${escapeCql(range.from)}'`);
      }
      if (range.to) {
        clauses.push(`${filter.toCql} <= '${escapeCql(range.to)}'`);
      }
      return clauses.length > 0 ? clauses.join(" AND ") : null;
    }

    case "number_min": {
      if (typeof value !== "number") return null;
      return `${filter.toCql} >= ${value}`;
    }

    case "number_max": {
      if (typeof value !== "number") return null;
      return `${filter.toCql} <= ${value}`;
    }

    case "number_range": {
      const range = value as { min?: number; max?: number };
      const clauses: string[] = [];
      if (range.min !== undefined) {
        clauses.push(`${filter.toCql} >= ${range.min}`);
      }
      if (range.max !== undefined) {
        clauses.push(`${filter.toCql} <= ${range.max}`);
      }
      return clauses.length > 0 ? clauses.join(" AND ") : null;
    }

    default:
      return null;
  }
}

/**
 * Combine plusieurs filtres utilisateur en un seul fragment CQL (AND).
 *
 * @param filters    — définitions des filtres
 * @param values     — valeurs saisies (clé = filter.key, valeur = saisie)
 * @returns fragment CQL combiné, ou null si aucun filtre actif
 *
 * @example
 *   combineUserFiltersCql(
 *     [typeZoneFilter, surfaceFilter],
 *     { type_zone: "U", surface_min: 500 }
 *   ) → "typezone = 'U' AND superficie >= 500"
 */
export function combineUserFiltersCql(
  filters: UserFilterDef[],
  values: Record<string, unknown>,
): string | null {
  const clauses: string[] = [];

  for (const filter of filters) {
    const value = values[filter.key];
    if (value === undefined) continue;
    const cql = userFilterToCql(filter, value);
    if (cql) clauses.push(cql);
  }

  return clauses.length > 0 ? clauses.join(" AND ") : null;
}

// ==========================================================================
// Conversion filtre → query params REST
// ==========================================================================

/**
 * Convertit un filtre utilisateur en paramètre REST (query string).
 *
 * @param filter — définition du filtre
 * @param value  — valeur saisie
 * @returns paire clé/valeur pour query string, ou null si non applicable
 *
 * @example
 *   userFilterToParam(
 *     { key: "naf", type: "enum", toParam: "activitePrincipaleEtablissement", ... },
 *     "62.01Z"
 *   ) → { "activitePrincipaleEtablissement": "62.01Z" }
 */
export function userFilterToParam(
  filter: UserFilterDef,
  value: unknown,
): Record<string, string> | null {
  if (value === null || value === undefined) return null;
  if (!filter.toParam) return null;

  switch (filter.type) {
    case "enum":
    case "text": {
      if (typeof value !== "string" || value.trim() === "") return null;
      return { [filter.toParam]: value };
    }

    case "date_range": {
      const range = value as { from?: string; to?: string };
      const params: Record<string, string> = {};
      if (range.from) params[`${filter.toParam}_min`] = range.from;
      if (range.to) params[`${filter.toParam}_max`] = range.to;
      return Object.keys(params).length > 0 ? params : null;
    }

    case "number_min": {
      if (typeof value !== "number") return null;
      return { [`${filter.toParam}_min`]: String(value) };
    }

    case "number_max": {
      if (typeof value !== "number") return null;
      return { [`${filter.toParam}_max`]: String(value) };
    }

    case "number_range": {
      const range = value as { min?: number; max?: number };
      const params: Record<string, string> = {};
      if (range.min !== undefined) params[`${filter.toParam}_min`] = String(range.min);
      if (range.max !== undefined) params[`${filter.toParam}_max`] = String(range.max);
      return Object.keys(params).length > 0 ? params : null;
    }

    default:
      return null;
  }
}

/**
 * Combine plusieurs filtres utilisateur en params REST.
 *
 * @param filters — définitions des filtres
 * @param values  — valeurs saisies
 * @returns paramètres query combinés
 */
export function combineUserFiltersParams(
  filters: UserFilterDef[],
  values: Record<string, unknown>,
): Record<string, string> {
  const params: Record<string, string> = {};

  for (const filter of filters) {
    const value = values[filter.key];
    if (value === undefined) continue;
    const result = userFilterToParam(filter, value);
    if (result) Object.assign(params, result);
  }

  return params;
}
