import assert from 'node:assert/strict';
import test from 'node:test';
import { GROUND } from '../src/domain/constants.js';
import { fft } from '../src/domain/fft.js';
import { deygoutEdges, edgeField, fresnelIntegrals, knifeEdge, roundingDecibels } from '../src/domain/diffraction.js';
import { prepareScene, receiverPaths, renderReceiver } from '../src/domain/render.js';
import { inShadow, PATH_DIRECT, soundSpeedProfile } from '../src/domain/refraction.js';
import { defaultBlast, defaultReceiver, defaultScene, parseScene } from '../src/domain/scene.js';
import { buildPatch, decodePatch, encodePatch, mapTiles, patchMetres, patchRange, rangeBounds, terrainSurface, tilePlan } from '../src/domain/terrain.js';
import { syntheticTerrain } from './terrain-fixture.js';
import { meanPlaneFrame, shieldingEdges, shiftedProfile, terrainReflection } from '../src/domain/terrain-propagation.js';

const terrain = (height, options = {}) => syntheticTerrain(height, { echoes: false, echoLimit: 200, ...options });

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
  assert.ok(Math.abs(one[0].factor - 20 * Math.sqrt(2 * 1000 / (340 * 500 * 500))) < 1e-12);
  assert.equal(deygoutEdges({ ...common, terrain: terrainTwo }).length, 2);
});

test('a rounded ridge follows P.526 and its crest, costs more than a thin edge at high frequencies, and stays causal', () => {
  // T(m, 0) = 8.2·m^0.73; T(1, 1) = 20.2·1^b.
  assert.ok(Math.abs(roundingDecibels(.5, 0) - 8.2 * .5 ** .73) < 1e-12);
  assert.ok(Math.abs(roundingDecibels(1, 1) - 20.2) < 1e-9);
  const air = { ...defaultScene('blast').air, refraction: false };
  const edgeOver = width => {
    const surface = terrainSurface(terrain(x => 100 + 60 * Math.exp(-((x / width) ** 2))));
    const source = { x: -1200, y: 0, z: surface.heightAt(-1200, 0) + 2 };
    const receiver = { x: 1500, y: 0, z: surface.heightAt(1500, 0) + 1.7 };
    return shieldingEdges(soundSpeedProfile(air), surface, source, receiver)[0];
  };
  // The crest of 60·exp(−(x/w)²) has the radius w²/120.
  const broad = edgeOver(400);
  const radius = broad.radiusRatio * soundSpeedProfile(air).groundSpeed / Math.PI;
  assert.ok(Math.abs(radius / (400 ** 2 / 120) - 1) < .05, `${radius}`);
  const extra = (edge, frequency) => 20 * Math.log10(Math.hypot(...knifeEdge(edge.factor * Math.sqrt(frequency))) / Math.hypot(...edgeField(edge, frequency)));
  assert.ok(extra(broad, 1000) > 15 && extra(broad, 1000) > extra(broad, 30));
  const thin = { ...broad, radiusRatio: 0 };
  assert.equal(extra(thin, 1000), 0);
  // The rounding's response alone, with the thin edge divided out, barely reaches before its arrival.
  const size = 1 << 16;
  const rate = 48000;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let bin = 1; bin < size / 2; bin += 1) {
    const frequency = bin * rate / size;
    const [kRe, kIm] = knifeEdge(broad.factor * Math.sqrt(frequency));
    const [eRe, eIm] = edgeField(broad, frequency);
    const scale = kRe * kRe + kIm * kIm;
    re[bin] = (eRe * kRe + eIm * kIm) / scale;
    im[bin] = (eIm * kRe - eRe * kIm) / scale;
    re[size - bin] = re[bin];
    im[size - bin] = -im[bin];
  }
  re[0] = 1;
  fft(re, im, true);
  let before = 0;
  let total = 0;
  re.forEach((value, index) => { total += value * value; if (index > size / 2) before += value * value; });
  assert.ok(before / total < .05, `${before / total}`);
});

