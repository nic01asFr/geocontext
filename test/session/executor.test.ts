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

// ==========================================================================
// REST Executor
// ==========================================================================

describe("executeSource — REST", () => {
  test("construit l'URL REST avec paramètres de pivot", async () => {
    const source: SourceDef = {
      id: "rest_source",
      label: "REST test",
      description: "Test REST",
      endpoint: "dvf" as any,
      path: "/mutations",
      levels: ["commune"],
      theme: "economie" as any,
      action: "transactions",
      pivot: {
        strategy: "attribute",
        from: "context.code",
        attribute: "code_commune",
      },
      fields: [
        { key: "date_mutation", label: "Date", type: "string" },
        { key: "valeur_fonciere", label: "Valeur", type: "number" },
      ],
      priority: "required",
    };

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse({
        results: [
          { date_mutation: "2023-01-15", valeur_fonciere: 150000 },
          { date_mutation: "2023-03-20", valeur_fonciere: 85000 },
        ],
      }),
    );

    const result = await executeSource(source, ctxLoray());

    expect(result.success).toBe(true);
    expect(result.features).toHaveLength(2);
    expect(result.features[0]).toMatchObject({ date_mutation: "2023-01-15" });

    // Vérifier que l'URL contient le paramètre de pivot
    const callUrl = mockFetch.mock.calls[0][0] as string;
    expect(callUrl).toContain("code_commune=25349");
    // Pas de layerSpec pour REST (pas de géométries WFS)
    expect(result.layerSpec).toBeUndefined();
  });

  test("gère les réponses de type tableau direct", async () => {
    const source: SourceDef = {
      id: "rest_array",
      label: "Array REST",
      description: "Test",
      endpoint: "dvf" as any,
      levels: ["commune"],
      theme: "economie" as any,
      action: "test",
      pivot: {
        strategy: "attribute",
        from: "context.code",
        attribute: "code",
      },
      fields: [{ key: "nom", label: "Nom", type: "string" }],
      priority: "required",
    };

    mockFetch.mockResolvedValueOnce(
      mockJsonResponse([{ nom: "Item A" }, { nom: "Item B" }]),
    );

    const result = await executeSource(source, ctxLoray());
    expect(result.success).toBe(true);
    expect(result.features).toHaveLength(2);
  });
});

// ==========================================================================
// WFS — attribute_with_fallback pivot
// ==========================================================================

describe("executeSource — attribute_with_fallback", () => {
  test("utilise le primaire quand il retourne des résultats", async () => {
    const source: SourceDef = {
      id: "fallback_source",
      label: "Fallback test",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "URBANISME:zone_urba",
      levels: ["commune"],
      theme: "urbanisme" as any,
      action: "zonages",
      pivot: {
        strategy: "attribute_with_fallback",
        attribute: "partition",
        primary: { from: "context.code" },
        fallback: {
          from: ["hierarchy.epci.siren", "context.code"],
          separator: "_",
        },
        cacheKey: "_partition_urba",
      },
      fields: [{ key: "typezone", label: "Type", type: "string" }],
      priority: "required",
    };

    // Primaire retourne des résultats → pas de fallback
    mockFetch.mockResolvedValueOnce(
      wfsResponse([{ typezone: "U" }, { typezone: "N" }]),
    );

    const ctx = ctxLoray();
    ctx.hierarchy.epci = { code: "200023075", name: "CC Test", siren: "200023075" };

    const result = await executeSource(source, ctx);

    expect(result.success).toBe(true);
    expect(result.features).toHaveLength(2);
    // Un seul appel WFS (primaire suffisant)
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("partition");
    expect(url).toContain("25349");
  });

  test("bascule sur le fallback quand le primaire retourne 0 résultats", async () => {
    const source: SourceDef = {
      id: "fallback_source2",
      label: "Fallback test 2",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "URBANISME:zone_urba",
      levels: ["commune"],
      theme: "urbanisme" as any,
      action: "zonages",
      pivot: {
        strategy: "attribute_with_fallback",
        attribute: "partition",
        primary: { from: "context.code" },
        fallback: {
          from: ["hierarchy.epci.siren", "context.code"],
          separator: "_",
        },
        cacheKey: "_partition_urba",
      },
      fields: [{ key: "typezone", label: "Type", type: "string" }],
      priority: "required",
    };

    // Primaire vide → fallback avec résultats
    mockFetch
      .mockResolvedValueOnce(wfsResponse([]))        // primaire vide
      .mockResolvedValueOnce(wfsResponse([{ typezone: "AU" }])); // fallback

    const ctx = ctxLoray();
    ctx.hierarchy.epci = { code: "200023075", name: "CC Test", siren: "200023075" };

    const result = await executeSource(source, ctx);

    expect(result.success).toBe(true);
    expect(result.features).toHaveLength(1);
    expect(result.features[0]).toMatchObject({ typezone: "AU" });
    // Deux appels : primaire + fallback
    expect(mockFetch).toHaveBeenCalledTimes(2);
    const fallbackUrl = mockFetch.mock.calls[1][0] as string;
    expect(fallbackUrl).toContain("200023075_25349");
  });
});

