/**
 * geocontext — Field Transformations & Formatting
 *
 * Applique les transformations définies dans les FieldDef sur les valeurs
 * brutes retournées par les endpoints. Produit des valeurs normalisées
 * prêtes à consommer par le LLM et l'interface.
 *
 * Chaîne de traitement :
 *
 *   Valeur brute (API) → transforms[] → valeur normalisée → format affichage
 *
 * Exemples :
 *   "2024-03-15"  → parse_date_iso → Date(2024-03-15) → "15 mars 2024"
 *   234567.891    → round_2        → 234567.89        → "234 567,89 m²"
 *   12500000      → m2_to_ha       → 1250.00          → "1 250 ha"
 *
 * @see registry/types.ts — FieldDef, FieldTransform
 */

import type { FieldDef, FieldTransform } from "./types.js";

// ==========================================================================
// Transformation d'une valeur individuelle
// ==========================================================================

/**
 * Applique une transformation unitaire sur une valeur.
 *
 * @param value     — valeur courante (potentiellement déjà transformée)
 * @param transform — transformation à appliquer
 * @returns valeur transformée
 */
export function applyTransform(value: unknown, transform: FieldTransform): unknown {
  // Valeur null/undefined → seul "default" peut agir
  if (value === null || value === undefined) {
    if (typeof transform === "object" && transform.type === "default") {
      return transform.value;
    }
    return value;
  }

  // Transformations nommées
  if (typeof transform === "string") {
    switch (transform) {
      case "parse_date_iso":
        return parseDateIso(value);

      case "parse_date_fr":
        return parseDateFr(value);

      case "format_date_fr":
        return formatDateFr(value);

      case "round_2":
        return typeof value === "number" ? Math.round(value * 100) / 100 : value;

      case "m2_to_ha":
        return typeof value === "number" ? Math.round(value / 100) / 100 : value;

      case "cents_to_euros":
        return typeof value === "number" ? value / 100 : value;

      case "uppercase":
        return typeof value === "string" ? value.toUpperCase() : value;

      case "trim":
        return typeof value === "string" ? value.trim() : value;

      default: {
        const _exhaustive: never = transform;
        return value;
      }
    }
  }

  // Transformation objet (default)
  if (transform.type === "default") {
    return value;
  }

  return value;
}

/**
 * Applique la chaîne complète de transformations d'un FieldDef sur une valeur brute.
 *
 * @param value — valeur brute issue de l'API
 * @param field — définition du champ (contient transforms[])
 * @returns valeur normalisée
 *
 * @example
 *   applyFieldTransforms("2024-03-15", { transforms: ["parse_date_iso", "format_date_fr"], ... })
 *   → "15 mars 2024"
 */
export function applyFieldTransforms(value: unknown, field: FieldDef): unknown {
  if (!field.transforms || field.transforms.length === 0) return value;
  let result = value;
  for (const t of field.transforms) {
    result = applyTransform(result, t);
  }
  return result;
}

// ==========================================================================
// Transformation d'un enregistrement complet (feature)
// ==========================================================================

/**
 * Transforme un enregistrement brut (objet clé/valeur) selon les FieldDef.
 *
 * - Ne retient que les champs déclarés dans `fields`
 * - Applique les transformations de chaque champ
 * - Renomme les clés techniques en labels français (optionnel)
 *
 * @param raw    — enregistrement brut (attributs de la feature)
 * @param fields — définitions des champs attendus
 * @param options.useLabels — si true, utilise field.label comme clé (pour affichage)
 * @returns enregistrement normalisé
 *
 * @example
 *   transformFeature(
 *     { typezone: "U", libelle: "Zone urbaine", superficie: 12345.678 },
 *     [
 *       { key: "typezone", label: "Type", type: "enum", primary: true, ... },
 *       { key: "libelle", label: "Libellé", type: "string", primary: true, ... },
 *       { key: "superficie", label: "Surface", type: "number", unit: "m²",
 *         transforms: ["round_2"], primary: false, ... },
 *     ]
 *   )
 *   → { typezone: "U", libelle: "Zone urbaine", superficie: 12345.68 }
 */
export function transformFeature(
  raw: Record<string, unknown>,
  fields: FieldDef[],
  options?: { useLabels?: boolean },
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const field of fields) {
    const rawValue = raw[field.key];
    const transformed = applyFieldTransforms(rawValue, field);
    const key = options?.useLabels ? field.label : field.key;
    result[key] = transformed;
  }

  return result;
}

/**
 * Transforme un tableau d'enregistrements bruts.
 */
export function transformFeatures(
  rawFeatures: Record<string, unknown>[],
  fields: FieldDef[],
  options?: { useLabels?: boolean },
): Record<string, unknown>[] {
  return rawFeatures.map((f) => transformFeature(f, fields, options));
}