test('the surface reproduces a plane and its normal, relative to the ground at the origin', () => {
  const surface = terrainSurface(terrain((x, y) => 120 + .05 * x - .02 * y));
  assert.ok(Math.abs(surface.datumMetres - 120) < 1e-3);
  // Heights are stored in 16-bit steps of each patch's range.
  for (const [x, y] of [[0, 0], [700, -300], [-1500, 1200]]) assert.ok(Math.abs(surface.heightAt(x, y) - (.05 * x - .02 * y)) < 5e-3);
  const normal = surface.normalAt(300, 300);
  const length = Math.hypot(-.05, .02, 1);
  assert.ok(Math.abs(normal.x + .05 / length) < 1e-4 && Math.abs(normal.y - .02 / length) < 1e-4 && Math.abs(normal.z - 1 / length) < 1e-6);
});

test('a patch keeps its heights to half a step of its range in 16 bits, from millimetres to decimetres', () => {
  const cells = GROUND.terrain.patchCells;
  for (const range of [3, 8800]) {
    const values = Float32Array.from({ length: cells * cells }, (_, index) => -50 + index * range / (cells * cells) + .001 * Math.sin(index));
    const decoded = decodePatch(encodePatch(2, -1, values));
    let error = 0;
    values.forEach((value, index) => { error = Math.max(error, Math.abs(decoded[index] - value)); });
    assert.ok(error <= Math.max(range / 0xffff, GROUND.terrain.minimumHeightStepMetres) / 2 + 1e-4, `${range}: ${error}`);
  }
});

test('patches tile the scene frame from the origin, and a range covers the rectangle asked', () => {
  const side = patchMetres(30);
  assert.equal(side, 30 * GROUND.terrain.patchCells);
  const range = patchRange({ west: -100, east: side, south: 10, north: 2.5 * side }, 30);
  assert.deepEqual(range, { column0: -1, column1: 0, row0: 0, row1: 2 });
  assert.deepEqual(rangeBounds(range, 30), { west: -side, east: side, south: 0, north: 3 * side });
  // A patch's cells are centred half a cell in from its corner.
  const patch = buildPatch(1, -1, 30, (x, y) => x + 1000 * y);
  const decoded = decodePatch(patch);
  assert.ok(Math.abs(decoded[0] - (side + 15 + 1000 * (-side + 15))) < .2);
});

test('a patch is fetched within the tile budget at a zoom whose pixels are no larger than its cell', () => {
  const plan = tilePlan({ latitude: 61.5, longitude: 23.8 }, rangeBounds({ column0: 3, column1: 3, row0: -2, row1: -2 }, 25), 25);
  assert.ok(plan.tiles.count <= GROUND.terrain.maximumTileRequests);
  assert.ok(plan.zoom >= 1 && plan.zoom <= 15);
});

test('a sloping ground reflects as from a mirror image across its plane', () => {
  const profile = soundSpeedProfile({ temperatureCelsius: 15, lapseRateKelvinPerMetre: .0065, refraction: false });
  const surface = terrainSurface(terrain(x => 100 + .1 * x));
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
  const at = frequency => -20 * Math.log10(Math.hypot(...edgeField(edges[0], frequency)));
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

test('the map tiles cover the terrain rectangle, laid in the scene frame, within the request budget', () => {
  for (const extentMetres of [5000, 20000, 50000]) {
    const bounds = { west: -extentMetres / 2, east: extentMetres / 2, south: -extentMetres / 2, north: extentMetres / 2 };
    const { tiles } = mapTiles({ latitude: 63.0964, longitude: 29.8061, bounds });
    assert.ok(tiles.length <= GROUND.terrain.maximumTileRequests);
    const west = Math.min(...tiles.map(tile => tile.northWest.x));
    const east = Math.max(...tiles.map(tile => tile.northEast.x));
    const north = Math.max(...tiles.map(tile => tile.northWest.y));
    const south = Math.min(...tiles.map(tile => tile.southWest.y));
    assert.ok(west <= -extentMetres / 2 && east >= extentMetres / 2 && south <= -extentMetres / 2 && north >= extentMetres / 2);
    for (const tile of tiles) {
      assert.equal(tile.northEast.y, tile.northWest.y);
      assert.equal(tile.southWest.x, tile.northWest.x);
      assert.ok(tile.northEast.x > tile.northWest.x && tile.southWest.y < tile.northWest.y);
    }
  }
});
