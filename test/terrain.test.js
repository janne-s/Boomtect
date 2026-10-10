import assert from 'node:assert/strict';
import test from 'node:test';
import { deygoutEdges, fresnelIntegrals, knifeEdge } from '../src/domain/diffraction.js';
import { prepareScene, receiverPaths, renderReceiver } from '../src/domain/render.js';
import { inShadow, PATH_DIRECT, soundSpeedProfile } from '../src/domain/refraction.js';
import { defaultBlast, defaultReceiver, defaultScene, parseScene } from '../src/domain/scene.js';
import { buildHeightfield, curvatureDropMetres, decodeHeights, encodeHeights, terrainPlan, terrainSurface } from '../src/domain/terrain.js';
import { meanPlaneFrame, shieldingEdges, shiftedProfile, terrainReflection } from '../src/domain/terrain-propagation.js';

/** A captured terrain of `cells` × `cells` with heights from height(x, y) in metres above sea level. */
function terrain(height, { cells = 100, extentMetres = 4000 } = {}) {
  const cellMetres = extentMetres / cells;
  const values = new Float32Array(cells * cells);
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      values[row * cells + column] = height((column + .5 - cells / 2) * cellMetres, (row + .5 - cells / 2) * cellMetres);
    }
  }
  return { enabled: true, shielding: true, echoes: false, scattering: .5, echoCellMetres: 100, echoLimit: 200, place: '', names: [], latitude: 61.5, longitude: 23.8, extentMetres, cellMetres, zoom: 13, columns: cells, rows: cells, heights: encodeHeights(values) };
}

test('Fresnel integrals match tabulated values to 1e-6', () => {
  const table = [[.5, .4923442258, .0647324328], [1, .7798934004, .4382591474], [1.5, .4452611760, .6975049600], [2, .4882534061, .3434156784], [3, .6057207893, .4963129990], [-1, -.7798934004, -.4382591474]];
  for (const [x, c, s] of table) {
    const [computedC, computedS] = fresnelIntegrals(x);
    assert.ok(Math.abs(computedC - c) < 1e-6 && Math.abs(computedS - s) < 1e-6, `${x}: ${computedC} ${computedS}`);
  }
});

test('a thin edge passes half the field at grazing, all of it well clear, and 13.9 dB less at ν = 1', () => {
  assert.ok(Math.abs(Math.hypot(...knifeEdge(0)) - .5) < 1e-9);
  assert.ok(Math.abs(Math.hypot(...knifeEdge(-6)) - 1) < .1);
  // ITU-R P.526: J(ν) = 6.9 + 20 log10(sqrt((ν − 0.1)² + 1) + ν − 0.1) dB approximates the exact loss within about 0.5 dB.
  const itu = nu => 6.9 + 20 * Math.log10(Math.sqrt((nu - .1) ** 2 + 1) + nu - .1);
  for (const nu of [0, .5, 1, 2, 4]) assert.ok(Math.abs(-20 * Math.log10(Math.hypot(...knifeEdge(nu))) - itu(nu)) < .6, `ν ${nu}`);
  // Far into the shadow the field is (1 − i)/(2πν)·e^(−iπν²/2): the edge's extra path as a delay.
  const nu = 8;
  const [re, im] = knifeEdge(nu);
  const phase = -Math.PI * nu * nu / 2;
  const expected = [(Math.cos(phase) + Math.sin(phase)) / (2 * Math.PI * nu), (Math.sin(phase) - Math.cos(phase)) / (2 * Math.PI * nu)];
  assert.ok(Math.abs(re - expected[0]) < 2e-3 && Math.abs(im - expected[1]) < 2e-3);
});

test('Deygout finds the main ridge and one beside it, and nothing on a clear path', () => {
  const distances = Float64Array.from({ length: 99 }, (_, index) => (index + 1) * 10);
  const path = new Float64Array(99).fill(10);
  const ridge = (at, height) => index => (Math.abs(distances[index] - at) < 5 ? height : 0);
  const terrainOne = Float64Array.from(distances, (_, index) => ridge(500, 30)(index));
  const terrainTwo = Float64Array.from(distances, (_, index) => Math.max(ridge(500, 30)(index), ridge(200, 25)(index)));
  const common = { distances, path, total: 1000, startHeight: 10, endHeight: 10, speed: 340 };
  assert.equal(deygoutEdges({ ...common, terrain: new Float64Array(99) }).length, 0);
  const one = deygoutEdges({ ...common, terrain: terrainOne });
  assert.equal(one.length, 1);
  assert.ok(Math.abs(one[0] - 20 * Math.sqrt(2 * 1000 / (340 * 500 * 500))) < 1e-12);
  assert.equal(deygoutEdges({ ...common, terrain: terrainTwo }).length, 2);
});

