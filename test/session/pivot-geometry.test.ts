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
    expect(r?.cql).toMatch(/^INTERSECTS\(geom, POLYGON/);
  });
});
