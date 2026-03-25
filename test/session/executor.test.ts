/**
 * Tests de l'executor (executeSource / executeSources).
 *
 * Tests unitaires avec mock HTTP (pas d'appels réseau).
 * Vérifie :
 *   - La construction des URL WFS et REST
 *   - Les transformations de champs
 *   - Les layerSpecs pour fetch direct frontend
 *   - La gestion des erreurs et timeouts
 *   - Les filtres utilisateur
 */

import { describe, test, expect, jest, beforeEach, afterEach } from "@jest/globals";
import { executeSource, executeSources } from "../../src/session/executors/executor";
import type { SourceDef } from "../../src/session/registry/types";
import { createEmptyContext } from "../../src/session/types";
import type { NavigationContext } from "../../src/session/types";

// ==========================================================================
// Mock global fetch
// ==========================================================================

const originalFetch = globalThis.fetch;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let mockFetch: any;

beforeEach(() => {
  mockFetch = jest.fn();
  (globalThis as any).fetch = mockFetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ==========================================================================
// Helpers
// ==========================================================================

/** Crée un contexte avec commune Loray */
function ctxLoray(): NavigationContext {
  const ctx = createEmptyContext();
  ctx.level = "commune";
  ctx.code = "25349";
  ctx.name = "Loray";
  ctx.bbox = [6.45, 47.12, 6.55, 47.18];
  ctx.hierarchy = {
    commune: { code: "25349", name: "Loray" },
    departement: { code: "25", name: "Doubs" },
    region: { code: "27", name: "Bourgogne-Franche-Comté" },
  };
  return ctx;
}

/** Simule une réponse fetch JSON */
function mockJsonResponse(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    json: async () => data,
    headers: new Headers(),
  } as unknown as Response;
}

/** Réponse WFS GeoJSON type */
function wfsResponse(features: unknown[] = [], numberMatched?: number) {
  return mockJsonResponse({
    type: "FeatureCollection",
    numberMatched: numberMatched ?? features.length,
    features: features.map((f: any, i) => ({
      type: "Feature",
      id: i,
      geometry: f._geometry ?? { type: "Point", coordinates: [6.5, 47.15] },
      properties: Object.fromEntries(
        Object.entries(f).filter(([k]) => k !== "_geometry"),
      ),
    })),
  });
}

// ==========================================================================
// Tests
// ==========================================================================

describe("executeSource — WFS", () => {
  test("construit l'URL WFS correcte et retourne les features", async () => {
    const source: SourceDef = {
      id: "test_source",
      label: "Test source",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "TEST:layer",
      levels: ["commune"],
      theme: "identite" as any,
      action: "test",
      pivot: {
        strategy: "attribute",
        from: "context.code",
        attribute: "code_insee",
      },
      fields: [
        { key: "nom", label: "Nom", type: "string" },
        { key: "population", label: "Population", type: "number" },
      ],
      priority: "required",
    };

    mockFetch.mockResolvedValueOnce(
      wfsResponse([
        { nom: "Loray", population: 450 },
      ]),
    );

    const result = await executeSource(source, ctxLoray());

    expect(result.success).toBe(true);
    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toMatchObject({ nom: "Loray", population: 450 });

    // Vérifier l'URL construite
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain("typeName=TEST%3Alayer");
    expect(callUrl).toContain("CQL_FILTER=code_insee");
    expect(callUrl).toContain("25349");
    expect(callUrl).toContain("srsName=EPSG%3A4326");
  });

  test("inclut un layerSpec quand la source a des géométries", async () => {
    const source: SourceDef = {
      id: "geo_source",
      label: "Geo source",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "TEST:polygons",
      levels: ["commune"],
      theme: "urbanisme" as any,
      action: "zonages",
      pivot: {
        strategy: "attribute",
        from: "context.code",
        attribute: "code_insee",
      },
      fields: [
        { key: "type_zone", label: "Type", type: "string" },
        { key: "the_geom", label: "Géométrie", type: "geometry" },
      ],
      priority: "required",
      displayStyle: { color: "#ff0000", opacity: 0.3 },
    };

    mockFetch.mockResolvedValueOnce(
      wfsResponse([
        {
          type_zone: "U",
          _geometry: {
            type: "Polygon",
            coordinates: [[[6.45, 47.12], [6.55, 47.12], [6.55, 47.18], [6.45, 47.18], [6.45, 47.12]]],
          },
        },
      ]),
    );

    const result = await executeSource(source, ctxLoray());

    expect(result.success).toBe(true);
    expect(result.layerSpec).toBeDefined();
    expect(result.layerSpec!.wfsUrl).toBeTruthy();
    expect(result.layerSpec!.typename).toBe("TEST:polygons");
    expect(result.layerSpec!.cqlFilter).toContain("25349");
    expect(result.layerSpec!.srsName).toBe("EPSG:4326");
    expect(result.layerSpec!.style?.color).toBe("#ff0000");

    // Pas de geojson brut (évite de surcharger le transport MCP)
    expect(result.geojson).toBeUndefined();
  });

  test("retourne success=false sur erreur HTTP", async () => {
    const source: SourceDef = {
      id: "fail_source",
      label: "Fail",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "TEST:fail",
      levels: ["commune"],
      theme: "identite" as any,
      action: "test",
      pivot: {
        strategy: "attribute",
        from: "context.code",
        attribute: "code_insee",
      },
      fields: [],
      priority: "required",
    };

    mockFetch.mockResolvedValue(mockJsonResponse({}, 500));

    const result = await executeSource(source, ctxLoray());

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.features).toEqual([]);
  });

  test("retourne erreur quand le contexte est insuffisant", async () => {
    const source: SourceDef = {
      id: "no_ctx_source",
      label: "No ctx",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "TEST:layer",
      levels: ["commune"],
      theme: "identite" as any,
      action: "test",
      pivot: {
        strategy: "attribute",
        from: "hierarchy.epci.siren",
        attribute: "siren_epci",
      },
      fields: [],
      priority: "required",
    };

    // Contexte sans EPCI
    const ctx = createEmptyContext();
    ctx.level = "commune";
    ctx.code = "25349";

    const result = await executeSource(source, ctx);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/insuffisant/i);
    // Pas d'appel réseau
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

describe("executeSources — parallèle", () => {
  test("exécute plusieurs sources en parallèle", async () => {
    const source1: SourceDef = {
      id: "s1", label: "S1", description: "", endpoint: "gpf_wfs" as any,
      typename: "T1", levels: ["commune"], theme: "identite" as any,
      action: "a", pivot: { strategy: "attribute", from: "context.code", attribute: "code_insee" },
      fields: [{ key: "x", label: "X", type: "string" }], priority: "required",
    };
    const source2: SourceDef = {
      id: "s2", label: "S2", description: "", endpoint: "gpf_wfs" as any,
      typename: "T2", levels: ["commune"], theme: "identite" as any,
      action: "b", pivot: { strategy: "attribute", from: "context.code", attribute: "code_insee" },
      fields: [{ key: "y", label: "Y", type: "number" }], priority: "optional",
    };

    mockFetch
      .mockResolvedValueOnce(wfsResponse([{ x: "hello" }]))
      .mockResolvedValueOnce(wfsResponse([{ y: 42 }]));

    const results = await executeSources([source1, source2], ctxLoray());

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[0].features[0]).toMatchObject({ x: "hello" });
    expect(results[1].success).toBe(true);
    expect(results[1].features[0]).toMatchObject({ y: 42 });
  });

  test("une source optionnelle qui échoue n'empêche pas les autres", async () => {
    const required: SourceDef = {
      id: "req", label: "Req", description: "", endpoint: "gpf_wfs" as any,
      typename: "T1", levels: ["commune"], theme: "identite" as any,
      action: "a", pivot: { strategy: "attribute", from: "context.code", attribute: "code_insee" },
      fields: [], priority: "required",
    };
    const optional: SourceDef = {
      id: "opt", label: "Opt", description: "", endpoint: "gpf_wfs" as any,
      typename: "T2", levels: ["commune"], theme: "identite" as any,
      action: "b", pivot: { strategy: "attribute", from: "context.code", attribute: "code_insee" },
      fields: [], priority: "optional",
    };

    // Le second mock doit rejeter à chaque tentative (retries)
    mockFetch.mockImplementation(async (url: string) => {
      if (url.includes("typeName=T1")) return wfsResponse([]);
      throw new Error("Network fail");
    });

    const results = await executeSources([required, optional], ctxLoray());

    expect(results).toHaveLength(2);
    expect(results[0].success).toBe(true);
    expect(results[1].success).toBe(false);
    expect(results[1].error).toMatch(/Network fail/);
  });
});
