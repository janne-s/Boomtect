/** Deterministic uniform generator on [0, 1) from a 32-bit seed (mulberry32). */
export function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ mixed >>> 15, mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ mixed >>> 7, mixed | 61);
    return ((mixed ^ mixed >>> 14) >>> 0) / 4294967296;
  };
}

/** Standard normal deviate by Box–Muller from a uniform generator. */
export function normalDeviate(random) {
  const radius = Math.sqrt(-2 * Math.log(1 - random()));
  return radius * Math.cos(2 * Math.PI * random());
}

export const isSeed = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
