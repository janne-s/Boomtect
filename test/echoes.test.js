import assert from 'node:assert/strict';
import test from 'node:test';
import { PROPAGATION } from '../src/domain/constants.js';
import { prepareScene, receiverPaths, renderReceiver } from '../src/domain/render.js';
import { PATH_ECHO, PATH_SCATTER } from '../src/domain/refraction.js';
import { defaultBlast, defaultFlight, parseScene, TERRAIN_DEFAULTS } from '../src/domain/scene.js';
import { sourceTable } from '../src/domain/source-table.js';
import { encodeHeights, terrainSurface } from '../src/domain/terrain.js';
import { clearBetween, echoField, echoPaths, echoSurface, sourceCells, specularPoints } from '../src/domain/terrain-echoes.js';
import { plainScene } from './plain-scene.js';

function terrain(height, { cells = 100, extentMetres = 4000, ...settings } = {}) {
  const cellMetres = extentMetres / cells;
  const values = new Float32Array(cells * cells);
  for (let row = 0; row < cells; row += 1) {
    for (let column = 0; column < cells; column += 1) {
      values[row * cells + column] = height((column + .5 - cells / 2) * cellMetres, (row + .5 - cells / 2) * cellMetres);
    }
  }
  return { ...TERRAIN_DEFAULTS, ...settings, place: '', names: [], latitude: 61.5, longitude: 23.8, extentMetres, cellMetres, zoom: 13, columns: cells, rows: cells, heights: encodeHeights(values) };
}

const pointSource = (position, { amplitude = 1, emission = 0 } = {}) => ({
  positionMetres: position, direction: null, elementMetres: 0, emissionSeconds: emission, amplitudePaMetres: amplitude,
  pulse: 'nwave', durationSeconds: .01, decay: 0, spanSeconds: .01, linearRadiusMetres: 1, weakShock: null
});

const homogeneous = { groundSpeed: 340, gradient: 0 };
const mirror = (point, normal, offset) => {
  const above = point.x * normal.x + point.y * normal.y + point.z * normal.z - offset;
  return { x: point.x - 2 * above * normal.x, y: point.y - 2 * above * normal.y, z: point.z - 2 * above * normal.z };
};

test('the specular point on a sloping plane gives its image path to 1e-6 m, with no focusing', () => {
  // Ground z = 0.2·x + 0.05·y + 300 m.
  const surface = terrainSurface(terrain((x, y) => .2 * x + .05 * y + 300));
  const echo = echoSurface(surface);
  const S = { x: -800, y: 300, z: 1500 };
  const R = { x: 600, y: -200, z: 900 };
  const length = Math.hypot(.2, .05, 1);
  const normal = { x: -.2 / length, y: -.05 / length, z: 1 / length };
  const image = mirror(S, normal, (300 - surface.datumMetres) / length);
  const points = specularPoints(echo, S, R);
  assert.equal(points.length, 1);
  const [{ point, focusing }] = points;
  const path = Math.hypot(S.x - point.x, S.y - point.y, S.z - point.z) + Math.hypot(R.x - point.x, R.y - point.y, R.z - point.z);
  assert.ok(Math.abs(path - Math.hypot(R.x - image.x, R.y - image.y, R.z - image.z)) < 1e-6, `${path}`);
  assert.ok(Math.abs(focusing - 1) < 1e-6, `${focusing}`);
});

test('an echo from a slope beyond level ground arrives along its image path, 2 000 m', () => {
  // A 56° slope rising from x = 800 m; the point P on it reflects S to R by construction.
  const surface = terrainSurface(terrain(x => Math.max(0, 1.5 * (x - 800))));
  const P = { x: 1000, y: 0, z: 300 };
  const normalAngle = Math.atan2(1, -1.5);
  const toward = (angle, metres) => ({ x: P.x + metres * Math.cos(angle), y: 0, z: P.z + metres * Math.sin(angle) });
  const S = toward(normalAngle + Math.PI / 6, 1200);
  const R = toward(normalAngle - Math.PI / 6, 800);
  const field = echoField(surface, homogeneous, R, { scattering: 0, limit: 10 });
  const paths = echoPaths(field, S);
  // The strongest echo; the rounded foot of the slope adds a weaker one, convex and so spread out.
  assert.ok(paths.every(path => path.kind === PATH_ECHO));
  assert.ok(paths.slice(1).every(path => path.spreadMetres > 3 * 2000));
  assert.ok(Math.abs(paths[0].seconds - 2000 / 340) < 1e-9, `${paths[0].seconds * 340}`);
  assert.ok(Math.abs(paths[0].spreadMetres - 2000) < 1e-6);
  assert.ok(Math.abs(paths[0].groundSine - Math.cos(Math.PI / 6)) < 1e-9);
});

