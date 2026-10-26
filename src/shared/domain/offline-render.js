import { binauralChannels } from './binaural.js';
import { RENDER } from './constants.js';
import { nextPowerOfTwo, realSpectrum } from './fft.js';
import { loudestDecibelsA, pressureDecibels } from './levels.js';
import { speedOfSoundMetresPerSecond } from './air.js';
import { sharedPart } from './partner-mix.js';
import { renderReceiver } from './render.js';
import { decodeFloat32Wav, encodeFloat32Wav } from './wav.js';

export const OCTAVES_HZ = Object.freeze([31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]);
export const AMBIX_CONVENTION = 'AmbiX (ACN, SN3D); front = north, left = west, up = up';
const SPECTRUM_SIZE = 8192;
const AUDIBLE_SPAN_DECIBELS = 40;

const slug = text => text.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'mic';

function loudestSecond(samples, sampleRate) {
  const length = Math.min(samples.length, sampleRate);
  const step = Math.max(1, Math.round(length / 4));
  let [best, start] = [-1, 0];
  for (let from = 0; from + length <= samples.length; from += step) {
    let sum = 0;
    for (let index = from; index < from + length; index += 1) sum += samples[index] ** 2;
    if (sum > best) [best, start] = [sum, from];
  }
  return { start, length };
}

function powerSpectrum(samples) {
  const size = Math.min(SPECTRUM_SIZE, nextPowerOfTwo(samples.length));
  const hann = Float64Array.from({ length: size }, (_, index) => .5 - .5 * Math.cos(2 * Math.PI * index / size));
  const power = new Float64Array(size / 2 + 1);
  for (let from = 0; from === 0 || from + size <= samples.length; from += size / 2) {
    const block = Float64Array.from(hann, (weight, index) => weight * (samples[from + index] ?? 0));
    const { re, im } = realSpectrum(block);
    for (let bin = 1; bin < power.length; bin += 1) power[bin] += re[bin] ** 2 + im[bin] ** 2;
  }
  return { power, size };
}

export function measureSound(samples, sampleRate) {
  const peakPa = samples.reduce((top, value) => Math.max(top, Math.abs(value)), 0);
  const { start, length } = loudestSecond(samples, sampleRate);
  const { power, size } = powerSpectrum(samples.subarray(start, start + length));
  const hz = bin => bin * sampleRate / size;
  let [weighted, total] = [0, 0];
  for (let bin = 1; bin < power.length; bin += 1) [weighted, total] = [weighted + power[bin] * hz(bin), total + power[bin]];
  const bands = OCTAVES_HZ.map(centre => {
    let sum = 0;
    for (let bin = 1; bin < power.length; bin += 1) if (hz(bin) >= centre / Math.SQRT2 && hz(bin) < centre * Math.SQRT2) sum += power[bin];
    return sum;
  });
  const loudestBand = Math.max(...bands, 1e-300);
  const threshold = (peakPa * 10 ** (-AUDIBLE_SPAN_DECIBELS / 20)) ** 2;
  let [first, last] = [-1, -1];
  for (let index = 0; index < samples.length; index += 1) if (samples[index] ** 2 > threshold) [first, last] = [first < 0 ? index : first, index];
  const decibels = value => +value.toFixed(1);
  return {
    durationSeconds: +(samples.length / sampleRate).toFixed(2),
    withinFortyDecibelsSeconds: first < 0 ? 0 : +((last - first) / sampleRate).toFixed(2),
    peakDecibelsSpl: peakPa > 0 ? decibels(pressureDecibels(peakPa)) : null,
    loudestDecibelsAFast: peakPa > 0 ? decibels(loudestDecibelsA(samples, sampleRate)) : null,
    loudestSecondAt: +(start / sampleRate).toFixed(2),
    spectralCentroidHz: total > 0 ? Math.round(weighted / total) : 0,
    octaveShapeDecibels: Object.fromEntries(OCTAVES_HZ.map((centre, index) => [`${centre} Hz`, decibels(10 * Math.log10(Math.max(bands[index], 1e-300) / loudestBand))]))
  };
}

const POINT_FIELDS = Object.freeze(['positionMetres', 'startMetres', 'baseMetres', 'topMetres', 'ventMetres']);

