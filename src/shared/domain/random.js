/** mulberry32. */
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

export const uniform = (random, [low, high]) => low + random() * (high - low);

export function normalDeviate(random) {
  const radius = Math.sqrt(-2 * Math.log(1 - random()));
  return radius * Math.cos(2 * Math.PI * random());
}

/** `count` unit normal deviates using both of each Box–Muller pair: a different sequence from `normalDeviate`, at half its cost. */
export function normalDeviates(random, count) {
  const deviates = new Float64Array(count);
  for (let index = 0; index < count; index += 2) {
    const radius = Math.sqrt(-2 * Math.log(1 - random()));
    const angle = 2 * Math.PI * random();
    deviates[index] = radius * Math.cos(angle);
    if (index + 1 < count) deviates[index + 1] = radius * Math.sin(angle);
  }
  return deviates;
}

export const isSeed = value => Number.isInteger(value) && value >= 0 && value <= 0xffffffff;

export const newSeed = () => crypto.getRandomValues(new Uint32Array(1))[0];
