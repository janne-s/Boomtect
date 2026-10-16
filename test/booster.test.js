import assert from 'node:assert/strict';
import test from 'node:test';
import { pressureAtHeightPa, temperatureAtHeightKelvin } from '../src/shared/domain/air.js';
import { BOOSTER, GAMMA_AIR, GAS_CONSTANT_AIR_J_PER_KG_KELVIN, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED } from '../src/domain/constants.js';
import { boosterPath, flightBooms } from '../src/domain/flight.js';
import { tripleSpectrum } from '../src/shared/domain/pulses.js';
import { soundSpeedProfile } from '../src/shared/domain/refraction.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultBooster, defaultScene, parseScene, serializeScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

const boosterScene = (booster = {}, receiver = { x: -8000, y: 8000, z: 1.7 }) => {
  const scene = plainScene('sonic');
  scene.emitters = [{ ...defaultBooster(), ...booster }];
  scene.receivers[0].positionMetres = receiver;
  return parseScene(scene);
};

function triple(tau, T, f, h) {
  if (tau < 0 || tau > T) return 0;
  return 1 + (tau >= f * T ? h : 0) - 2 * (1 + h * (1 - f)) * tau / T;
}

test('the triple boom’s spectrum is the Fourier integral of its signature, which has no net area', () => {
  const T = .29;
  const { middleShare: f, middleRatio: h } = BOOSTER;
  const steps = 200000;
  for (const frequency of [.5, 3, 17, 120]) {
    let re = 0;
    let im = 0;
    for (let step = 0; step < steps; step += 1) {
      const tau = (step + .5) * T / steps;
      const p = triple(tau, T, f, h) * T / steps;
      re += p * Math.cos(2 * Math.PI * frequency * tau);
      im -= p * Math.sin(2 * Math.PI * frequency * tau);
    }
    const [sRe, sIm] = tripleSpectrum(frequency, T, f, h);
    const scale = Math.hypot(re, im);
    assert.ok(Math.abs(sRe - re) < 1e-4 * T && Math.abs(sIm - im) < 1e-4 * T, `${frequency} Hz: ${sRe} ${sIm} against ${re} ${im} (${scale})`);
  }
  assert.ok(Math.hypot(...tripleSpectrum(1e-6, T, f, h)) < 1e-5 * T);
  // Durrant et al.'s figure 5 at 8 km, front 130 Pa: about −105 Pa before the middle shock, 35 Pa after it, −65 Pa at the end.
  const at = tau => 130 * triple(tau, T, f, h);
  assert.ok(Math.abs(at(f * T - 1e-9) + 105) < 10 && Math.abs(at(f * T) - 35) < 10 && Math.abs(at(T) + 65) < 20, `${at(f * T - 1e-9)} ${at(f * T)} ${at(T)}`);
});

test('a booster falls under drag and gravity to its pad, below Mach 1 at about 6 km as Durrant et al. report', () => {
  const scene = boosterScene();
  const booster = scene.emitters[0];
  const path = boosterPath(booster, scene.air);
  const last = path.seconds.length - 1;
  assert.ok(Math.hypot(path.x[last] - booster.padMetres.x, path.y[last] - booster.padMetres.y) < 1e-6);
  assert.ok(Math.abs(path.z[last]) < 1e-6 && path.z[last - 1] > 0, `${path.z[last]}`);
  const sound = z => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(scene.air, z));
  assert.ok(Math.abs(path.speed[0] / sound(booster.startHeightMetres) - booster.mach) < 1e-9);
  const subsonic = path.speed.findIndex((speed, index) => speed < sound(path.z[index]));
  assert.ok(path.z[subsonic] > 5000 && path.z[subsonic] < 7000, `${path.z[subsonic]}`);
  const index = path.z.findIndex(z => z < 3000);
  const z = path.z[index];
  const density = pressureAtHeightPa(scene.air, z) / (GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(scene.air, z));
  const speed = path.speed[index];
  const expected = -density * speed * speed / (2 * booster.ballisticKilogramsPerSquareMetre) - STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED * path.vz[index] / speed;
  const measured = (path.speed[index + 1] - path.speed[index - 1]) / (2 * path.step);
  assert.ok(Math.abs(measured / expected - 1) < .01, `${measured} against ${expected}`);
});

