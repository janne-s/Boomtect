import assert from 'node:assert/strict';
import test from 'node:test';
import { faddeeva } from '../src/shared/domain/faddeeva.js';
import { fft } from '../src/shared/domain/fft.js';
import { friedlanderSpanSeconds, friedlanderSpectrum, nWaveDurationForPeak, nWaveSpectrum } from '../src/domain/pulses.js';

const close = (actual, expected, tolerance, message) => assert.ok(Math.abs(actual - expected) <= tolerance, `${message}: ${actual} vs ${expected}`);

function numericSpectrum(signal, spanSeconds, frequencyHz, steps = 40000) {
  const dt = spanSeconds / steps;
  let re = 0;
  let im = 0;
  for (let index = 0; index < steps; index += 1) {
    const t = (index + .5) * dt;
    const value = signal(t);
    re += value * Math.cos(2 * Math.PI * frequencyHz * t) * dt;
    im -= value * Math.sin(2 * Math.PI * frequencyHz * t) * dt;
  }
  return [re, im];
}

test('FFT inverse restores the input', () => {
  const real = Float64Array.from({ length: 64 }, (_, index) => Math.sin(index * .7) + index % 3);
  const original = Float64Array.from(real);
  const imaginary = new Float64Array(64);
  fft(real, imaginary);
  fft(real, imaginary, true);
  real.forEach((value, index) => close(value, original[index], 1e-12, `sample ${index}`));
});

test('Faddeeva function matches known values', () => {
  const cases = [[[0, 0], [1, 0]], [[1, 0], [.36787944117, .60715770584]], [[0, 1], [.42758357616, 0]], [[1, 1], [.30474420526, .20821893820]]];
  for (const [[re, im], [expectedRe, expectedIm]] of cases) {
    const [actualRe, actualIm] = faddeeva(re, im);
    close(actualRe, expectedRe, 1e-9, `Re w(${re}+${im}i)`);
    close(actualIm, expectedIm, 1e-9, `Im w(${re}+${im}i)`);
  }
});

test('Faddeeva lower half-plane satisfies w(z) + w(−z) = 2·exp(−z²)', () => {
  const [aRe, aIm] = faddeeva(.8, -.3);
  const [bRe, bIm] = faddeeva(-.8, .3);
  const exponentRe = .3 * .3 - .8 * .8;
  const exponentIm = 2 * .8 * .3;
  close(aRe + bRe, 2 * Math.exp(exponentRe) * Math.cos(exponentIm), 1e-9, 'real');
  close(aIm + bIm, 2 * Math.exp(exponentRe) * Math.sin(exponentIm), 1e-9, 'imaginary');
});

test('N-wave spectrum matches numeric integration and has no DC', () => {
  const duration = .004;
  for (const frequency of [10, 137, 900]) {
    const [re, im] = nWaveSpectrum(frequency, duration);
    const [expectedRe, expectedIm] = numericSpectrum(t => t <= duration ? 1 - 2 * t / duration : 0, duration, frequency);
    close(re, expectedRe, 1e-8, `re ${frequency}`);
    close(im, expectedIm, 1e-8, `im ${frequency}`);
  }
  assert.deepEqual(nWaveSpectrum(0, duration), [0, 0]);
});

test('N-wave duration places the spectral peak at the requested frequency', () => {
  const duration = nWaveDurationForPeak(100);
  const magnitude = frequency => Math.hypot(...nWaveSpectrum(frequency, duration));
  assert.ok(magnitude(100) > magnitude(98) && magnitude(100) > magnitude(102));
});

test('Friedlander spectrum matches numeric integration', () => {
  const duration = .01;
  const decay = 1.3;
  for (const frequency of [0, 20, 300]) {
    const [re, im] = friedlanderSpectrum(frequency, duration, decay);
    const [expectedRe, expectedIm] = numericSpectrum(t => (1 - t / duration) * Math.exp(-decay * t / duration), friedlanderSpanSeconds(duration, decay), frequency, 200000);
    close(re, expectedRe, 1e-7, `re ${frequency}`);
    close(im, expectedIm, 1e-7, `im ${frequency}`);
  }
});
