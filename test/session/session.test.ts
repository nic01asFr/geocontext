/**
 * Tests de GeoContextSession — cycle de navigation complet.
 *
 * Teste le cycle navigate → action → back avec un mock du Server MCP.
 * Les handlers appellent les vraies APIs Géoplateforme (réseau requis).
 */

import { describe, test, expect, beforeEach } from "@jest/globals";
import { GeoContextSession } from "../../src/session/session";

// ==========================================================================
// Mock du Server MCP (on n'a besoin que de sendToolListChanged)
// ==========================================================================

function createMockServer(): any {
  return {
    sendToolListChanged: async () => {},
  };
}

// ==========================================================================
// Tests
// ==========================================================================

describe("GeoContextSession", () => {
  let session: GeoContextSession;

  beforeEach(() => {
    session = new GeoContextSession(createMockServer());
  });

  // ------------------------------------------------------------------
  // getTools — contexte vide
  // ------------------------------------------------------------------

  describe("getTools — contexte vide", () => {
    test("retourne 7 tools de base", () => {
      const tools = session.getTools();
      expect(tools.length).toBe(7);
      const names = tools.map((t) => t.name);
      expect(names).toContain("navigate");
      expect(names).toContain("search");
      expect(names).toContain("back");
    });

    test("navigate a un inputSchema avec target requis", () => {
      const tools = session.getTools();
      const nav = tools.find((t) => t.name === "navigate")!;
      expect(nav.inputSchema.properties).toHaveProperty("target");
      expect(nav.inputSchema.required).toContain("target");
    });
  });

  // ------------------------------------------------------------------
  // handleToolCall — navigate
  // ------------------------------------------------------------------

  describe("navigate vers commune", () => {
    test("navigate('25349') → commune Loray + 7 tools", async () => {
      const result = await session.handleToolCall("navigate", { target: "25349" });

      // Résultat textuel
      expect(result.content).toBeDefined();
      expect(result.content.length).toBeGreaterThan(0);
      const text = (result.content[0] as any).text;
      expect(text).toMatch(/Loray/i);
      expect(text).toMatch(/commune/i);

      // Contexte mis à jour
      const ctx = session.getContext();
      expect(ctx.level).toBe("commune");
      expect(ctx.code).toBe("25349");
      expect(ctx.name).toMatch(/Loray/i);
      expect(ctx.hierarchy.departement?.code).toBe("25");

      // Tools dynamiques : navigate, search, back, action, map, select, compare
      const tools = session.getTools();
      expect(tools.length).toBe(7);
      const names = tools.map((t) => t.name);
      expect(names).toContain("action");
    }, 60000);

    test("navigate vers texte 'Marseille' → résolution commune", async () => {
      const result = await session.handleToolCall("navigate", { target: "Marseille" });

      const text = (result.content[0] as any).text;
      expect(text).toMatch(/Marseille/i);

      const ctx = session.getContext();
      expect(ctx.level).toBe("commune");
    }, 60000);

    test("navigate avec cible vide → erreur", async () => {
      const result = await session.handleToolCall("navigate", { target: "" });
      const text = (result.content[0] as any).text;
      expect(text).toMatch(/cible/i);
    });
  });

  // ------------------------------------------------------------------
  // handleToolCall — action (thème)
  // ------------------------------------------------------------------

  describe("action — sélection de thème", () => {
    test("action('identite') après navigate → charge les données", async () => {
      // D'abord naviguer
      await session.handleToolCall("navigate", { target: "25349" });

      // Puis sélectionner un thème
      const result = await session.handleToolCall("action", { action: "identite" });
      const text = (result.content[0] as any).text;
      // Doit retourner des données
      expect(text.length).toBeGreaterThan(0);

      // Contexte : thème actif
      const ctx = session.getContext();
      expect(ctx.theme).toBe("identite");
      expect(ctx.data).toHaveProperty("identite");
    }, 60000);

    test("action sans territoire → erreur", async () => {
      const result = await session.handleToolCall("action", { action: "urbanisme" });
      const text = (result.content[0] as any).text;
      expect(text).toMatch(/territoire/i);
    });
  });

  // ------------------------------------------------------------------
  // handleToolCall — action (tool polymorphe : enums changent)
  // ------------------------------------------------------------------

  describe("action tool — polymorphisme", () => {
    test("buildActionTool sans thème → enums = thèmes", async () => {
      await session.handleToolCall("navigate", { target: "25349" });

      const tools = session.getTools();
      const actionTool = tools.find((t) => t.name === "action")!;

      // Enums = thèmes disponibles pour commune
      const enums = (actionTool.inputSchema.properties as any).action.enum;
      expect(enums).toContain("urbanisme");
      expect(enums).toContain("cadastre");
      expect(enums).toContain("identite");

      // Description mentionne le nom du territoire
      expect(actionTool.description).toMatch(/Loray/i);
    }, 60000);

    test("buildActionTool avec thème → enums = actions", async () => {
      await session.handleToolCall("navigate", { target: "25349" });
      await session.handleToolCall("action", { action: "urbanisme" });

      const tools = session.getTools();
      const actionTool = tools.find((t) => t.name === "action")!;

      // Enums = actions urbanisme
      const enums = (actionTool.inputSchema.properties as any).action.enum;
      expect(enums).toContain("zonages");
      expect(enums).toContain("prescriptions");

      // Description mentionne urbanisme
      expect(actionTool.description).toMatch(/urbanisme/i);
    }, 60000);
  });

  // ------------------------------------------------------------------
  // handleToolCall — back
  // ------------------------------------------------------------------

  describe("back — retour en arrière", () => {
    test("back sans historique → message début", async () => {
      const result = await session.handleToolCall("back", {});
      const text = (result.content[0] as any).text;
      expect(text).toMatch(/début/i);
    });

    test("navigate → action → back → retour état initial", async () => {
      // Navigate push le contexte vide dans l'historique puis met à jour ctx
      await session.handleToolCall("navigate", { target: "25349" });
      await session.handleToolCall("action", { action: "identite" });
      expect(session.getContext().theme).toBe("identite");

      // Back dépile le snapshot pré-navigate (état vide)
      await session.handleToolCall("back", {});

      const ctx = session.getContext();
      // On est revenu au contexte avant navigate
      expect(ctx.level).toBeNull();
    }, 60000);

    test("navigate A → navigate B → back → retour à A", async () => {
      await session.handleToolCall("navigate", { target: "25349" });
      const ctxA = { ...session.getContext() };

      await session.handleToolCall("navigate", { target: "75056" });
      expect(session.getContext().code).toBe("75056");

      await session.handleToolCall("back", {});
      const restored = session.getContext();
      expect(restored.code).toBe(ctxA.code);
      expect(restored.name).toBe(ctxA.name);
    }, 60000);
  });

  // ------------------------------------------------------------------
  // handleToolCall — tool inconnu
  // ------------------------------------------------------------------

  test("tool inconnu → erreur", async () => {
    const result = await session.handleToolCall("inexistant", {});
    const text = (result.content[0] as any).text;
    expect(text).toMatch(/inconnu/i);
  });

  // ------------------------------------------------------------------
  // Contexte initial
  // ------------------------------------------------------------------

  test("contexte initial est vide", () => {
    const ctx = session.getContext();
    expect(ctx.level).toBeNull();
    expect(ctx.code).toBeNull();
    expect(ctx.theme).toBeNull();
    expect(ctx.layers).toEqual([]);
    expect(ctx.history).toEqual([]);
  });
});