test('a booster’s boom 8 km from its pad has about the 130 Pa and 0.29 s that Durrant et al. measured, in three shocks', () => {
  const scene = boosterScene();
  const booster = scene.emitters[0];
  const receiver = scene.receivers[0].positionMetres;
  const booms = flightBooms(boosterPath(booster, scene.air), booster, receiver, soundSpeedProfile(scene.air), scene.air);
  assert.equal(booms.length, 1);
  const [boom] = booms;
  assert.ok(boom.mach > 1.1 && boom.mach < 2, `${boom.mach}`);
  assert.ok(boom.durationSeconds > .25 && boom.durationSeconds < .35, `${boom.durationSeconds}`);
  const result = renderReceiver(prepareScene(scene), scene.receivers[0], scene);
  assert.ok(result.samples.every(Number.isFinite));
  assert.ok(result.peakPa > 100 && result.peakPa < 170, `${result.peakPa}`);
  const rate = result.sampleRate ?? 48000;
  const window = Math.round(rate / 1000);
  const rises = [];
  for (let index = window; index < result.samples.length; index += 1) rises.push([result.samples[index] - result.samples[index - window], index]);
  rises.sort((a, b) => b[0] - a[0]);
  const shocks = [];
  for (const [rise, index] of rises) {
    if (shocks.length === 3) break;
    if (shocks.every(other => Math.abs(other.index - index) > .02 * rate)) shocks.push({ rise, index });
  }
  shocks.sort((a, b) => a.index - b.index);
  const span = (shocks[2].index - shocks[0].index) / rate;
  const middle = (shocks[1].index - shocks[0].index) / rate / span;
  assert.ok(Math.abs(span / boom.durationSeconds - 1) < .1, `${span} against ${boom.durationSeconds}`);
  assert.ok(Math.abs(middle - BOOSTER.middleShare) < .05, `${middle}`);
});

test('a booster’s scene round-trips, and its pad lies on the ground', () => {
  const scene = boosterScene();
  assert.deepEqual(parseScene(JSON.parse(serializeScene(scene))), scene);
  const sonic = defaultScene('sonic');
  sonic.emitters.push(defaultBooster('booster-2'));
  assert.doesNotThrow(() => parseScene(sonic));
  sonic.emitters[1].padMetres = { x: 0, y: 0, z: 10 };
  assert.throws(() => parseScene(sonic), /padMetres must lie on the ground/);
});

test('a booster below the speed of sound leaves its Mach cone: no apex, and the cone keeps its rings', async () => {
  const { machCone } = await import('../src/shared/domain/trajectory.js');
  const scene = boosterScene();
  const booster = scene.emitters[0];
  const path = boosterPath(booster, scene.air);
  const profile = soundSpeedProfile(scene.air);
  const sound = z => Math.sqrt(GAMMA_AIR * GAS_CONSTANT_AIR_J_PER_KG_KELVIN * temperatureAtHeightKelvin(scene.air, z));
  const subsonic = path.speed.findIndex((speed, index) => index > 0 && speed < sound(path.z[index]));
  assert.ok(machCone(path, path.seconds[subsonic - 40], profile).apex);
  const early = machCone(path, path.seconds[subsonic + 20], profile);
  const late = machCone(path, path.seconds[subsonic + 60], profile);
  assert.equal(early.apex, null);
  assert.equal(late.apex, null);
  assert.equal(early.rings.length, late.rings.length);
  assert.ok(late.radii.every((radius, index) => radius > early.radii[index]));
});