test('on level terrain the only specular point is the ground reflection, which is left to the ground', () => {
  const scene = plainScene('blast');
  scene.terrain = terrain(() => 120, { scattering: 0 });
  const prepared = prepareScene(scene);
  const paths = receiverPaths(prepared, scene.receivers[0], scene);
  const kinds = paths.kind.slice(0, paths.count);
  assert.ok(!kinds.includes(PATH_ECHO) && !kinds.includes(PATH_SCATTER));
});

test('scattered echoes from a level plane add up to the Lambertian integral within 3 %', () => {
  const surface = terrainSurface(terrain(() => 0, { cells: 200, extentMetres: 4000 }));
  const S = { x: -300, y: 0, z: 400 };
  const R = { x: 300, y: 100, z: 50 };
  const field = echoField(surface, homogeneous, R, { scattering: 1, limit: 100000 });
  let sum = 0;
  for (const path of echoPaths(field, S)) {
    assert.equal(path.kind, PATH_SCATTER);
    sum += path.spreadMetres ** -2;
  }
  // The same law integrated finely over the plane, outside the ground under the receiver:
  // ∫ cosθᵢ·cosθₒ / (π r₁² r₂²) dA.
  const step = 2;
  const exclusion = 1.5 * echoSurface(surface).spacing;
  let integral = 0;
  for (let x = -2000 + step / 2; x < 2000; x += step) {
    for (let y = -2000 + step / 2; y < 2000; y += step) {
      if (Math.hypot(x - R.x, y - R.y) < exclusion) continue;
      const r1 = Math.hypot(x - S.x, y - S.y, S.z);
      const r2 = Math.hypot(x - R.x, y - R.y, R.z);
      integral += (S.z / r1) * (R.z / r2) / (Math.PI * r1 * r1 * r2 * r2) * step * step;
    }
  }
  assert.ok(Math.abs(sum / integral - 1) < .03, `${sum} vs ${integral}`);
});

test('source cells keep the total energy and keep strokes apart', () => {
  const sources = sourceTable([
    pointSource({ x: 10, y: 10, z: 1010 }, { amplitude: 3 }),
    pointSource({ x: 50, y: 20, z: 1050 }, { amplitude: 4 }),
    pointSource({ x: 50, y: 20, z: 1050 }, { amplitude: 2, emission: 2 * PROPAGATION.echoCellSeconds }),
    pointSource({ x: 250, y: 20, z: 1050 }, { amplitude: 1 })
  ]);
  const cells = sourceCells(sources, 100);
  assert.equal(cells.length, 3);
  assert.ok(Math.abs(cells.amplitudePaMetres[0] - 5) < 1e-12);
  assert.ok(Math.abs(cells.x[0] - (9 * 10 + 16 * 50) / 25) < 1e-9);
  let total = 0;
  for (let cell = 0; cell < cells.length; cell += 1) total += cells.amplitudePaMetres[cell] ** 2;
  assert.ok(Math.abs(total - 30) < 1e-9);
  assert.equal(cells.emissionSeconds[1], 2 * PROPAGATION.echoCellSeconds);
  // The later stroke shares its place, and the echo geometry traced from it, with the first.
  assert.equal(cells.places.length, 2);
  assert.equal(cells.place[0], cells.place[1]);
  assert.ok(Math.abs(cells.places.x[0] - (9 * 10 + 16 * 50 + 4 * 50) / 29) < 1e-9);
});

test('the horizon test agrees with tracing the line in at least 98 % of facet–point pairs over hills', () => {
  const hills = (x, y) => 200 + 180 * Math.sin(x / 450) * Math.cos(y / 380) + 90 * Math.sin((x + y) / 210);
  const surface = terrainSurface(terrain(hills, { cells: 150, extentMetres: 6000 }));
  const echo = echoSurface(surface);
  const datum = surface.datumMetres;
  let agree = 0;
  const trials = 2000;
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let trial = 0; trial < trials; trial += 1) {
    const point = { x: (random() - .5) * 5800, y: (random() - .5) * 5800, z: 0 };
    point.z = hills(point.x, point.y) - datum + random() * 600;
    const R = { x: point.x, y: point.y, z: point.z };
    const field = echoField(surface, homogeneous, R, { scattering: 1, limit: 1 });
    const facet = Math.floor(random() * echo.count);
    const facetPoint = { x: echo.centreX(facet), y: echo.centreY(facet), z: echo.heights[facet] };
    if (Math.hypot(facetPoint.x - R.x, facetPoint.y - R.y) < 1.5 * echo.spacing) { agree += 1; continue; }
    const traced = clearBetween(echo, facetPoint, R);
    const facing = (-echo.gradientX[facet] * (R.x - facetPoint.x) - echo.gradientY[facet] * (R.y - facetPoint.y) + (R.z - facetPoint.z)) > 0;
    const listed = field.visible.includes(facet);
    if (listed === (traced && facing)) agree += 1;
  }
  assert.ok(agree / trials >= .98, `${agree} of ${trials}`);
});