function emitterExtent(emitter, air, include) {
  for (const field of POINT_FIELDS) if (emitter[field]) include(emitter[field]);
  if (emitter.centreMetres) {
    const { x, y } = emitter.centreMetres;
    const radius = emitter.radiusMetres ?? 0;
    include({ x: x - radius, y: y - radius });
    include({ x: x + radius, y: y + radius });
  }
  if (emitter.startMetres && [emitter.headingDegrees, emitter.mach, emitter.durationSeconds].every(Number.isFinite)) {
    const metres = emitter.mach * speedOfSoundMetresPerSecond(air?.temperatureCelsius ?? 15) * emitter.durationSeconds;
    const heading = emitter.headingDegrees * Math.PI / 180;
    include({ x: emitter.startMetres.x + metres * Math.sin(heading), y: emitter.startMetres.y + metres * Math.cos(heading) });
  }
}

export function sceneBounds(scene, prepared, others = []) {
  const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  const include = ({ x, y }) => {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    bounds.west = Math.min(bounds.west, x); bounds.east = Math.max(bounds.east, x);
    bounds.south = Math.min(bounds.south, y); bounds.north = Math.max(bounds.north, y);
  };
  for (const { sources } of prepared) for (let index = 0; index < sources.length; index += 1) include({ x: sources.x[index], y: sources.y[index] });
  for (const item of [scene, ...others]) {
    (item.emitters ?? []).forEach(emitter => emitterExtent(emitter, item.air ?? scene.air, include));
    (item.receivers ?? []).forEach(receiver => receiver.positionMetres && include(receiver.positionMetres));
  }
  if (!Number.isFinite(bounds.west)) return { west: 0, east: 0, south: 0, north: 0 };
  return bounds;
}

const tectOf = scene => String(scene.format ?? 'tect').replace(/\.scene$/, '');

export function renderSceneFiles(scene, tect, { ambix = false } = {}) {
  const started = performance.now();
  const prepared = tect.prepareScene(scene);
  const order = scene.render.ambisonicOrder;
  const results = scene.receivers.map(receiver => {
    const result = renderReceiver(prepared, receiver, scene);
    const binaural = receiver.type === 'binaural' && order > 0;
    return { receiver, result, binaural, listened: binaural ? binauralChannels(result.channels, order, receiver.headingDegrees, receiver.pitchDegrees) : [result.channels[0]] };
  });
  const peakOf = channels => channels.reduce((top, channel) => channel.reduce((most, value) => Math.max(most, Math.abs(value)), top), 0);
  const loudestPa = Math.max(0, ...results.map(({ result, listened }) => Math.max(result.peakPa, peakOf(listened))));
  const gain = scene.render.levelMode === 'fixed' ? 1 / scene.render.fullScalePa : loudestPa > 0 ? RENDER.peakTarget / loudestPa : 1;
  const scaled = channels => channels.map(channel => Float32Array.from(channel, value => value * gain));
  const names = new Set();
  const files = [];
  const microphones = results.map(({ receiver, result, binaural, listened }) => {
    let stem = slug(receiver.name);
    for (let count = 2; names.has(stem); count += 1) stem = `${slug(receiver.name)}-${count}`;
    names.add(stem);
    files.push({ name: `${stem}.wav`, data: new Uint8Array(encodeFloat32Wav(scaled(listened), result.sampleRate)) });
    if (ambix) files.push({ name: `${stem}-ambix.wav`, data: new Uint8Array(encodeFloat32Wav(scaled(result.channels), result.sampleRate)) });
    return {
      file: `${stem}.wav`, ambixFile: ambix ? `${stem}-ambix.wav` : undefined, receiverId: receiver.id, name: receiver.name,
      listening: binaural ? `binaural, facing ${receiver.headingDegrees}° at ${receiver.pitchDegrees}° elevation` : 'omni pressure',
      channels: listened.length, positionMetres: receiver.positionMetres,
      startSeconds: +result.startSeconds.toFixed(6), ...measureSound(result.channels[0], result.sampleRate)
    };
  });
  const summary = {
    tect: tectOf(scene),
    scene: 'scene.json',
    fullScalePa: +(1 / gain).toPrecision(6),
    ambisonicConvention: ambix ? AMBIX_CONVENTION : undefined,
    place: scene.place,
    terrain: scene.terrain ? { cellMetres: scene.terrain.cellMetres, patches: scene.terrain.patches.length, datumMetres: +scene.terrain.datumMetres.toFixed(1), echoes: scene.terrain.echoes } : null,
    modelVersion: scene.modelVersion,
    renderSeconds: +((performance.now() - started) / 1000).toFixed(1),
    microphones
  };
  files.push({ name: 'scene.json', data: new TextEncoder().encode(`${tect.serializeScene(scene)}\n`) });
  files.push({ name: 'summary.json', data: new TextEncoder().encode(`${JSON.stringify(summary, null, 2)}\n`) });
  return { files, summary };
}

