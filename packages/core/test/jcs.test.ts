import { describe, expect, it } from "vitest";
import { canonicalize, assertNoFloats } from "../src/jcs.js";

describe("JCS canonicalization", () => {
  it("sorts object keys by UTF-16 code units", () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    // "é" (U+00E9) sorts after "z" (U+007A) in code-unit order
    expect(canonicalize({ "é": 1, z: 2 })).toBe('{"z":2,"é":1}');
  });

  it("nests and preserves array order", () => {
    expect(canonicalize({ a: [3, 1, { c: null, b: true }] })).toBe('{"a":[3,1,{"b":true,"c":null}]}');
  });

  it("emits no insignificant whitespace and escapes strings like JSON.stringify", () => {
    expect(canonicalize({ s: 'a"b\n' })).toBe('{"s":"a\\"b\\n\\u0007"}');
  });

  it("formats integers exactly", () => {
    expect(canonicalize({ n: 0 })).toBe('{"n":0}');
    expect(canonicalize({ n: 9007199254740991 })).toBe('{"n":9007199254740991}');
    expect(canonicalize({ n: -42 })).toBe('{"n":-42}');
  });

  it("rejects non-finite numbers and non-JSON values", () => {
    expect(() => canonicalize({ n: Infinity })).toThrow();
    expect(() => canonicalize({ f: () => 1 })).toThrow();
  });
});

describe("assertNoFloats (ADR-0005 convention)", () => {
  it("accepts integer-only structures", () => {
    expect(() => assertNoFloats({ a: 1, b: [2, { c: -3 }] })).not.toThrow();
  });
  it("rejects floats anywhere in the structure", () => {
    expect(() => assertNoFloats({ a: { b: [1, 2.5] } })).toThrow(/\$\.a\.b\[1\]/);
  });
});