test('echoes over hills render finite, reproducible, and later than the direct sound', () => {
  const hills = (x, y) => 150 + 250 * Math.exp(-((x - 1200) ** 2 + y ** 2) / 5e5);
  const scene = plainScene('blast');
  scene.emitters = [{ ...defaultBlast(), positionMetres: { x: -300, y: 0, z: 2 } }];
  scene.receivers[0].positionMetres = { x: 300, y: 0, z: 1.7 };
  scene.terrain = terrain(hills, { scattering: .5, echoLimit: 100 });
  const parsed = parseScene(scene);
  const prepared = prepareScene(parsed);
  const paths = receiverPaths(prepared, parsed.receivers[0], parsed);
  const echoes = [];
  let direct = Infinity;
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.kind[index] === PATH_ECHO || paths.kind[index] === PATH_SCATTER) echoes.push(paths.seconds[index]);
    else direct = Math.min(direct, paths.seconds[index]);
  }
  assert.ok(echoes.length > 10);
  assert.ok(echoes.every(seconds => seconds > direct));
  const first = renderReceiver(prepared, parsed.receivers[0], parsed);
  const again = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  assert.ok(first.samples.every(Number.isFinite));
  assert.deepEqual(first.samples, again.samples);
  const quiet = renderReceiver(prepareScene({ ...parsed, terrain: { ...parsed.terrain, echoes: false } }), parsed.receivers[0], parsed);
  const energy = samples => samples.reduce((sum, value) => sum + value * value, 0);
  assert.ok(energy(first.samples) > energy(quiet.samples));
});

test('merged scattered echoes do not fall on a regular grid of arrival times, which would sound as a tone', () => {
  const hills = (x, y) => 200 + 180 * Math.sin(x / 450) * Math.cos(y / 380) + 90 * Math.sin((x + y) / 210);
  const scene = plainScene('thunder');
  scene.terrain = terrain(hills, { cells: 120, extentMetres: 6000, scattering: 1 });
  const parsed = parseScene(scene);
  const prepared = prepareScene(parsed);
  const paths = receiverPaths(prepared, parsed.receivers[0], parsed);
  // Phases of the arrivals within the merging bin: spread evenly, their mean vector is short.
  let re = 0;
  let im = 0;
  let count = 0;
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.kind[index] !== PATH_SCATTER) continue;
    const phase = 2 * Math.PI * paths.seconds[index] / PROPAGATION.scatterBinSeconds;
    re += Math.cos(phase);
    im += Math.sin(phase);
    count += 1;
  }
  assert.ok(count > 500, `${count}`);
  assert.ok(Math.hypot(re, im) / count < .1, `${Math.hypot(re, im) / count}`);
});

test('a blast on rigid ground hears its echoes with the ground images at both ends, close to +12 dB', () => {
  // A ridge 1.5 km away; blast 1 m and microphone 1.7 m above level ground, so both images merge with the echo.
  const ridge = x => Math.max(0, .4 * (x - 1500));
  const echoEnergy = groundEnabled => {
    const scene = plainScene('blast');
    scene.terrain = terrain(ridge, { cells: 120, extentMetres: 6000, scattering: 1 });
    scene.air = { ...scene.air, refraction: false, absorption: false, turbulenceStrength: 0 };
    scene.ground = { ...scene.ground, enabled: groundEnabled, type: 'rigid' };
    scene.emitters[0] = { ...scene.emitters[0], secondaryShock: false, fireballDecibels: -60 };
    scene.receivers[0].positionMetres = { x: -400, y: 0, z: 1.7 };
    const parsed = parseScene(scene);
    const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
    // From well after the direct sound and its tail, before which no echo can arrive.
    const from = Math.round((2.5 - result.startSeconds) * result.sampleRate);
    return result.samples.slice(from).reduce((sum, value) => sum + value * value, 0);
  };
  const gain = 10 * Math.log10(echoEnergy(true) / echoEnergy(false));
  assert.ok(gain > 10.5 && gain < 12.1, `${gain}`);
});

