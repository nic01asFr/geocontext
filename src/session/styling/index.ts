/**
 * geocontext — Style Orchestrator
 *
 * Point d'entrée pour obtenir un StyleRecipe pour une source.
 * Phase 1 (actuelle) : déterministe, instantané.
 * Phase 2 (future) : enrichissement LLM async avec cache.
 */

import type { SourceDef } from "../registry/types.js";
import type { StyleRecipe } from "./types.js";
import { deriveStyleRecipe } from "./deterministic.js";

// Cache en mémoire : clé = "sourceId:territoryLevel"
const cache = new Map<string, StyleRecipe>();

/**
 * Retourne un StyleRecipe pour une source.
 *
 * @param source    — définition de la source
 * @param features  — features transformées (échantillon ou toutes)
 * @param level     — niveau territorial courant (pour le cache)
 * @param label     — label contextuel pour la légende
 */
export function getStyleRecipe(
  source: SourceDef,
  features: Record<string, unknown>[],
  level?: string | null,
  label?: string,
): StyleRecipe {
  const cacheKey = `${source.id}:${level || "default"}`;

  const cached = cache.get(cacheKey);
  if (cached) return cached;

  // Phase 1 : déterministe
  const recipe = deriveStyleRecipe(source, features, label);
  cache.set(cacheKey, recipe);
  return recipe;
}

/** Vide le cache (nouveau territoire). */
export function clearStyleCache(): void {
  cache.clear();
}

export type { StyleRecipe } from "./types.js";
export type { LegendConfig, LegendItem } from "./types.js";