// ==========================================================================
// Extraction des champs prioritaires (résumé LLM)
// ==========================================================================

/**
 * Extrait les champs marqués `primary: true` d'un enregistrement transformé.
 *
 * Utilisé pour construire le résumé envoyé au LLM — seulement les champs
 * essentiels, pas la totalité des 400 attributs BDNB.
 *
 * @param feature — enregistrement déjà transformé
 * @param fields  — définitions des champs
 * @returns sous-ensemble avec uniquement les champs primary
 */
export function extractPrimaryFields(
  feature: Record<string, unknown>,
  fields: FieldDef[],
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    if (field.primary) {
      result[field.key] = feature[field.key];
    }
  }
  return result;
}

// ==========================================================================
// Formatage d'affichage
// ==========================================================================

/**
 * Formate une valeur pour affichage avec son unité.
 *
 * @param value — valeur transformée
 * @param field — définition du champ (pour unit, enumValues, type)
 * @returns chaîne formatée prête à afficher
 *
 * @example
 *   formatFieldValue(12345.68, { unit: "m²", type: "number", ... })  → "12 345,68 m²"
 *   formatFieldValue("U", { type: "enum", enumValues: { U: "Urbaine" }, ... }) → "Urbaine"
 *   formatFieldValue(new Date("2024-03-15"), { type: "date", ... })  → "15 mars 2024"
 */
export function formatFieldValue(value: unknown, field: FieldDef): string {
  if (value === null || value === undefined) return "—";

  // Enum : résoudre le label
  if (field.type === "enum" && field.enumValues && typeof value === "string") {
    return field.enumValues[value] ?? value;
  }

  // Date : formater en français
  if (field.type === "date" && value instanceof Date) {
    return formatDateFr(value) as string;
  }

  // Nombre : formater avec séparateur de milliers et unité
  if (field.type === "number" && typeof value === "number") {
    const formatted = formatNumber(value);
    return field.unit ? `${formatted} ${field.unit}` : formatted;
  }

  // Boolean
  if (field.type === "boolean") {
    return value ? "Oui" : "Non";
  }

  // Défaut : conversion en string
  return String(value);
}

/**
 * Formate un enregistrement complet en texte lisible (pour le LLM).
 *
 * @param feature — enregistrement transformé
 * @param fields  — définitions des champs
 * @param options.primaryOnly — ne formater que les champs primary
 * @returns lignes "Label : valeur formatée"
 */
export function formatFeatureAsText(
  feature: Record<string, unknown>,
  fields: FieldDef[],
  options?: { primaryOnly?: boolean },
): string {
  const lines: string[] = [];

  for (const field of fields) {
    if (options?.primaryOnly && !field.primary) continue;
    if (field.type === "geometry") continue; // pas de géométrie en texte

    const value = feature[field.key];
    const formatted = formatFieldValue(value, field);
    lines.push(`${field.label} : ${formatted}`);
  }

  return lines.join("\n");
}

// ==========================================================================
// Parseurs de dates
// ==========================================================================

/**
 * Parse une date au format ISO (YYYY-MM-DD ou YYYY-MM-DDTHH:mm:ss).
 * Retourne un objet Date, ou la valeur originale si le parsing échoue.
 */
function parseDateIso(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const date = new Date(value);
  return isNaN(date.getTime()) ? value : date;
}

/**
 * Parse une date au format français (DD/MM/YYYY).
 * Retourne un objet Date, ou la valeur originale si le parsing échoue.
 */
function parseDateFr(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!match) return value;
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  return isNaN(date.getTime()) ? value : date;
}

/**
 * Formate une Date en français : "15 mars 2024".
 * Si la valeur n'est pas une Date, retourne la valeur en string.
 */
function formatDateFr(value: unknown): unknown {
  if (value instanceof Date) {
    return value.toLocaleDateString("fr-FR", {
      day: "numeric",
      month: "long",
      year: "numeric",
    });
  }
  if (typeof value === "string") {
    // Essayer de parser comme ISO d'abord
    const date = new Date(value);
    if (!isNaN(date.getTime())) {
      return date.toLocaleDateString("fr-FR", {
        day: "numeric",
        month: "long",
        year: "numeric",
      });
    }
  }
  return value;
}

// ==========================================================================
// Formatage numérique
// ==========================================================================

/**
 * Formate un nombre avec séparateurs de milliers français.
 *
 * @example
 *   formatNumber(12345.678)  → "12 345,68"
 *   formatNumber(1000000)    → "1 000 000"
 *   formatNumber(0.5)        → "0,5"
 */
function formatNumber(value: number): string {
  return value.toLocaleString("fr-FR", {
    maximumFractionDigits: 2,
  });
}
