/**
 * RFC 8785 (JCS) canonicalization.
 *
 * JCS specifies ECMAScript semantics for number formatting and string
 * escaping, and sorting of object keys by UTF-16 code units — all of which
 * are exactly what native JSON.stringify and Array.prototype.sort provide,
 * so the implementation reduces to recursive key sorting.
 */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) throw new Error("jcs: non-finite number");
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object": {
      if (Array.isArray(value)) {
        return "[" + value.map(canonicalize).join(",") + "]";
      }
      const obj = value as Record<string, unknown>;
      const keys = Object.keys(obj).sort(); // default sort = UTF-16 code units, per JCS
      return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") + "}";
    }
    default:
      throw new Error(`jcs: cannot canonicalize value of type ${typeof value}`);
  }
}

/**
 * Protocol v1 convention (ADR-0005): signed records carry no non-integer
 * numbers, sidestepping cross-language float formatting entirely.
 * Throws if any number in the structure is not a safe integer.
 */
export function assertNoFloats(value: unknown, path = "$"): void {
  if (value === null) return;
  switch (typeof value) {
    case "number":
      if (!Number.isSafeInteger(value)) {
        throw new Error(`record contains non-integer number at ${path}: ${value}`);
      }
      return;
    case "object": {
      if (Array.isArray(value)) {
        value.forEach((v, i) => assertNoFloats(v, `${path}[${i}]`));
        return;
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        assertNoFloats(v, `${path}.${k}`);
      }
      return;
    }
    default:
      return;
  }
}