// ==========================================================================
// WFS — spatial pivot
// ==========================================================================

describe("executeSource — spatial pivot", () => {
  test("construit un filtre BBOX pour le pivot spatial", async () => {
    const source: SourceDef = {
      id: "spatial_source",
      label: "Spatial test",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "ENVIRO:layer",
      levels: ["commune"],
      theme: "environnement" as any,
      action: "test",
      pivot: {
        strategy: "spatial",
        spatialOp: "bbox",
        from: "context.bbox",
      },
      fields: [{ key: "nom", label: "Nom", type: "string" }],
      priority: "required",
    };

    mockFetch.mockResolvedValueOnce(
      wfsResponse([{ nom: "Zone A" }]),
    );

    const result = await executeSource(source, ctxLoray());

    expect(result.success).toBe(true);
    expect(result.features).toHaveLength(1);
    // L'URL doit contenir un filtre spatial BBOX
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("BBOX");
  });

  test("retourne erreur quand la bbox manque", async () => {
    const source: SourceDef = {
      id: "spatial_no_bbox",
      label: "Spatial no bbox",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "ENVIRO:layer",
      levels: ["commune"],
      theme: "environnement" as any,
      action: "test",
      pivot: {
        strategy: "spatial",
        spatialOp: "bbox",
        from: "context.bbox",
      },
      fields: [],
      priority: "required",
    };

    const ctx = createEmptyContext();
    ctx.level = "commune";
    ctx.code = "25349";
    // Pas de bbox

    const result = await executeSource(source, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/manquante/i);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ==========================================================================
// WFS — user filters
// ==========================================================================

describe("executeSource — user filters", () => {
  test("combine le pivot et les filtres utilisateur dans le CQL", async () => {
    const source: SourceDef = {
      id: "filtered_source",
      label: "Filtered test",
      description: "Test",
      endpoint: "gpf_wfs" as any,
      typename: "URBANISME:zone_urba",
      levels: ["commune"],
      theme: "urbanisme" as any,
      action: "zonages",
      pivot: {
        strategy: "attribute",
        from: "context.code",
        attribute: "code_insee",
      },
      fields: [{ key: "typezone", label: "Type", type: "string" }],
      userFilters: [
        {
          key: "type_zone",
          label: "Type de zone",
          type: "enum",
          values: { U: "Urbain", AU: "À Urbaniser", A: "Agricole", N: "Naturel" },
          toCql: "typezone = '{value}'",
        },
      ],
      priority: "required",
    };

    mockFetch.mockResolvedValueOnce(wfsResponse([{ typezone: "U" }]));

    const result = await executeSource(
      source,
      ctxLoray(),
      { type_zone: "U" },
    );

    expect(result.success).toBe(true);
    // Le CQL_FILTER doit contenir à la fois le pivot ET le filtre utilisateur
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain("code_insee");
    expect(url).toContain("25349");
    expect(url).toContain("typezone");
  });
});
