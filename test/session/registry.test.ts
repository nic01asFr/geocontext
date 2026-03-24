/**
 * Tests du registre de données.
 *
 * Vérifie :
 * - La validation au boot (pas de source mal configurée)
 * - Les lookups par (level, theme, action)
 * - La cohérence thèmes ↔ THEMES_BY_LEVEL
 * - Les fonctions pivot, fields, filters
 * - Le UI tree builder
 */

import { describe, test, expect } from "@jest/globals";
import { Registry, registry } from "../../src/session/registry/registry";
import { ENDPOINTS } from "../../src/session/registry/endpoints";
import { buildRegistryKey } from "../../src/session/registry/types";
import { THEMES_BY_LEVEL, TERRITORY_LEVELS, createEmptyContext } from "../../src/session/types";
import type { NavigationContext } from "../../src/session/types";
import {
  extractPivotValue,
  buildAttributeCql,
  escapeCql,
  geojsonToWkt,
} from "../../src/session/registry/pivot";
import {
  applyFieldTransforms,
  transformFeature,
  formatFieldValue,
} from "../../src/session/registry/fields";
import { userFilterToCql, combineUserFiltersCql } from "../../src/session/registry/filters";
import { buildUITree, buildActionDescription, buildActionEnums } from "../../src/session/registry/tree";
import type { FieldDef, UserFilterDef } from "../../src/session/registry/types";

// ==========================================================================
// Registry — validation & lookups
// ==========================================================================