test('the surface reproduces a plane and its normal, relative to the ground at the origin', () => {
  const surface = terrainSurface(terrain((x, y) => 120 + .05 * x - .02 * y));
  assert.ok(Math.abs(surface.datumMetres - 120) < 1e-3);
  for (const [x, y] of [[0, 0], [700, -300], [-1500, 1200]]) assert.ok(Math.abs(surface.heightAt(x, y) - (.05 * x - .02 * y)) < 1e-3);
  const normal = surface.normalAt(300, 300);
  const length = Math.hypot(-.05, .02, 1);
  assert.ok(Math.abs(normal.x + .05 / length) < 1e-6 && Math.abs(normal.y - .02 / length) < 1e-6 && Math.abs(normal.z - 1 / length) < 1e-6);
  assert.deepEqual([...decodeHeights(encodeHeights([1.5, -2, 3e3]), 3)], [1.5, -2, 3000]);
});

test('a capture plan stays within its tile budget and the heightfield follows the Earth’s curvature', () => {
  const plan = terrainPlan({ latitude: 61.5, longitude: 23.8, extentMetres: 5000, cellMetres: 25 });
  assert.ok(plan.tiles.count <= 36);
  assert.equal(plan.columns, 200);
  const values = buildHeightfield({ ...plan, columns: 4, rows: 4, cellMetres: 1250 }, () => 50);
  assert.ok(Math.abs(values[0] - (50 - curvatureDropMetres(Math.hypot(1875, 1875)))) < 1e-3);
});

test('a sloping ground reflects as from a mirror image across its plane', () => {
  const profile = soundSpeedProfile({ temperatureCelsius: 15, lapseRateKelvinPerMetre: .0065, refraction: false });
  const surface = terrainSurface(terrain((x, y) => 100 + .1 * x));
  const source = { x: -1000, y: 0, z: surface.heightAt(-1000, 0) + 50 };
  const receiver = { x: 200, y: 100, z: surface.heightAt(200, 100) + 2 };
  const path = terrainReflection(profile, surface, source, receiver);
  const n = surface.normalAt(200, 100);
  const height = p => (p.x - receiver.x) * n.x + (p.y - receiver.y) * n.y + (p.z - surface.heightAt(200, 100)) * n.z;
  const image = { x: source.x - 2 * height(source) * n.x, y: source.y - 2 * height(source) * n.y, z: source.z - 2 * height(source) * n.z };
  const distance = Math.hypot(receiver.x - image.x, receiver.y - image.y, receiver.z - image.z);
  assert.ok(Math.abs(path.seconds - distance / profile.groundSpeed) < 1e-9);
  assert.ok(Math.abs(path.groundSine - (height(source) + height(receiver)) / distance) < 1e-9);
});

function blastScene(terrainValue, { refraction = true, receiverX = 1500, ground = true } = {}) {
  const base = defaultScene('blast');
  return parseScene({
    ...base,
    air: { ...base.air, refraction, turbulenceStrength: 0 },
    ground: { ...base.ground, enabled: ground },
    terrain: terrainValue,
    emitters: [{ ...defaultBlast(), chargeKilograms: .1, positionMetres: { x: -1200, y: 0, z: 2 } }],
    receivers: [{ ...defaultReceiver('mic', 'Mic'), positionMetres: { x: receiverX, y: 0, z: 1.7 } }]
  });
}

test('level terrain at any height sounds exactly like no terrain', () => {
  const plain = renderReceiver(prepareScene(blastScene(null)), blastScene(null).receivers[0], blastScene(null));
  const level = blastScene(terrain(() => 245));
  const raised = renderReceiver(prepareScene(level), level.receivers[0], level);
  assert.equal(raised.samples.length, plain.samples.length);
  let difference = 0;
  plain.samples.forEach((value, index) => { difference = Math.max(difference, Math.abs(value - raised.samples[index])); });
  assert.ok(difference < plain.peakPa * 1e-9, `${difference}`);
});

test('a ridge between a blast and a microphone shields it, and less so at low frequencies', () => {
  const ridge = terrain((x) => 100 + 60 * Math.exp(-((x / 120) ** 2)));
  const scene = blastScene(ridge, { refraction: false, ground: false });
  const surface = terrainSurface(scene.terrain);
  const profile = soundSpeedProfile(scene.air);
  const source = { x: -1200, y: 0, z: surface.heightAt(-1200, 0) + 2 };
  const receiver = { x: 1500, y: 0, z: surface.heightAt(1500, 0) + 1.7 };
  const edges = shieldingEdges(profile, surface, source, receiver);
  assert.equal(edges.length, 1);
  const paths = receiverPaths(prepareScene(scene), scene.receivers[0], scene);
  assert.equal(paths.edgeCount[0], 1);
  const shielded = renderReceiver(prepareScene(scene), scene.receivers[0], scene);
  const open = blastScene(terrain(() => 100), { refraction: false, ground: false });
  const clear = renderReceiver(prepareScene(open), open.receivers[0], open);
  const drop = 20 * Math.log10(clear.peakPa / shielded.peakPa);
  // The pulse's energy lies around 50–500 Hz, where the edge costs 10–25 dB.
  const at = frequency => -20 * Math.log10(Math.hypot(...knifeEdge(edges[0] * Math.sqrt(frequency))));
  assert.ok(drop > at(30) && drop < at(2000), `drop ${drop} dB, edge ${at(30)}–${at(2000)} dB`);
  shielded.samples.forEach(value => assert.ok(Number.isFinite(value)));
});

