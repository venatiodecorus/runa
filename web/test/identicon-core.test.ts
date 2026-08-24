/**
 * Pure identicon derivation (src/ui/identicon-core.ts): deterministic, total,
 * and horizontally symmetric — the React wrapper (Identicon.tsx) just
 * renders this spec as real SVG elements.
 */
import { describe, expect, it } from "vitest";
import { identiconSpec, identiconSvg } from "../src/ui/identicon-core.js";

describe("identiconSpec", () => {
  it("is deterministic: same id -> identical spec", () => {
    const a = identiconSpec("alice-account-id");
    const b = identiconSpec("alice-account-id");
    expect(a).toEqual(b);
  });

  it("different ids produce different cell grids", () => {
    const a = identiconSpec("alice");
    const b = identiconSpec("bob");
    expect(a.cells).not.toEqual(b.cells);
  });

  it("is horizontally symmetric", () => {
    const ids = ["alice", "bob", "carol-with-a-longer-id", "", "z"];
    for (const id of ids) {
      const { cells } = identiconSpec(id);
      for (let r = 0; r < 5; r++) {
        for (let c = 0; c < 5; c++) {
          expect(cells[r * 5 + c]).toBe(cells[r * 5 + (4 - c)]);
        }
      }
    }
  });

  it("produces a 25-cell grid", () => {
    expect(identiconSpec("alice").cells).toHaveLength(25);
  });

  it("hue is in [0, 360)", () => {
    for (const id of ["alice", "bob", "carol", "", "some-very-long-account-id-string"]) {
      const { hue } = identiconSpec(id);
      expect(hue).toBeGreaterThanOrEqual(0);
      expect(hue).toBeLessThan(360);
    }
  });

  it("never throws, including for the empty string", () => {
    expect(() => identiconSpec("")).not.toThrow();
  });
});

describe("identiconSvg", () => {
  it("returns inline SVG markup", () => {
    const svg = identiconSvg("alice");
    expect(svg).toContain("<svg");
    expect(svg).toContain("viewBox=\"0 0 5 5\"");
  });

  it("respects the requested size", () => {
    const svg = identiconSvg("alice", 48);
    expect(svg).toContain('width="48"');
    expect(svg).toContain('height="48"');
  });

  it("does not throw for the empty string", () => {
    expect(() => identiconSvg("")).not.toThrow();
    expect(identiconSvg("")).toContain("<svg");
  });
});
