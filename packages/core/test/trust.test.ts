import { describe, expect, it } from "vitest";
import { subjectiveTrust, trustMap, effectiveTrust, feedBucket, type GraphView } from "../src/trust.js";

// V = viewer; A..E authors; graph shapes per docs/trust-and-reach.md §1.
const g = (follows: Record<string, string[]>, mutes: string[] = []): GraphView => ({ follows, mutes });

describe("subjectiveTrust", () => {
  it("direct follow = 1.0", () => {
    expect(subjectiveTrust("V", "A", g({ V: ["A"] }))).toBe(1.0);
  });

  it("single two-hop path = decay (0.35)", () => {
    expect(subjectiveTrust("V", "B", g({ V: ["A"], A: ["B"] }))).toBeCloseTo(0.35, 10);
  });

  it("beyond hop 2 = no path", () => {
    expect(subjectiveTrust("V", "C", g({ V: ["A"], A: ["B"], B: ["C"] }))).toBe(0);
  });

  it("multiple paths sum: direct + two 2-hop paths", () => {
    const graph = g({ V: ["A", "M1", "M2"], M1: ["A"], M2: ["A"] });
    expect(subjectiveTrust("V", "A", graph)).toBeCloseTo(1.7, 10);
  });

  it("path sum caps at 2.0", () => {
    const graph = g({ V: ["A", "M1", "M2", "M3", "M4"], M1: ["A"], M2: ["A"], M3: ["A"], M4: ["A"] });
    expect(subjectiveTrust("V", "A", graph)).toBe(2.0);
  });

  it("muted author is a hard zero despite paths", () => {
    expect(subjectiveTrust("V", "A", g({ V: ["A", "M"], M: ["A"] }, ["A"]))).toBe(0);
  });

  it("mute prunes propagation through the muted account", () => {
    // V follows M (muted) and A; only A's vouch counts.
    const graph = g({ V: ["M", "A"], M: ["B"], A: ["B"] }, ["M"]);
    expect(subjectiveTrust("V", "B", graph)).toBeCloseTo(0.35, 10);
  });

  it("duplicate follow entries do not double-count", () => {
    expect(subjectiveTrust("V", "A", g({ V: ["A", "A"] }))).toBe(1.0);
  });

  it("self-trust is undefined by the spec", () => {
    expect(() => subjectiveTrust("V", "V", g({ V: ["A"] }))).toThrow(/self-trust/);
  });
});

describe("trustMap", () => {
  it("agrees with per-author computation across a mixed graph", () => {
    const graph = g({ V: ["A", "B", "M"], A: ["B", "C"], B: ["C"], M: ["C"] }, ["M"]);
    const map = trustMap("V", graph);
    expect(map["A"]).toBeCloseTo(subjectiveTrust("V", "A", graph), 10); // 1.0
    expect(map["B"]).toBeCloseTo(subjectiveTrust("V", "B", graph), 10); // 1.35
    expect(map["C"]).toBeCloseTo(subjectiveTrust("V", "C", graph), 10); // 0.7 (via A and B; M pruned)
    expect(map["M"]).toBeUndefined();
    expect(Object.keys(map).sort()).toEqual(["A", "B", "C"]);
  });

  it("never includes the viewer", () => {
    const map = trustMap("V", g({ V: ["A"], A: ["V"] }));
    expect(map["V"]).toBeUndefined();
  });
});

describe("effectiveTrust & feedBucket", () => {
  it("multiplies by standing and buckets by the published threshold", () => {
    expect(effectiveTrust(1.0, 0.5)).toBe(0.5);
    expect(feedBucket(0.3)).toBe("normal"); // threshold is inclusive
    expect(feedBucket(0.29)).toBe("below-threshold");
    expect(feedBucket(0)).toBe("no-path");
  });

  it("a hop-2 acquaintance at full standing surfaces normally", () => {
    expect(feedBucket(effectiveTrust(0.35, 1.0))).toBe("normal");
  });

  it("rejects out-of-range standing", () => {
    expect(() => effectiveTrust(1, 1.5)).toThrow(/standing/);
  });
});
