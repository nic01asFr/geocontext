import { buildSpatialCql } from "../../src/session/registry/pivot.js";
import { createEmptyContext } from "../../src/session/types.js";

const pivot: any = { strategy: "spatial", spatialOp: "intersects", geometryColumn: "geom", from: "context.geometry" };
const poly: GeoJSON.Geometry = { type: "Polygon", coordinates: [[[5, 43], [5.1, 43], [5.1, 43.1], [5, 43]]] };

describe("filtre spatial INTERSECTS avec la géométrie du contexte", () => {
  it("refuse sans géométrie (pas de repli sur un rectangle)", () => {
    expect(buildSpatialCql(createEmptyContext(), pivot)).toBeNull();
  });
  it("utilise ctx.geometry quand aucune géométrie n'est passée", () => {
    const ctx = createEmptyContext();
    ctx.geometry = poly;
    const r = buildSpatialCql(ctx, pivot);
    expect(r?.cql).toMatch(/^INTERSECTS\(geom, SRID=4326;POLYGON/);
  });
});

import { deriveStyleRecipe } from "../../src/session/styling/deterministic.js";
import { registry } from "../../src/session/registry/registry.js";

describe("type de géométrie annoncé d'après le jeu de données", () => {
  it.each([
    ["urba_prescriptions_lin", "line"],
    ["urba_prescriptions_pct", "point"],
    ["urba_prescriptions_surf", "polygon"],
  ])("%s → %s", (id, attendu) => {
    const src: any = registry.getSource(id);
    expect(src).toBeTruthy();
    expect(deriveStyleRecipe(src, []).geometryType).toBe(attendu);
  });
});
