import assert from 'node:assert/strict';
import test from 'node:test';
import { airDensityKilogramsPerCubicMetre } from '../src/domain/air.js';
import { FIREWORKS, STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED } from '../src/domain/constants.js';
import { emitterSources } from '../src/domain/emitters.js';
import { fireworksBlasts, fireworksShells, shellFlight, shellPops } from '../src/domain/fireworks.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultBlast, defaultFireworks, defaultScene, parseScene, serializeScene } from '../src/domain/scene.js';
import { plainScene } from './plain-scene.js';

const fireworksScene = (fireworks = {}, receiver = { x: 400, y: 0, z: 1.7 }) => {
  const scene = plainScene('blast');
  scene.emitters = [{ ...defaultFireworks(), ...fireworks }];
  scene.receivers[0].positionMetres = receiver;
  return parseScene(scene);
};

test('a shell fired straight up against drag tops out at its burst height in its flight time', () => {
  const density = 1.225;
  const diameter = .1;
  const height = FIREWORKS.burstHeightMetresPerMetre * diameter;
  const { massKilograms, launchMetresPerSecond, flightSeconds } = shellFlight(diameter, height, density);
  assert.ok(Math.abs(massKilograms - .4) < 1e-12);
  const k = density * FIREWORKS.dragCoefficient * Math.PI * diameter ** 2 / 4 / (2 * massKilograms);
  let v = launchMetresPerSecond;
  let z = 0;
  let t = 0;
  const h = 1e-5;
  while (v > 0) {
    const a = -STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED - k * v * v;
    z += (v + a * h / 2) * h;
    v += a * h;
    t += h;
  }
  assert.ok(Math.abs(z - height) < .01, `${z} against ${height}`);
  assert.ok(Math.abs(t - flightSeconds) < 1e-3, `${t} against ${flightSeconds}`);
  assert.ok(launchMetresPerSecond > 80 && launchMetresPerSecond < 150, `${launchMetresPerSecond}`);
});

test('shells burst at Wharton’s 1.4 m per millimetre a flight time after their launch, within the field', () => {
  const scene = fireworksScene({ shellCount: 200, diameterSpread: 0 });
  const display = scene.emitters[0];
  const shells = fireworksShells(display, scene.air);
  assert.equal(shells.length, 200);
  const density = airDensityKilogramsPerCubicMetre(scene.air.pressureKpa * 1000, scene.air.temperatureCelsius);
  const ratios = shells.map(shell => shell.burstMetres.z / (FIREWORKS.burstHeightMetresPerMetre * shell.diameterMetres)).sort((a, b) => a - b);
  assert.ok(Math.abs(Math.log(ratios[100])) < .05, `${ratios[100]}`);
  for (const shell of shells) {
    assert.ok(Math.hypot(shell.mortarMetres.x - display.centreMetres.x, shell.mortarMetres.y - display.centreMetres.y) <= display.radiusMetres + 1e-9);
    const { flightSeconds } = shellFlight(shell.diameterMetres, shell.burstMetres.z, density);
    assert.ok(Math.abs(shell.burstSeconds - shell.launchSeconds - flightSeconds) < 1e-9);
  }
  assert.deepEqual(fireworksShells(display, scene.air), shells);
});

test('a crackling shell’s pops come within the crackle, near its burst, and a display keeps their count', () => {
  const scene = fireworksScene({ crackleShare: 1, shellCount: 4 });
  const display = scene.emitters[0];
  const [shell] = fireworksShells(display, scene.air);
  const pops = shellPops(shell, display, 1.2);
  assert.equal(pops.length, display.starCount * display.popsPerStar);
  const end = FIREWORKS.crackleDelaySeconds + FIREWORKS.crackleSeconds;
  for (const pop of pops) {
    const after = pop.startSeconds - shell.burstSeconds;
    assert.ok(after >= FIREWORKS.crackleDelaySeconds && after <= end);
    const reach = Math.hypot(pop.positionMetres.x - shell.burstMetres.x, pop.positionMetres.y - shell.burstMetres.y, pop.positionMetres.z - shell.burstMetres.z);
    assert.ok(reach < FIREWORKS.starMetresPerSecond * end + STANDARD_GRAVITY_METRES_PER_SECOND_SQUARED * end * end / 2);
  }
  const { events, pops: all } = fireworksBlasts(display, scene.air);
  assert.equal(events.length, 8);
  assert.equal(all.length, 4 * display.starCount * display.popsPerStar);
  assert.equal(emitterSources(display, scene.air).sources.length, events.length + all.length);
});

test('a 150 mm shell bursting 91 m up gives about Maglieri and Henderson’s 718 Pa at the ground below', () => {
  const scene = plainScene('blast');
  const mass = FIREWORKS.massKilogramsPerCubicMetre * .15 ** 3;
  scene.emitters = [{ ...defaultBlast(), positionMetres: { x: 0, y: 0, z: 91 }, chargeKilograms: FIREWORKS.burstShare * mass, secondaryShock: false, fireballDecibels: -60 }];
  scene.receivers[0].positionMetres = { x: 10, y: 0, z: 0 };
  const parsed = parseScene(scene);
  const { peakPa } = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.ok(Math.abs(peakPa / 718 - 1) < .1, `${peakPa}`);
});

test('a fireworks display renders finite samples, and its scene round-trips with its centre on the ground', () => {
  const scene = fireworksScene({ shellCount: 6, durationSeconds: 5 });
  const result = renderReceiver(prepareScene(scene), scene.receivers[0], scene);
  assert.ok(result.samples.every(Number.isFinite) && result.peakPa > 1, `${result.peakPa}`);
  assert.deepEqual(parseScene(JSON.parse(serializeScene(scene))), scene);
  const blast = defaultScene('blast');
  blast.emitters.push(defaultFireworks('fireworks-2'));
  assert.doesNotThrow(() => parseScene(blast));
  blast.emitters[1].centreMetres = { x: 0, y: 0, z: 5 };
  assert.throws(() => parseScene(blast), /centreMetres must lie on the ground/);
});
