// Seeded RNG (mulberry32), so reboots and serials are reproducible in tests.
export interface Rng {
  next(): number;
  hex(n: number): string;
}

export function createRng(seed: number): Rng {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    hex: (n) => Array.from({ length: n }, () => Math.floor(next() * 16).toString(16).toUpperCase()).join(''),
  };
}
