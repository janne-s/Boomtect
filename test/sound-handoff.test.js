import assert from 'node:assert/strict';
import test from 'node:test';
import { ambisonicDirection, encodeDirection } from '../src/shared/domain/ambisonics.js';
import { readHandoff } from '../src/shared/domain/handoff.js';
import { prepareScene, renderReceiver } from '../src/domain/render.js';
import { parseScene } from '../src/domain/scene.js';
import { arrivalDistance, fieldArrival, soundHandoff } from '../src/domain/sound-handoff.js';
import { plainScene } from './plain-scene.js';
import { syntheticTerrain } from './terrain-fixture.js';

function planeWave(east, north, up, samples = [0, 1, -.5, .25]) {
  const gains = encodeDirection(...ambisonicDirection(east, north, up), 1);
  return Array.from(gains, gain => Float32Array.from(samples, sample => sample * gain));
}

test('a single sound arrives from its own direction, in compass degrees and elevation', () => {
  const cases = [[[0, 1, 0], 0, 0], [[1, 0, 0], 90, 0], [[0, -1, 0], 180, 0], [[-1, 0, 0], 270, 0], [[1, 0, 1], 90, 45]];
  for (const [direction, azimuth, elevation] of cases) {
    const found = fieldArrival(planeWave(...direction));
    assert.ok(Math.abs(found.azimuthDegrees - azimuth) < 1e-6, `${direction}`);
    assert.ok(Math.abs(found.elevationDegrees - elevation) < 1e-6, `${direction}`);
  }
  assert.equal(fieldArrival(planeWave(0, 1, 0).slice(0, 1)), null);
  assert.equal(fieldArrival(planeWave(0, 1, 0, [0, 0])), null);
});

test('two sounds give the direction of the stronger, weighted by energy', () => {
  const east = planeWave(1, 0, 0, [0, 1, 0, 0]);
  const north = planeWave(0, 1, 0, [0, 0, 0, .5]);
  const found = fieldArrival(east.map((channel, index) => channel.map((value, sample) => value + north[index][sample])));
  // Energy 1 from the east and .25 from the north: atan(1 / .25) from north.
  assert.ok(Math.abs(found.azimuthDegrees - Math.atan2(1, .25) * 180 / Math.PI) < 1e-6);
});

test('the distance is the energy-weighted length of the paths', () => {
  assert.equal(arrivalDistance({ count: 2, levels: [0, 0], metres: [100, 300], kinds: [0, 1] }), 200);
  assert.ok(Math.abs(arrivalDistance({ count: 2, levels: [0, -10], metres: [100, 1200], kinds: [0, 0] }) - 200) < 1e-9);
  assert.equal(arrivalDistance({ count: 0, levels: [], metres: [], kinds: [] }), null);
});

test('a blast west of its microphone is handed off from the west at its distance, with what the sound holds', () => {
  const scene = parseScene(plainScene('blast'));
  const [receiver] = scene.receivers;
  const result = renderReceiver(prepareScene(scene), receiver, scene);
  const handoff = soundHandoff({
    scene, receiver, channels: result.channels, arrivals: result.arrivals, fullScalePa: 20, startSeconds: result.startSeconds,
    file: 'mic-1.wav', terrainEchoes: false, appVersion: '0.67.0', id: 'x', createdAt: '2026-10-12T00:00:00.000Z'
  });
  assert.deepEqual(readHandoff(handoff), handoff);
  const blast = scene.emitters[0].positionMetres;
  const bearing = (Math.atan2(blast.x - receiver.positionMetres.x, blast.y - receiver.positionMetres.y) * 180 / Math.PI + 360) % 360;
  const metres = Math.hypot(blast.x - receiver.positionMetres.x, blast.y - receiver.positionMetres.y);
  assert.ok(Math.abs(handoff.arrival.azimuthDegrees - bearing) < 2, `${handoff.arrival.azimuthDegrees} vs ${bearing}`);
  assert.ok(Math.abs(handoff.arrival.elevationDegrees - Math.atan2(blast.z - receiver.positionMetres.z, metres) * 180 / Math.PI) < .5);
  assert.ok(Math.abs(handoff.arrival.distanceMetres - metres) < metres * .02, `${handoff.arrival.distanceMetres} vs ${metres}`);
  assert.deepEqual(handoff.listener.positionMetres, { east: receiver.positionMetres.x, north: receiver.positionMetres.y });
  assert.deepEqual(handoff.place, { name: 'Koli', latitudeDegrees: scene.place.latitude, longitudeDegrees: scene.place.longitude, datumMetres: null });
  assert.ok(handoff.content.includes.includes('air-absorption') && handoff.content.includes.includes('ground'));
  assert.deepEqual(handoff.content.excludes, ['terrain-echoes']);
});

test('terrain echoes are named as held or left out', () => {
  const scene = parseScene({ ...plainScene('blast'), terrain: syntheticTerrain(() => 100) });
  const args = { scene, receiver: scene.receivers[0], channels: [], arrivals: { count: 0, levels: [], metres: [], elevations: [], kinds: [] }, fullScalePa: 1, startSeconds: 0, file: null, appVersion: '', id: '', createdAt: '' };
  const held = soundHandoff({ ...args, terrainEchoes: true });
  assert.ok(held.content.includes.includes('terrain-echoes'));
  assert.deepEqual(held.content.excludes, []);
  assert.equal(held.place.datumMetres, 100);
  assert.deepEqual(soundHandoff({ ...args, terrainEchoes: false }).content.excludes, ['terrain-echoes']);
  assert.equal(held.arrival, null);
  assert.equal(soundHandoff({ ...args, terrainEchoes: false, placement: 'none' }).placement, 'none');
  assert.equal(held.placement, 'listener-and-source');
});

test('a boom from above keeps its elevation, which the field at the ground loses', () => {
  const scene = parseScene(plainScene('sonic'));
  const [receiver] = scene.receivers;
  const result = renderReceiver(prepareScene(scene), receiver, scene);
  assert.ok(Math.abs(fieldArrival(result.channels).elevationDegrees) < 5);
  const handoff = soundHandoff({ scene, receiver, channels: result.channels, arrivals: result.arrivals, fullScalePa: 1, startSeconds: 0, file: null, terrainEchoes: false, appVersion: '', id: '', createdAt: '' });
  assert.ok(handoff.arrival.elevationDegrees > 20, `${handoff.arrival.elevationDegrees}`);
});