test('with ground reflection, a ridge shields the reflected sound as well as the direct sound', () => {
  const ridge = blastScene(terrain((x) => 100 + 60 * Math.exp(-((x / 120) ** 2))), { refraction: false });
  const paths = receiverPaths(prepareScene(ridge), ridge.receivers[0], ridge);
  assert.equal(paths.kind[1], 1);
  assert.equal(paths.edgeCount[1], paths.edgeCount[0]);
  const open = blastScene(terrain(() => 100), { refraction: false });
  const shielded = renderReceiver(prepareScene(ridge), ridge.receivers[0], ridge);
  const clear = renderReceiver(prepareScene(open), open.receivers[0], open);
  const energy = result => result.samples.reduce((sum, value) => sum + value * value, 0);
  assert.ok(energy(shielded) < energy(clear));
});

test('channels over rising terrain stay above the ground and reach it', async () => {
  const { lightningEmitterFlashes } = await import('../src/domain/lightning.js');
  const { defaultLightning, defaultStorm } = await import('../src/domain/scene.js');
  const { stormFlashes } = await import('../src/domain/storm.js');
  const surface = terrainSurface(terrain((x, y) => 100 + 120 * Math.sin(x / 400) * Math.cos(y / 500) + .04 * x));
  const flashes = [...lightningEmitterFlashes({ ...defaultLightning(), branchCount: 24, branchDepth: 3 }, surface), ...stormFlashes({ ...defaultStorm(), radiusMetres: 2000 }, surface)];
  for (const flash of flashes) {
    for (const channel of flash.channels) {
      for (const point of channel.points) assert.ok(point.z >= surface.heightAt(point.x, point.y) - 1e-6);
    }
    if (flash.type === 'cloud-to-ground') {
      const base = flash.channels[0].points[0];
      assert.ok(Math.abs(base.z - surface.heightAt(base.x, base.y)) < 1e-9);
    }
  }
});

test('the mean ground plane of a sloping plane measures heights at right angles to it', () => {
  // Ground z = 0.05·x; a point 100 m above it is 100/√(1 + 0.05²) m from the plane.
  const heightAt = x => .05 * x;
  const profile = { groundSpeed: 340, gradient: -.004 };
  const a = { x: -5000, y: 0, z: heightAt(-5000) + 100 };
  const b = { x: 5000, y: 0, z: heightAt(5000) + 1.7 };
  const frame = meanPlaneFrame(profile, heightAt, a, b);
  const tilt = Math.hypot(1, .05);
  assert.ok(Math.abs(frame.from.z - 100 / tilt) < 1e-9);
  assert.ok(Math.abs(frame.to.z - 1.7 / tilt) < 1e-9);
  assert.ok(Math.abs(frame.profile.groundSpeed - (340 - .004 * 250)) < 1e-9);
});

test('a microphone on a hilltop hears a source that its own ground alone would put in the refraction shadow', () => {
  // A hill 300 m high and 3 km across under the microphone, on level ground.
  const hill = (x, y) => 100 + Math.max(0, 300 * (1 - Math.hypot(x, y) / 1500));
  const scene = defaultScene('blast');
  scene.emitters = [{ ...defaultBlast(), positionMetres: { x: -9500, y: 0, z: 500 } }];
  scene.receivers[0].positionMetres = { x: 0, y: 0, z: 1.7 };
  scene.terrain = { ...terrain(hill, { cells: 200, extentMetres: 20000 }), shielding: false };
  const parsed = parseScene(scene);
  const paths = receiverPaths(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.equal(paths.kind[0], PATH_DIRECT);
  // Heights from the ground under the microphone alone: 200 m and 1.7 m, which is in the shadow.
  const profile = soundSpeedProfile(parsed.air);
  const surface = terrainSurface(parsed.terrain);
  const summit = surface.heightAt(0, 0);
  assert.ok(inShadow(shiftedProfile(profile, summit), { x: -9500, y: 0, z: surface.heightAt(-9500, 0) + 500 - summit }, { x: 0, y: 0, z: 1.7 }));
});