test('an echo whose legs pass through the refraction shadow keeps the shadow floor on each leg', () => {
  // A low slope from 3 km on in ISA air, at most 20 m high: from 1 m and 1.7 m above level ground both
  // legs to it lie in the shadow. Only its echoes count, not the level ground's near the two ends.
  const surface = terrainSurface(terrain(x => Math.max(0, .02 * (x - 3000)), { cells: 120, extentMetres: 8000 }));
  const profile = { groundSpeed: 340.3, gradient: -.0039 };
  const R = { x: -500, y: 0, z: 1.7 };
  const S = { x: 0, y: 0, z: 1 };
  const fromSlope = paths => paths.filter(path => path.metres > 5500);
  const strongest = paths => Math.max(0, ...fromSlope(paths).map(path => 1 / path.spreadMetres));
  const dropped = echoPaths(echoField(surface, profile, R, { scattering: 1, limit: 2000 }), S);
  assert.equal(fromSlope(dropped).length, 0);
  const floor = .1;
  const kept = echoPaths(echoField(surface, profile, R, { scattering: 1, limit: 2000, shadowFloor: floor }), S);
  const lit = echoPaths(echoField(surface, homogeneous, R, { scattering: 1, limit: 2000 }), S);
  assert.ok(fromSlope(kept).length > 0);
  const ratio = strongest(kept) / strongest(lit);
  assert.ok(ratio > .5 * floor ** 2 && ratio < 2 * floor ** 2, `${ratio}`);
});

test('scattered echoes spread over their patches rather than arriving as clicks', async () => {
  const { fft, nextPowerOfTwo } = await import('../src/domain/fft.js');
  const hills = (x, y) => 200 + 180 * Math.sin(x / 450) * Math.cos(y / 380) + 90 * Math.sin((x + y) / 210);
  const scene = plainScene('blast');
  scene.terrain = terrain(hills, { cells: 120, extentMetres: 6000, scattering: 1 });
  scene.emitters[0] = { ...scene.emitters[0], chargeKilograms: 1000, secondaryShock: false, fireballDecibels: -60 };
  scene.receivers[0].positionMetres = { x: 800, y: 0, z: 1.7 };
  const parsed = parseScene(scene);
  const result = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  const samples = result.samples;
  // 2–8 kHz, where a click stands out; kurtosis per 50 ms window from 0.5 s after the shock.
  const size = nextPowerOfTwo(2 * samples.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  re.set(samples);
  fft(re, im);
  for (let bin = 0; bin < size; bin += 1) {
    const frequency = Math.min(bin, size - bin) * result.sampleRate / size;
    if (frequency < 2000 || frequency > 8000) { re[bin] = 0; im[bin] = 0; }
  }
  fft(re, im, true);
  let peak = 0;
  samples.forEach((value, index) => { if (Math.abs(value) > Math.abs(samples[peak])) peak = index; });
  const window = Math.round(.05 * result.sampleRate);
  let largest = 0;
  for (let start = peak + Math.round(.5 * result.sampleRate); start + window < samples.length; start += window) {
    let second = 0;
    let fourth = 0;
    for (let index = start; index < start + window; index += 1) { second += re[index] ** 2; fourth += re[index] ** 4; }
    if (second > 0) largest = Math.max(largest, fourth * window / second ** 2);
  }
  // Measured: 35 with point copies, 1.7 spread; Gaussian noise gives 3.
  assert.ok(largest < 8, `${largest}`);
});

test('a boom over hills echoes from them, after it and from where it left the flight path', () => {
  const hills = (x, y) => 150 + 250 * Math.exp(-((x - 1200) ** 2 + y ** 2) / 5e5);
  const scene = plainScene('sonic');
  scene.emitters = [{ ...defaultFlight(), startMetres: { x: -20000, y: 0, z: 3000 }, mach: 1.5, durationSeconds: 40 }];
  scene.receivers[0].positionMetres = { x: 300, y: 0, z: 1.7 };
  scene.terrain = terrain(hills, { scattering: .5, echoLimit: 100 });
  const parsed = parseScene(scene);
  const paths = receiverPaths(prepareScene(parsed), parsed.receivers[0], parsed);
  let direct = Infinity;
  const echoes = [];
  for (let index = 0; index < paths.count; index += 1) {
    if (paths.kind[index] === PATH_ECHO || paths.kind[index] === PATH_SCATTER) echoes.push(paths.seconds[index]);
    else direct = Math.min(direct, paths.seconds[index]);
  }
  assert.ok(echoes.length > 10, `${echoes.length} echoes`);
  assert.ok(echoes.every(seconds => seconds > direct));
  const loud = renderReceiver(prepareScene(parsed), parsed.receivers[0], parsed);
  const still = { ...parsed, terrain: { ...parsed.terrain, echoes: false } };
  const quiet = renderReceiver(prepareScene(still), still.receivers[0], still);
  assert.ok(loud.samples.every(Number.isFinite));
  // After the boom has passed, what remains is its echoes.
  const tail = result => {
    const from = Math.round((direct + .4 - result.startSeconds) * result.sampleRate);
    let sum = 0;
    for (let index = Math.max(0, from); index < result.samples.length; index += 1) sum += result.samples[index] ** 2;
    return sum;
  };
  assert.ok(tail(loud) > 100 * tail(quiet) + 1e-12, `${tail(loud)} vs ${tail(quiet)}`);
});
