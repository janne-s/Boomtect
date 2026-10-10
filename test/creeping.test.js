import assert from 'node:assert/strict';
import test from 'node:test';
import { airy } from '../src/domain/airy.js';
import { creepingLossRatios, creepingTransitionHz, modeRoot, SOFT_RATIO } from '../src/domain/creeping.js';
import { fft } from '../src/domain/fft.js';
import { GROUND_FLOW_RESISTIVITY } from '../src/domain/ground.js';
import { shadowResponse } from '../src/domain/render.js';

const close = (actual, expected, tolerance, label) => assert.ok(Math.abs(actual - expected) < tolerance, `${label}: ${actual} vs ${expected}`);

test('the Airy function matches tabulated values and solves Ai″ = z·Ai off the real axis', () => {
  // Abramowitz & Stegun table 10.11.
  close(airy([1, 0])[0][0], .13529241631288141, 1e-14, 'Ai(1)');
  close(airy([-1, 0])[0][0], .53556088329235211, 1e-14, 'Ai(−1)');
  close(airy([-1, 0])[1][0], -.01016056711664521, 1e-14, 'Ai′(−1)');
  close(airy([-2.338107410459767, 0])[0][0], 0, 1e-13, 'first zero of Ai');
  close(airy([-1.018792971647471, 0])[1][0], 0, 1e-13, 'first zero of Ai′');
  for (const z of [[1, 1], [-2, 1.5], [-1.5, -2.5]]) {
    const h = 1e-5;
    const up = airy([z[0] + h, z[1]])[1];
    const down = airy([z[0] - h, z[1]])[1];
    const [value] = airy(z);
    const second = [(up[0] - down[0]) / (2 * h), (up[1] - down[1]) / (2 * h)];
    const expected = [z[0] * value[0] - z[1] * value[1], z[0] * value[1] + z[1] * value[0]];
    assert.ok(Math.hypot(second[0] - expected[0], second[1] - expected[1]) < 1e-8, `${z}`);
  }
});

test('the creeping mode is that of rigid ground at q = 0 and of a pressure-release surface as q grows', () => {
  close(modeRoot([0, 0], [-1, 0])[0], -1.018792971647471, 1e-12, 'rigid');
  close(modeRoot([1e7, 0], [-2.3, 0])[0], -2.338107410459767, 1e-6, 'pressure release');
  close(SOFT_RATIO, 2.338107410459767 / 1.018792971647471, 1e-12, 'ratio');
  // Grass under the standard atmosphere: rigid-like at low frequencies, soft at high ones.
  const ratios = creepingLossRatios([20, 10000], GROUND_FLOW_RESISTIVITY.grass, 340, 340 / .0039);
  assert.ok(Math.abs(ratios[0] - 1) < .15, `${ratios[0]}`);
  assert.ok(Math.abs(ratios[1] - SOFT_RATIO) < .05, `${ratios[1]}`);
  // Softer ground turns soft at lower frequencies.
  assert.ok(creepingTransitionHz(GROUND_FLOW_RESISTIVITY.snow, 340, 87000) < creepingTransitionHz(GROUND_FLOW_RESISTIVITY.grass, 340, 87000));
});

test('soft ground never lets more through the shadow than rigid ground, and its response is causal', () => {
  const nepers = 3;
  const transition = creepingTransitionHz(GROUND_FLOW_RESISTIVITY.grass, 340, 87000);
  for (let frequency = .5; frequency < 20000; frequency *= 1.05) {
    assert.ok(Math.hypot(...shadowResponse(frequency, nepers, 0, transition)) <= Math.hypot(...shadowResponse(frequency, nepers, 0)) * (1 + 1e-12), `${frequency} Hz`);
  }
  // The impulse response from the transfer function: no energy before time zero, which a circular
  // inverse transform folds into the end of the buffer.
  const size = 1 << 17;
  const rate = 48000;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let bin = 1; bin < size / 2; bin += 1) {
    const [a, b] = shadowResponse(bin * rate / size, nepers, 0, transition);
    re[bin] = a; im[bin] = b; re[size - bin] = a; im[size - bin] = -b;
  }
  // The response passes the mean of the pulse unchanged: H(0) = 1.
  re[0] = 1;
  fft(re, im, true);
  let total = 0;
  let before = 0;
  for (let index = 0; index < size; index += 1) {
    total += re[index] ** 2;
    if (index > size * .9) before += re[index] ** 2;
  }
  assert.ok(before / total < 1e-9, `${before / total}`);
});
