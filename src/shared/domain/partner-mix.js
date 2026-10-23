import { loudestDecibelsA } from './levels.js';

const SHARED_KEYS = Object.freeze(['place', 'terrain', 'air', 'ground', 'receivers', 'render']);

/** What linked tects hold in common: the place and its terrain, the air and ground, the microphones, and how a render is made. */
export const sharedPart = scene => Object.fromEntries(SHARED_KEYS.map(key => [key, scene[key]]));

export const withShared = (scene, shared) => ({ ...scene, ...Object.fromEntries(SHARED_KEYS.filter(key => key in shared).map(key => [key, structuredClone(shared[key])])) });

/** FNV-1a over the shared part's JSON; equal parts give equal keys in every tect. */
export function sharedKey(shared) {
  const text = JSON.stringify(sharedPart(shared));
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) hash = Math.imul(hash ^ text.charCodeAt(index), 0x01000193);
  return `${(hash >>> 0).toString(16)}:${text.length}`;
}

/** The surroundings' rumble stays off too, so that the render with echoes less this one is the echoes alone. */
export function withoutEchoes(scene) {
  const next = structuredClone(scene);
  if (next.terrain) next.terrain.echoes = false;
  next.ground.surroundings = false;
  return next;
}

/** A render's results as plain data for the linked tect, the samples copied so the own results stay whole. */
export const resultsForPartner = results => [...results.values()].map(result => ({
  receiverId: result.receiverId,
  sampleRate: result.sampleRate,
  startSeconds: result.startSeconds,
  channels: result.channels.map(samples => Float32Array.from(samples)),
  arrivals: result.arrivals,
  truncated: result.truncated,
  speedOfSound: result.speedOfSound,
  modelVersion: result.modelVersion
}));

const NO_ARRIVALS = Object.freeze({ count: 0, seconds: new Float64Array(0), metres: new Float64Array(0), heights: new Float32Array(0), levels: new Float32Array(0), bearings: new Float32Array(0), elevations: new Float32Array(0), kinds: new Uint8Array(0) });

function joinedArrivals(a = NO_ARRIVALS, b = NO_ARRIVALS) {
  const join = key => {
    const out = new a[key].constructor(a.count + b.count);
    out.set(a[key].subarray(0, a.count));
    out.set(b[key].subarray(0, b.count), a.count);
    return out;
  };
  return { count: a.count + b.count, ...Object.fromEntries(['seconds', 'metres', 'heights', 'levels', 'bearings', 'elevations', 'kinds'].map(key => [key, join(key)])) };
}

function finished(base, startSeconds, channels, arrivals, truncated) {
  let peakPa = 0;
  for (const value of channels[0]) peakPa = Math.max(peakPa, Math.abs(value));
  return { ...base, startSeconds, channels, samples: channels[0], peakPa, loudestDecibelsA: loudestDecibelsA(channels[0], base.sampleRate), arrivals, truncated };
}

/** One microphone's own result and the linked tect's at `gain`, summed on one time axis: pressures add, being linear. */
export function mixedResult(own, other, gain) {
  if (!other || !(gain > 0)) return own;
  const count = own ? own.channels.length : other.channels.length;
  const base = own ?? { receiverId: other.receiverId, sampleRate: other.sampleRate, speedOfSound: other.speedOfSound, nonlinearPaths: 0, modelVersion: other.modelVersion };
  const { sampleRate } = base;
  const parts = [own && { result: own, gain: 1 }, { result: other, gain }].filter(part => part && part.result.channels[0].length);
  if (!parts.length) return own ?? finished(base, 0, Array.from({ length: count }, () => new Float32Array(0)), other.arrivals, other.truncated);
  const start = Math.min(...parts.map(({ result }) => result.startSeconds));
  const offset = result => Math.round((result.startSeconds - start) * sampleRate);
  const length = Math.max(...parts.map(({ result }) => offset(result) + result.channels[0].length));
  const channels = Array.from({ length: count }, (_, channel) => {
    const out = new Float32Array(length);
    for (const { result, gain: scale } of parts) {
      const samples = result.channels[channel];
      if (!samples) continue;
      const from = offset(result);
      for (let index = 0; index < samples.length; index += 1) out[from + index] += scale * samples[index];
    }
    return out;
  });
  return finished(base, start, channels, joinedArrivals(own?.arrivals, other.arrivals), Boolean(own?.truncated || other.truncated));
}

/** Every microphone of `scene`: its own result, the linked tect's, or both summed. */
export function mixedResults(scene, own, others, gain) {
  const partner = new Map((others ?? []).map(result => [result.receiverId, result]));
  const results = new Map();
  for (const receiver of scene.receivers) {
    const result = mixedResult(own?.get(receiver.id) ?? null, partner.get(receiver.id) ?? null, gain);
    if (result) results.set(receiver.id, result);
  }
  return results.size ? results : null;
}
