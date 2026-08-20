/**
 * Seeded, deterministic PRNG (mulberry32). A scenario file + seed fully
 * determines a run — Math.random and Date are banned in simulation paths.
 */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = seed >>> 0;
    if (this.s === 0) this.s = 0x9e3779b9;
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  int(maxExclusive: number): number {
    return Math.floor(this.next() * maxExclusive);
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) throw new Error("pick from empty array");
    return arr[this.int(arr.length)]!;
  }

  /** n distinct picks (indices) from 0..maxExclusive-1, excluding `exclude`. */
  distinct(n: number, maxExclusive: number, exclude?: number): number[] {
    const out = new Set<number>();
    const target = Math.min(n, exclude === undefined ? maxExclusive : maxExclusive - 1);
    while (out.size < target) {
      const v = this.int(maxExclusive);
      if (v !== exclude) out.add(v);
    }
    return [...out];
  }

  poisson(lambda: number): number {
    if (lambda <= 0) return 0;
    const L = Math.exp(-lambda);
    let k = 0;
    let p = 1;
    do {
      k++;
      p *= this.next();
    } while (p > L);
    return k - 1;
  }
}
