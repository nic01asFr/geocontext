/**
 * Tests de résolution de territoire (navigate.ts).
 *
 * Tests unitaires (parsing de cible) + tests d'intégration (appels réseau).
 * Les tests d'intégration appellent les vraies APIs Géoplateforme
 * et nécessitent un accès réseau.
 */

import { describe, test, expect } from "@jest/globals";
import { resolveTerritory } from "../../src/session/navigate";
import { createEmptyContext } from "../../src/session/types";
import type { NavigationContext } from "../../src/session/types";

const emptyCtx: NavigationContext = createEmptyContext();

// ==========================================================================
// Tests d'intégration — appels réseau réels (60s timeout)
// ==========================================================================

describe("resolveTerritory — intégration réseau", () => {
  // ------------------------------------------------------------------
  // Code INSEE commune
  // ------------------------------------------------------------------

  test("code INSEE commune 25349 → Loray", async () => {
    const result = await resolveTerritory("25349", emptyCtx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.level).toBe("commune");
    expect(result.code).toBe("25349");
    expect(result.name).toMatch(/Loray/i);
    expect(result.bbox).not.toBeNull();
    expect(result.bbox!.length).toBe(4);

    // Hiérarchie complète
    expect(result.hierarchy.commune?.code).toBe("25349");
    expect(result.hierarchy.departement?.code).toBe("25");
    expect(result.hierarchy.region?.code).toBe("27");
    expect(result.hierarchy.epci).toBeDefined();
    expect(result.hierarchy.epci?.siren).toBeTruthy();
  }, 60000);

  test("code INSEE commune 75056 → Paris", async () => {
    const result = await resolveTerritory("75056", emptyCtx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.level).toBe("commune");
    expect(result.code).toBe("75056");
    expect(result.name).toMatch(/Paris/i);
    expect(result.hierarchy.departement?.code).toBe("75");
  }, 60000);

  // ------------------------------------------------------------------
  // Département
  // ------------------------------------------------------------------

  test("code département 25 → Doubs", async () => {
    const result = await resolveTerritory("25", emptyCtx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.level).toBe("departement");
    expect(result.code).toBe("25");
    expect(result.name).toMatch(/Doubs/i);
    expect(result.bbox).not.toBeNull();
    expect(result.hierarchy.departement?.code).toBe("25");
    // Région parente résolue
    expect(result.hierarchy.region).toBeDefined();
    expect(result.hierarchy.region?.code).toBe("27");
  }, 60000);

  test("code département 2A → Corse-du-Sud", async () => {
    const result = await resolveTerritory("2A", emptyCtx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.level).toBe("departement");
    expect(result.code).toBe("2A");
    expect(result.name).toMatch(/Corse/i);
  }, 60000);

  // ------------------------------------------------------------------
  // Texte libre → geocodage
  // ------------------------------------------------------------------

  test("texte 'Loray' → commune", async () => {
    const result = await resolveTerritory("Loray", emptyCtx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.level).toBe("commune");
    // Le geocodage renvoie Loray ou une commune proche
    expect(result.hierarchy.commune).toBeDefined();
  }, 60000);

  test("texte 'Marseille' → commune", async () => {
    const result = await resolveTerritory("Marseille", emptyCtx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.level).toBe("commune");
    expect(result.name).toMatch(/Marseille/i);
  }, 60000);

  // ------------------------------------------------------------------
  // Coordonnées lon,lat
  // ------------------------------------------------------------------

  test("coordonnées '6.497,47.153' → commune autour de Loray", async () => {
    const result = await resolveTerritory("6.497,47.153", emptyCtx);
    expect(result.success).toBe(true);
    if (!result.success) return;

    expect(result.level).toBe("commune");
    expect(result.hierarchy.commune).toBeDefined();
    expect(result.hierarchy.departement?.code).toBe("25");
  }, 60000);

  // ------------------------------------------------------------------
  // Cas d'erreur
  // ------------------------------------------------------------------

  test("cible vide → erreur", async () => {
    const result = await resolveTerritory("", emptyCtx);
    expect(result.success).toBe(false);
    if (result.success) return;
    expect(result.error).toBeTruthy();
  });

  test("code INSEE inexistant → erreur", async () => {
    const result = await resolveTerritory("99999", emptyCtx);
    expect(result.success).toBe(false);
  }, 60000);
});
