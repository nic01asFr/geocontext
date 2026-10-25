import { describe, test, expect } from "@jest/globals";
import { nomCorrespond } from "../../src/session/navigate";

describe("nomCorrespond — le géocodeur ne choisit pas en silence", () => {
  test("accepte le nom exact, avec accents, casse, abréviations et compléments", () => {
    expect(nomCorrespond("Cassis", "Cassis")).toBe(true);
    expect(nomCorrespond("cassis 13260", "Cassis")).toBe(true);
    expect(nomCorrespond("Saint-Tropez", "Saint-Tropez")).toBe(true);
    expect(nomCorrespond("St Tropez", "Saint-Tropez")).toBe(true);
    expect(nomCorrespond("Gémenos", "Gemenos")).toBe(true);
    expect(nomCorrespond("Fort de France", "Fort-de-France")).toBe(true);
  });
  test("refuse une correspondance seulement approchante", () => {
    expect(nomCorrespond("France", "Fort-de-France")).toBe(false);
    expect(nomCorrespond("Cassi", "Cassis")).toBe(false);
    expect(nomCorrespond("Paris", "Parisot")).toBe(false);
    expect(nomCorrespond("", "Cassis")).toBe(false);
    expect(nomCorrespond("Cassis", "")).toBe(false);
  });
});

import { resolveTerritory } from "../../src/session/navigate";
import { createEmptyContext } from "../../src/session/types";

describe("navigation vers un bâtiment", () => {
  test("refus explicite, jamais lu comme une parcelle", async () => {
    const r: any = await resolveTerritory("BATIMENT0000000258037070", createEmptyContext());
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/bâtiment non prise en charge/);
    expect(r.error).not.toMatch(/Parcelle introuvable/);
  });
});