const comparedPart = scene => { const { render, ...rest } = sharedPart(scene); return JSON.stringify(rest); };

export function mixRenders(renders) {
  const warnings = [];
  const first = renders[0];
  for (const other of renders.slice(1)) if (comparedPart(other.scene) !== comparedPart(first.scene)) warnings.push(`${other.summary.tect} does not share the place, terrain, air, ground, and microphones of ${first.summary.tect}; the parts were heard in different scenes.`);
  const fixed = renders.every(({ scene }) => scene.render.levelMode === 'fixed') && new Set(renders.map(({ scene }) => scene.render.fullScalePa)).size === 1;
  const byReceiver = new Map();
  for (const render of renders) {
    for (const microphone of render.summary.microphones) {
      const { channels, sampleRate } = decodeFloat32Wav(render.read(microphone.file));
      const pascals = channels.map(channel => Float32Array.from(channel, value => value * render.summary.fullScalePa));
      if (!byReceiver.has(microphone.receiverId)) byReceiver.set(microphone.receiverId, { microphone, parts: [] });
      byReceiver.get(microphone.receiverId).parts.push({ tect: render.summary.tect, startSeconds: microphone.startSeconds, sampleRate, channels: pascals });
    }
  }
  const mixes = [...byReceiver.values()].map(({ microphone, parts }) => {
    const sampleRate = parts[0].sampleRate;
    if (parts.some(part => part.sampleRate !== sampleRate)) throw new Error(`${microphone.name}: the renders differ in sample rate.`);
    const channelCount = Math.min(...parts.map(part => part.channels.length));
    if (parts.some(part => part.channels.length !== channelCount)) warnings.push(`${microphone.name}: the renders differ in channels; ${channelCount} are mixed.`);
    const start = Math.min(...parts.map(part => part.startSeconds));
    const offset = part => Math.round((part.startSeconds - start) * sampleRate);
    const length = Math.max(...parts.map(part => offset(part) + part.channels[0].length));
    const placed = parts.map(part => ({ tect: part.tect, channels: part.channels.slice(0, channelCount).map(channel => { const out = new Float32Array(length); out.set(channel, offset(part)); return out; }) }));
    const sum = Array.from({ length: channelCount }, (_, channel) => {
      const out = new Float32Array(length);
      for (const part of placed) { const source = part.channels[channel]; for (let index = 0; index < length; index += 1) out[index] += source[index]; }
      return out;
    });
    if (parts.length < renders.length) warnings.push(`${microphone.name} is not in every render.`);
    return { microphone, sampleRate, start, sum, placed };
  });
  const peak = channels => channels[0].reduce((top, value) => Math.max(top, Math.abs(value)), 0);
  const loudestPa = Math.max(0, ...mixes.flatMap(mix => [peak(mix.sum), ...mix.placed.map(part => peak(part.channels))]));
  const gain = fixed ? 1 / first.scene.render.fullScalePa : loudestPa > 0 ? RENDER.peakTarget / loudestPa : 1;
  const scaled = channels => channels.map(channel => Float32Array.from(channel, value => value * gain));
  const files = [];
  const microphones = mixes.map(({ microphone, sampleRate, start, sum, placed }) => {
    const stem = microphone.file.replace(/\.wav$/, '');
    files.push({ name: `${stem}.wav`, data: new Uint8Array(encodeFloat32Wav(scaled(sum), sampleRate)) });
    const parts = placed.map(part => {
      const name = `${stem}-${part.tect}.wav`;
      files.push({ name, data: new Uint8Array(encodeFloat32Wav(scaled(part.channels), sampleRate)) });
      return { tect: part.tect, file: name, ...measureSound(part.channels[0], sampleRate) };
    });
    return { file: `${stem}.wav`, receiverId: microphone.receiverId, name: microphone.name, channels: sum.length, startSeconds: +start.toFixed(6), ...measureSound(sum[0], sampleRate), parts };
  });
  const summary = { tects: renders.map(({ summary }) => summary.tect), fullScalePa: +(1 / gain).toPrecision(6), warnings, microphones };
  files.push({ name: 'summary.json', data: new TextEncoder().encode(`${JSON.stringify(summary, null, 2)}\n`) });
  return { files, summary };
}
