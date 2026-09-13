/**
 * Seeded PRNG for reproducible ISL contract generation.
 *
 * Same seed ⇒ same sequence. Case N of a batch is `deriveSeed(runSeed, n)`.
 */

export class SeededRandom {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
    if (this.state === 0) this.state = 0x9e3779b9;
  }

  /** Next float in [0, 1). */
  next(): number {
    // Numerical Recipes LCG
    this.state = (Math.imul(this.state, 1664525) + 1013904223) >>> 0;
    return this.state / 0x100000000;
  }

  int(min: number, max: number): number {
    if (max < min) return min;
    return Math.floor(this.next() * (max - min + 1)) + min;
  }

  pick<T>(arr: readonly T[]): T {
    if (arr.length === 0) {
      throw new Error('SeededRandom.pick: empty array');
    }
    return arr[this.int(0, arr.length - 1)]!;
  }

  pickMaybe<T>(arr: readonly T[]): T | undefined {
    if (arr.length === 0) return undefined;
    return arr[this.int(0, arr.length - 1)];
  }

  bool(probability = 0.5): boolean {
    return this.next() < probability;
  }

  /** Shuffle a copy (Fisher–Yates). */
  shuffle<T>(arr: readonly T[]): T[] {
    const out = arr.slice();
    for (let i = out.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

/**
 * Splitmix32-style derivation so case `index` of run `seed` is independent
 * of how many RNG draws the previous case consumed.
 */
export function deriveSeed(seed: number, index: number): number {
  let x = (seed >>> 0) ^ Math.imul(index + 1, 0x9e3779b9);
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

export function createRng(seed: number): SeededRandom {
  return new SeededRandom(seed);
}
