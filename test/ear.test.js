import assert from 'node:assert/strict';
import test from 'node:test';
import { EAR } from '../src/domain/constants.js';
import { applyEar, envelope, reflexAttenuation } from '../src/domain/ear.js';

const SAMPLE_RATE = 48000;
const pascals = decibels => EAR.referencePressurePa * 10 ** (decibels / 20);
const tone = (frequency, decibels, seconds, offset = 0) => Float32Array.from({ length: Math.round(seconds * SAMPLE_RATE) },
  (_, index) => (index / SAMPLE_RATE >= offset ? Math.SQRT2 * pascals(decibels) * Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE) : 0));
const rms = (samples, from, to) => {
  let sum = 0;
  for (let index = Math.round(from * SAMPLE_RATE); index < Math.round(to * SAMPLE_RATE); index += 1) sum += samples[index] ** 2;
  return Math.sqrt(sum / Math.round((to - from) * SAMPLE_RATE));
};

test('below the reflex threshold the reflex leaves the sound unchanged', () => {
  const quiet = tone(200, 70, 1);
  const [heard] = applyEar([quiet], SAMPLE_RATE, { reflex: true, loudness: false });
  assert.ok(heard.every((value, index) => Math.abs(value - quiet[index]) < 1e-9));
});

test('a loud low tone is attenuated only after the reflex latency, by about its level-dependent amount', () => {
  const loud = tone(200, 105, 1.5, .2);
  const [heard] = applyEar([loud], SAMPLE_RATE, { reflex: true, loudness: false });
  const early = 20 * Math.log10(rms(heard, .2, .23) / rms(loud, .2, .23));
  const settled = 20 * Math.log10(rms(heard, .45, .55) / rms(loud, .45, .55));
  assert.ok(early > -1, `early ${early}`);
  const expected = -Math.min(EAR.maximumAttenuationDb, EAR.attenuationPerDb * (105 - EAR.reflexThresholdDb));
  assert.ok(Math.abs(settled - expected) < 3, `settled ${settled}, expected about ${expected}`);
});

test('the reflex spares high frequencies', () => {
  const loud = tone(6000, 105, 1.5, .2);
  const [heard] = applyEar([loud], SAMPLE_RATE, { reflex: true, loudness: false });
  assert.ok(20 * Math.log10(rms(heard, .45, .55) / rms(loud, .45, .55)) > -1.5);
});

test('the reflex fades while the sound is sustained', () => {
  const { values } = envelope(tone(200, 110, 8), SAMPLE_RATE);
  const attenuation = reflexAttenuation(values, EAR.envelopeSeconds);
  assert.ok(attenuation[100] > 2 * attenuation[700]);
});

test('loudness compression shrinks level differences to the exponent', () => {
  const signal = Float32Array.from({ length: SAMPLE_RATE }, (_, index) => (index < SAMPLE_RATE / 2 ? 1 : .01) * Math.sin(index * .3));
  const [heard] = applyEar([signal], SAMPLE_RATE, { reflex: false, loudness: true });
  const before = 20 * Math.log10(rms(signal, .2, .45) / rms(signal, .85, .98));
  const after = 20 * Math.log10(rms(heard, .2, .45) / rms(heard, .85, .98));
  assert.ok(Math.abs(after - EAR.loudnessExponent * before) < .5, `${before} → ${after}`);
});

test('every channel gets the same processing as the pressure', () => {
  const loud = tone(200, 105, 1, .1);
  const [w, x] = applyEar([loud, loud.map(value => value * .5)], SAMPLE_RATE);
  w.forEach((value, index) => assert.ok(Math.abs(x[index] - value * .5) < 1e-6));
});

test('the reflex moving under a loud bass adds no buzz at the frame rate', () => {
  const sampleRate = SAMPLE_RATE;
  const x = Float32Array.from({ length: 2 * sampleRate }, (_, index) => (index > sampleRate / 2 ? 200 : 0) * Math.sin(2 * Math.PI * 20 * index / sampleRate));
  const [y] = applyEar([x], sampleRate, { reflex: true, loudness: false });
  const from = Math.round(.55 * sampleRate);
  const length = sampleRate / 2;
  let re = 0;
  let im = 0;
  for (let index = from; index < from + length; index += 1) {
    re += y[index] * Math.cos(2 * Math.PI * 1000 * index / sampleRate);
    im += y[index] * Math.sin(2 * Math.PI * 1000 * index / sampleRate);
  }
  const decibels = 20 * Math.log10(Math.hypot(re, im) / length * 2 / 200);
  assert.ok(decibels < -100, `${decibels} dB`);
});

test('loudness compression adds no harmonics of a loud bass', () => {
  const x = Float32Array.from({ length: 3 * SAMPLE_RATE }, (_, index) => 100 * Math.exp(-index / SAMPLE_RATE) * Math.sin(2 * Math.PI * 40 * index / SAMPLE_RATE));
  const [y] = applyEar([x], SAMPLE_RATE, { reflex: false, loudness: true });
  const from = SAMPLE_RATE;
  const n = SAMPLE_RATE / 2;
  const level = frequency => {
    let re = 0;
    let im = 0;
    for (let index = from; index < from + n; index += 1) {
      const weight = .5 - .5 * Math.cos(2 * Math.PI * (index - from) / n);
      re += weight * y[index] * Math.cos(2 * Math.PI * frequency * index / SAMPLE_RATE);
      im += weight * y[index] * Math.sin(2 * Math.PI * frequency * index / SAMPLE_RATE);
    }
    return Math.hypot(re, im);
  };
  for (const frequency of [80, 120, 160, 200]) assert.ok(20 * Math.log10(level(frequency) / level(40)) < -65, `${frequency} Hz`);
});

test('with its onsets capped, Loudness raises no sample above the loudest going in, and still raises the quiet', () => {
  const sampleRate = 48000;
  const signal = Float32Array.from({ length: 3 * sampleRate }, (_, index) => {
    const t = index / sampleRate - 1;
    const hiss = .01 * Math.sin(index * 1.7) * Math.sin(index * .013);
    return hiss + (t >= 0 && t < .1 ? 50 * (1 - 2 * t / .1) : 0);
  });
  const peak = channel => channel.reduce((max, value) => Math.max(max, Math.abs(value)), 0);
  const rms = (channel, from, to) => Math.sqrt(channel.slice(from, to).reduce((sum, value) => sum + value * value, 0) / (to - from));
  const [free] = applyEar([signal], sampleRate, { reflex: false, loudness: true, capOnsets: false });
  const [capped] = applyEar([signal], sampleRate, { reflex: false, loudness: true });
  assert.ok(peak(free) > 1.5 * peak(signal), `${peak(free)}`);
  assert.ok(peak(capped) <= peak(signal) * (1 + 1e-6), `${peak(capped)}`);
  const quiet = [Math.round(.2 * sampleRate), Math.round(.6 * sampleRate)];
  assert.ok(rms(capped, ...quiet) > 10 * rms(signal, ...quiet));
  assert.ok(Math.abs(rms(capped, ...quiet) / rms(free, ...quiet) - 1) < 1e-6);
});