describe("Registry", () => {
  test("singleton se construit sans erreur", () => {
    expect(registry).toBeInstanceOf(Registry);
    expect(registry.size).toBeGreaterThan(40);
    expect(registry.indexSize).toBeGreaterThan(50);
  });

  test("chaque source référence un endpoint existant", () => {
    for (const source of registry.getAllSources()) {
      expect(ENDPOINTS.has(source.endpoint)).toBe(true);
    }
  });

  test("les IDs de source sont uniques", () => {
    const ids = registry.getAllSources().map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("chaque niveau a au moins le thème identite", () => {
    for (const level of TERRITORY_LEVELS) {
      const themes = registry.getThemes(level);
      expect(themes).toContain("identite");
    }
  });

  test("commune a tous les thèmes attendus", () => {
    const themes = registry.getThemes("commune");
    expect(themes).toContain("urbanisme");
    expect(themes).toContain("cadastre");
    expect(themes).toContain("risques");
    expect(themes).toContain("environnement");
    expect(themes).toContain("economie");
    expect(themes).toContain("bati");
  });

  test("getSources retourne les bonnes sources", () => {
    const zonages = registry.getSources("commune", "urbanisme", "zonages");
    expect(zonages.length).toBeGreaterThanOrEqual(1);
    expect(zonages[0].id).toBe("urba_zonages");

    const dpe = registry.getSources("batiment", "energie", "dpe");
    expect(dpe.length).toBeGreaterThanOrEqual(1);
    expect(dpe[0].id).toBe("energie_dpe_bdnb");
  });

  test("getActions retourne les actions urbanisme", () => {
    const actions = registry.getActions("commune", "urbanisme");
    expect(actions).toContain("document");
    expect(actions).toContain("zonages");
    expect(actions).toContain("prescriptions");
    expect(actions).toContain("servitudes");
  });

  test("getSource par ID fonctionne", () => {
    const source = registry.getSource("ae_commune");
    expect(source.label).toBe("Identité commune");
  });

  test("getSource avec ID inconnu throw", () => {
    expect(() => registry.getSource("inexistant")).toThrow();
  });

  test("findSource retourne null pour ID inconnu", () => {
    expect(registry.findSource("inexistant")).toBeNull();
  });

  test("getActionDefs retourne labels et descriptions", () => {
    const defs = registry.getActionDefs("commune", "urbanisme");
    expect(defs.length).toBeGreaterThanOrEqual(4);
    const doc = defs.find((d) => d.id === "document");
    expect(doc).toBeDefined();
    expect(doc!.label).toContain("Document");
    expect(doc!.description).toBeTruthy();
  });

  test("thèmes commune cohérents avec THEMES_BY_LEVEL", () => {
    const registryThemes = registry.getThemes("commune");
    const modelThemes = THEMES_BY_LEVEL["commune"];
    for (const t of registryThemes) {
      expect(modelThemes).toContain(t);
    }
  });
});

// ==========================================================================
// Endpoints
// ==========================================================================

describe("Endpoints", () => {
  test("16 endpoints définis", () => {
    expect(ENDPOINTS.size).toBe(16);
  });

  test("chaque endpoint a une URL et un protocole", () => {
    for (const [, ep] of ENDPOINTS) {
      expect(ep.baseUrl).toMatch(/^https?:\/\//);
      expect(["wfs", "rest_json", "rest_geojson", "geocodage"]).toContain(ep.protocol);
    }
  });

  test("endpoints WFS ont une version", () => {
    for (const [, ep] of ENDPOINTS) {
      if (ep.protocol === "wfs") {
        expect(ep.wfsVersion).toBeDefined();
      }
    }
  });
});

// ==========================================================================
// Pivot
// ==========================================================================

describe("Pivot", () => {
  const ctx: NavigationContext = {
    ...createEmptyContext(),
    level: "commune",
    code: "25349",
    name: "Loray",
    bbox: [6.48, 47.15, 6.55, 47.19],
    hierarchy: {
      commune: { code: "25349", name: "Loray" },
      departement: { code: "25", name: "Doubs" },
      region: { code: "27", name: "Bourgogne-Franche-Comté" },
      epci: { code: "200067874", name: "CC du Plateau de Russey", siren: "200067874" },
    },
  };

  test("extractPivotValue — context.code", () => {
    expect(extractPivotValue(ctx, "context.code")).toBe("25349");
  });

  test("extractPivotValue — hierarchy.epci.siren", () => {
    expect(extractPivotValue(ctx, "hierarchy.epci.siren")).toBe("200067874");
  });

  test("extractPivotValue — hierarchy inexistant", () => {
    expect(extractPivotValue(ctx, "hierarchy.batiment.id")).toBeNull();
  });

  test("buildAttributeCql", () => {
    const result = buildAttributeCql(ctx, {
      strategy: "attribute",
      attribute: "code_insee",
      from: "context.code",
    });
    expect(result).not.toBeNull();
    expect(result!.cql).toBe("code_insee = '25349'");
  });

  test("escapeCql protège les quotes", () => {
    expect(escapeCql("l'Isle")).toBe("l''Isle");
  });

  test("geojsonToWkt — Point", () => {
    const wkt = geojsonToWkt({ type: "Point", coordinates: [6.5, 47.17] });
    expect(wkt).toBe("POINT(6.5 47.17)");
  });

  test("geojsonToWkt — Polygon", () => {
    const wkt = geojsonToWkt({
      type: "Polygon",
      coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
    });
    expect(wkt).toBe("POLYGON((0 0, 1 0, 1 1, 0 1, 0 0))");
  });
});

// ==========================================================================
// Fields
// ==========================================================================

describe("Fields", () => {
  const dateField: FieldDef = {
    key: "datappro",
    label: "Date d'approbation",
    type: "date",
    transforms: ["parse_date_iso", "format_date_fr"],
  };

  const numberField: FieldDef = {
    key: "superficie",
    label: "Superficie",
    type: "number",
    unit: "ha",
    transforms: ["m2_to_ha"],
    primary: true,
  };

  const enumField: FieldDef = {
    key: "typezone",
    label: "Type de zone",
    type: "enum",
    enumValues: { U: "Urbaine", AU: "À Urbaniser", A: "Agricole", N: "Naturelle" },
    primary: true,
  };

  test("parse_date_iso + format_date_fr", () => {
    const result = applyFieldTransforms("2024-03-15", dateField);
    expect(typeof result).toBe("string");
    expect(result).toMatch(/15.*mars.*2024/);
  });

  test("m2_to_ha conversion", () => {
    const result = applyFieldTransforms(125000, numberField);
    expect(result).toBe(12.5);
  });

  test("transformFeature", () => {
    const raw = { typezone: "U", libelle: "Centre-ville", superficie: 50000 };
    const fields: FieldDef[] = [enumField, { key: "libelle", label: "Libellé", type: "string", primary: true }, numberField];
    const result = transformFeature(raw, fields);
    expect(result.typezone).toBe("U");
    expect(result.libelle).toBe("Centre-ville");
    expect(result.superficie).toBe(5);
  });

  test("formatFieldValue — enum", () => {
    expect(formatFieldValue("U", enumField)).toBe("Urbaine");
    expect(formatFieldValue("N", enumField)).toBe("Naturelle");
  });

  test("formatFieldValue — number avec unité", () => {
    const result = formatFieldValue(1250.5, numberField);
    expect(result).toContain("ha");
  });

  test("formatFieldValue — null", () => {
    expect(formatFieldValue(null, enumField)).toBe("—");
  });
});

// ==========================================================================
// Filters
// ==========================================================================

describe("Filters", () => {
  const enumFilter: UserFilterDef = {
    key: "type_zone",
    label: "Type de zone",
    type: "enum",
    toCql: "typezone = '{value}'",
  };

  const dateFilter: UserFilterDef = {
    key: "period",
    label: "Période",
    type: "date_range",
    toCql: "date_mutation",
  };

  const numFilter: UserFilterDef = {
    key: "surface_min",
    label: "Surface min",
    type: "number_min",
    toCql: "superficie",
  };

  test("userFilterToCql — enum", () => {
    expect(userFilterToCql(enumFilter, "U")).toBe("typezone = 'U'");
  });

  test("userFilterToCql — date_range", () => {
    const result = userFilterToCql(dateFilter, { from: "2020-01-01", to: "2023-12-31" });
    expect(result).toContain("date_mutation >= '2020-01-01'");
    expect(result).toContain("date_mutation <= '2023-12-31'");
  });

  test("userFilterToCql — number_min", () => {
    expect(userFilterToCql(numFilter, 500)).toBe("superficie >= 500");
  });

  test("combineUserFiltersCql", () => {
    const result = combineUserFiltersCql(
      [enumFilter, numFilter],
      { type_zone: "U", surface_min: 500 },
    );
    expect(result).toBe("typezone = 'U' AND superficie >= 500");
  });
});

// ==========================================================================
// UI Tree
// ==========================================================================

describe("UI Tree", () => {
  const ctx: NavigationContext = {
    ...createEmptyContext(),
    level: "commune",
    code: "25349",
    name: "Loray",
    bbox: [6.48, 47.15, 6.55, 47.19],
    hierarchy: {
      commune: { code: "25349", name: "Loray" },
    },
  };

  test("buildUITree retourne des nœuds pour chaque thème", () => {
    const tree = buildUITree(ctx, registry);
    expect(tree.length).toBeGreaterThan(5);

    const ids = tree.map((n) => n.id);
    expect(ids).toContain("identite");
    expect(ids).toContain("urbanisme");
    expect(ids).toContain("risques");
  });

  test("nœud urbanisme a des children", () => {
    const tree = buildUITree(ctx, registry);
    const urba = tree.find((n) => n.id === "urbanisme");
    expect(urba).toBeDefined();
    expect(urba!.children).toBeDefined();
    expect(urba!.children!.length).toBeGreaterThanOrEqual(4);
  });

  test("buildUITree retourne vide sans territoire", () => {
    const empty = createEmptyContext();
    expect(buildUITree(empty, registry)).toEqual([]);
  });

  test("buildActionDescription sans thème → liste les thèmes", () => {
    const desc = buildActionDescription(ctx, registry);
    expect(desc).toContain("Loray");
    expect(desc).toContain("Urbanisme");
    expect(desc).toContain("Cadastre");
  });

  test("buildActionDescription avec thème → liste les actions", () => {
    const ctxWithTheme = { ...ctx, theme: "urbanisme" as const };
    const desc = buildActionDescription(ctxWithTheme, registry);
    expect(desc).toContain("urbanisme");
    expect(desc).toContain("Zonages");
  });

  test("buildActionEnums sans thème → thèmes", () => {
    const enums = buildActionEnums(ctx, registry);
    expect(enums).toContain("urbanisme");
    expect(enums).toContain("risques");
  });

  test("buildActionEnums avec thème → actions", () => {
    const ctxWithTheme = { ...ctx, theme: "urbanisme" as const };
    const enums = buildActionEnums(ctxWithTheme, registry);
    expect(enums).toContain("document");
    expect(enums).toContain("zonages");
  });
});
