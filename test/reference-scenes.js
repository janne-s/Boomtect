import { createHash } from 'node:crypto';
import { diffuseTails } from '../src/shared/domain/forest.js';
import {
  addTails, arrivalTable, assemblePaths, finishSum, frameExtents, partitionSeconds, pathRange, prepareScene, previewScene,
  receiverResult, renderReceiver, renderReceiverRange, sumSegments, tailResponses, tailSamples, tailStretches, tracePart
} from '../src/domain/render.js';
import {
  defaultBarrage, defaultBlast, defaultBooster, defaultCloudFlash, defaultFireworks, defaultFlight, defaultFormation, defaultLightning,
  defaultMeteor, defaultReceiver, defaultScene, defaultShower, defaultStorm, defaultWhip, parseScene
} from '../src/domain/scene.js';
import { syntheticTerrain } from './terrain-fixture.js';

const EMITTERS = Object.freeze({
  lightning: ['thunder', () => defaultLightning()],
  cloudFlash: ['thunder', () => defaultCloudFlash()],
  storm: ['thunder', () => ({ ...defaultStorm(), durationSeconds: 8, flashCount: 3, radiusMetres: 3000 })],
  blast: ['blast', () => defaultBlast(), { rich: true }],
  barrage: ['blast', () => ({ ...defaultBarrage(), durationSeconds: 8, roundCount: 6, airburstShare: .5 })],
  fireworks: ['blast', () => ({ ...defaultFireworks(), durationSeconds: 8, shellCount: 4, starCount: 10 })],
  flight: ['flights', () => defaultFlight(), { rich: true }],
  formation: ['flights', () => ({ ...defaultFormation(), memberCount: 2 }), { rich: true }],
  whip: ['flights', () => defaultWhip(), { rich: true }],
  booster: ['flights', () => defaultBooster(), { rich: true }],
  meteor: ['meteors', () => defaultMeteor()],
  shower: ['meteors', () => ({ ...defaultShower(), meteorCount: 3, durationSeconds: 8 })]
});

const MODE_OF_GROUP = Object.freeze({ thunder: 'thunder', blast: 'blast', flights: 'sonic', meteors: 'sonic' });

const hill = (x, y) => 120 + 80 * Math.exp(-((x - 700) ** 2 + (y - 300) ** 2) / 500 ** 2);

function flatScene(mode, emitter) {
  return parseScene({ ...defaultScene(mode), emitters: [emitter] });
}

function terrainScene(mode, emitter, { rich = false } = {}) {
  const base = defaultScene(mode);
  const second = { ...defaultReceiver('receiver-2', 'Mic 2'), positionMetres: { x: -600, y: 900, z: 1.7 }, headingDegrees: 120 };
  return parseScene({
    ...base,
    air: { ...base.air, windSpeedMetresPerSecond: 6, windShearPerSecond: .004, groundLayerMetres: 300 },
    ground: { ...base.ground, type: 'soil' },
    terrain: syntheticTerrain(hill),
    emitters: [emitter],
    receivers: rich ? [...base.receivers, second] : base.receivers,
    render: { ...base.render, ambisonicOrder: rich ? 2 : 1, quality: { ...base.render.quality, sharedScatter: true, coarseForest: true } }
  });
}

export const REFERENCE_CASES = Object.freeze(Object.entries(EMITTERS).flatMap(([name, [group, emitter, options]]) => [
  { name: `${name}-flat`, group, pipeline: 'whole', scene: () => flatScene(MODE_OF_GROUP[group], emitter()) },
  { name: `${name}-terrain`, group, pipeline: 'parts', scene: () => terrainScene(MODE_OF_GROUP[group], emitter(), options) }
]).concat(['thunder', 'blast', 'flights'].map(group => ({
  name: `${MODE_OF_GROUP[group]}-preview`, group, pipeline: 'parts', scene: () => previewScene(defaultScene(MODE_OF_GROUP[group]))
}))));

function renderWhole(scene) {
  const prepared = prepareScene(scene);
  return scene.receivers.map(receiver => renderReceiver(prepared, receiver, scene));
}

function renderInParts(scene, parts = 2) {
  const prepared = prepareScene(scene);
  return scene.receivers.map(receiver => {
    const traced = Array.from({ length: parts }, (_, part) => tracePart(prepareScene(scene), receiver, scene, { part, parts }));
    const paths = assemblePaths(prepared, receiver, scene, traced);
    const arrivals = arrivalTable(prepared, receiver, scene, { paths });
    const extents = frameExtents(prepared, paths);
    const boundaries = partitionSeconds(null, scene, parts, [arrivals]);
    const segments = Array.from({ length: parts }, (_, part) => renderReceiverRange(prepareScene(scene), receiver, scene, {
      fromSeconds: boundaries[part], toSeconds: boundaries[part + 1], paths: pathRange(paths, boundaries[part], boundaries[part + 1]), extents
    }));
    const responses = tailResponses(receiver, scene);
    const sum = sumSegments(segments, scene.render.sampleRate, tailSamples(responses));
    const length = responses ? sum.channels[0].length - tailSamples(responses) : 0;
    if (length > 0) {
      for (const [from, to] of tailStretches(length, parts, tailSamples(responses))) {
        addTails(sum, from, diffuseTails(sum.channels[0].slice(from, to), responses, sum.channels.length));
      }
    }
    const nonlinearPaths = segments.reduce((total, segment) => total + segment.nonlinearPaths, 0);
    return receiverResult(receiver, scene, finishSum(sum, scene.render.sampleRate), arrivals, nonlinearPaths);
  });
}

export function renderCase(item) {
  const scene = item.scene();
  return item.pipeline === 'whole' ? renderWhole(scene) : renderInParts(scene);
}

const bytes = array => new Uint8Array(array.buffer, array.byteOffset, array.byteLength);

export function digest(results) {
  const hash = createHash('sha256');
  for (const result of results) {
    hash.update(JSON.stringify([result.receiverId, result.startSeconds, result.peakPa, result.nonlinearPaths, result.channels.length, result.arrivals.count]));
    for (const channel of result.channels) hash.update(bytes(channel));
    for (const [key, value] of Object.entries(result.arrivals).sort(([a], [b]) => a.localeCompare(b))) {
      if (ArrayBuffer.isView(value)) { hash.update(key); hash.update(bytes(value)); }
    }
  }
  return hash.digest('hex');
}

export const REFERENCE_FILE = new URL('./fixtures/reference-renders.json', import.meta.url);
