import assert from 'node:assert/strict';
import test from 'node:test';
import { ROOM_EXPLOSION } from '../src/domain/constants.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { defaultRoomExplosion, defaultScene, parseScene, readScene, serializeScene } from '../src/domain/scene.js';
import { breakPulse, dustVentedBar, gasVentedBar, ringHz, roomExplosion, roomPressures, roomRoarTailSeconds, turbulenceFactor } from '../src/domain/room-explosion.js';
import { plainScene } from './plain-scene.js';

const STANDARD_AIR = { pressureKpa: 101.325, temperatureCelsius: 15 };
const near = (value, expected, share) => Math.abs(value / expected - 1) < share;

test('a room explosion opens in Blast mode, reads unknown choices as defaults, and its scene round-trips', () => {
  const room = defaultRoomExplosion();
  const scene = { ...defaultScene('blast'), emitters: [room] };
  assert.deepEqual(readScene(JSON.parse(serializeScene(parseScene(scene)))).emitters, [room]);
  const odd = readScene({ ...JSON.parse(serializeScene(parseScene(scene))), emitters: [{ kind: 'roomExplosion', id: 'r', material: 'butter', roomCubicMetres: 1e9 }] }).emitters[0];
  assert.equal(odd.material, room.material);
  assert.equal(odd.roomCubicMetres, 1e5);
});

test('the turbulence factor and vent area match the building example of NFPA 68 Annex I', () => {
  const factor = turbulenceFactor({ hydraulicMetres: 9.76, ventMetres: 4.1, burningMetresPerSecond: .4, pressureBar: .047 });
  assert.ok(near(factor, 5.79, .01), `λ ${factor}`);
  const ventSquareMetres = 2155 * ROOM_EXPLOSION.gasCoefficient * factor * .4 / Math.sqrt(.047);
  assert.ok(near(ventSquareMetres, 508, .03), `${ventSquareMetres} m²`);
});

test('the dust pressure inverts NFPA 68 equation 8.2.1.1', () => {
  const [cubicMetres, kSt, maximumBar, staticBar, pressureBar] = [1000, 150, 9, .1, .68];
  const ventSquareMetres = 1e-4 * (1 + 1.54 * staticBar ** (4 / 3)) * kSt * cubicMetres ** .75 * Math.sqrt(maximumBar / pressureBar - 1);
  assert.ok(near(dustVentedBar({ cubicMetres, ventSquareMetres, kSt, maximumBar, staticBar }), pressureBar, 1e-9));
});

test('an empty room is near Cooper et al. (1986) vessel A, and its ring near their 50 Hz', () => {
  const side = Math.cbrt(.76);
  const vent = .76 ** (2 / 3) / 9.2;
  const { pressureBar } = gasVentedBar({ surfaceSquareMetres: 6 * side * side, ventSquareMetres: vent, hydraulicMetres: side, burningMetresPerSecond: .4 });
  const empty = pressureBar * ROOM_EXPLOSION.emptyTurbulenceShare ** 2;
  assert.ok(empty > .031 / 2.5 && empty < .031 * 2.5, `${empty} bar against 0.031`);
  assert.ok(near(ringHz(.76, vent, .012), 50, .05));
});

test('a window breaks with the stored compression as a monopole, the walls cap the pressure, and the external explosion runs at half of it', () => {
  const room = { ...defaultRoomExplosion(), ventSquareMetres: 2 };
  const pressures = roomPressures(room);
  assert.equal(pressures.openPa, 5000);
  assert.ok(pressures.wallsFail);
  assert.equal(pressures.insidePa, room.structureKilopascals * 1000);
  const flow = .7 * 2 * Math.sqrt(2 * 5000 / 1.2);
  assert.ok(near(breakPulse(room, pressures, STANDARD_AIR).peakPaMetres, 1.2 * flow / (4 * Math.PI * .005), 1e-9));
  const explosion = roomExplosion(room, STANDARD_AIR);
  assert.ok(near(explosion.external.sourcePa, pressures.insidePa / 2, 1e-12));
  const empty = roomPressures({ ...room, interior: 'empty', ventSquareMetres: 6 });
  assert.ok(!empty.wallsFail && empty.insidePa < pressures.insidePa && empty.burnSeconds > pressures.burnSeconds);
  assert.equal(roomPressures({ ...room, ventStrength: 'open' }).openPa, 0);
});

test('smoke gas in Rosberg\'s (2001) container builds a few hundred pascals over seconds', () => {
  const pressures = roomPressures({ ...defaultRoomExplosion(), material: 'smokeGas', roomCubicMetres: 26.6, ventSquareMetres: 1.5, ventStrength: 'open', interior: 'furnished' });
  assert.ok(pressures.insidePa > 100 && pressures.insidePa < 500, `${pressures.insidePa} Pa`);
  assert.ok(pressures.burnSeconds > 1 && pressures.burnSeconds < 5, `${pressures.burnSeconds} s`);
});

test('a rendered room explosion is finite and loudest after its window breaks', () => {
  const scene = plainScene('blast');
  scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
  scene.ground = { ...scene.ground, enabled: false };
  scene.emitters = [{ ...defaultRoomExplosion(), positionMetres: { x: 0, y: 0, z: 0 } }];
  scene.receivers[0].positionMetres = { x: 200, y: 0, z: 0 };
  const value = parseScene(scene);
  const result = renderReceiver(prepareScene(value), value.receivers[0], value);
  assert.ok(result.samples.every(Number.isFinite));
  let loudest = 0;
  result.samples.forEach((sample, index) => { if (Math.abs(sample) > Math.abs(result.samples[loudest])) loudest = index; });
  const seconds = result.startSeconds + loudest / result.sampleRate - 200 / 340.3;
  assert.ok(seconds >= roomPressures(value.emitters[0]).openSeconds - .01, `loudest ${seconds} s after ignition`);
});

test('a kitchen\'s roar ends within the apartment recordings\' half second, not a fireball\'s', () => {
  const kitchen = { ...defaultRoomExplosion(), material: 'propane', roomCubicMetres: 40 };
  assert.equal(kitchen.fireballSecondsPerSixthRootKilogram, ROOM_EXPLOSION.roarSecondsPerSixthRootKilogram);
  const seconds = roomRoarTailSeconds(kitchen);
  assert.ok(seconds > .4 && seconds < .7, `${seconds.toFixed(2)} s`);
});

test('a vent and a wall that give way crack, louder through a bigger vent, darker through a door, and a strong vent lets less burn outside', () => {
  const explosion = room => roomExplosion({ ...defaultRoomExplosion(), ...room }, STANDARD_AIR);
  const window = explosion({});
  assert.ok(window.pressures.wallBreaksLater && window.wall.peakPaMetres > 0);
  assert.equal(window.cracks.length, 2);
  assert.ok(explosion({ ventSquareMetres: 6 }).cracks[0].paMetres > 5 * explosion({ ventSquareMetres: .5 }).cracks[0].paMetres);
  assert.ok(explosion({ ventStrength: 'door' }).cracks[0].tilt < window.cracks[0].tilt);
  assert.equal(explosion({ ventStrength: 'open' }).cracks.length, 1);
  assert.ok(explosion({ ventStrength: 'window' }).external.peakPaMetres < explosion({ ventStrength: 'open' }).external.peakPaMetres);
  assert.equal(explosion({ crackDecibels: -60 }).cracks.length, 0);
  const held = explosion({ structureKilopascals: 100, ventSquareMetres: 6 });
  assert.ok(!held.pressures.wallsFail && held.wall === null);
});
