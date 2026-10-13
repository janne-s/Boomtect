import { atmosphericAbsorptionNepersPerMetre } from './domain/air.js';
import { APP_VERSION, BLAST, FLIGHT, GROUND, MODEL_VERSION, REFERENCE_SOUND_PRESSURE_PA, RENDER, RENDER_COST, THUNDER, VIEW } from './domain/constants.js';
import { blastSources, emitterSources } from './domain/emitters.js';
import { EXPLOSIVE_TYPES } from './domain/explosives.js';
import { GROUND_LABELS, GROUND_TYPES } from './domain/ground.js';
import { emissionSeconds } from './domain/lightning.js';
import { newSeed } from './domain/random.js';
import { localProfile, PATH_DIRECT, PATH_SCATTER, PATH_SHADOW, pathProfile, soundSpeedProfile, travelSeconds, wavefront } from './domain/refraction.js';
import { addTails, arrivalTable, assemblePaths, echoesActive, finishSum, hasTails, joinResponses, partitionSeconds, prepareScene, previewScene, echoFreeShare, receiverResult, resultDifference, sumSegments, tailSamples, tailStretches } from './domain/render.js';
import {
  defaultBarrage, defaultBlast, defaultBooster, defaultCloudFlash, defaultFireworks, defaultFlight, defaultFormation, defaultMeteor, defaultShower, defaultWhip, defaultLightning, defaultReceiver, defaultScene, defaultStorm, emitterAnchor, headingToward, MODES, PARAMETERS, parseScene, placeLabel, readScene, serializeScene, TERRAIN_DEFAULTS
} from './domain/scene.js';
import { AMBISONIC_CONVENTION, availableItems, exportDownload, exportFiles, exportPlan, exportSizes, fileStem, itemFiles } from './ui/export-package.js';
import { soundHandoff } from './domain/sound-handoff.js';
import { handoffMessage } from './domain/handoff.js';
import { ECHOTECT_URL, openTect } from './ui/tect-link.js';
import { formatMetres, formatSeconds, microphoneColor } from './ui/canvas.js';
import { actionField, checkboxField, numberField, pointFields, seedField, selectField, textField } from './ui/fields.js';
import { capturePatches, fetchPlaceNames, searchPlace } from './ui/terrain-loader.js';
import { patchCount, patchRange, rangeBounds, rangePatches, terrainRange, terrainSurface } from './domain/terrain.js';
import { createPlaceMap } from './ui/place-map.js';
import { createCubeView } from './ui/cube-view.js';
import { createMapLayer } from './ui/map-layer.js';
import { cachedBursts, cachedFlashes, cachedRounds, cachedTracks, currentSurface, isFieldKind, isFlightKind, isTrackKind, useTerrain } from './ui/geometry-cache.js';
import { BODY_TYPES, carlsonBoom, machCone } from './domain/flight.js';
import { meteorBoom, showerMembers } from './domain/meteor.js';
import { entryText, formatCharge, macrosFor, parseEntry } from './ui/macros.js';
import { composeListening, LISTENING_LABELS, listeningKind } from './ui/listening.js';
import { createOrientationBall } from './ui/orientation-ball.js';
import { createMobileLayout } from './ui/mobile.js';
import { createSettings } from './ui/settings.js';
import { createPlayer } from './ui/player.js';
import { drawArrivals, drawWaveform, plotSeconds } from './ui/plots.js';
import { attachSplitters } from './ui/splitters.js';

const sceneStorageKey = mode => `boomtect.scene.${mode}`;
const PREFERENCES_STORAGE_KEY = 'boomtect.preferences';
const WORKER_COUNT = Math.max(1, Math.min(RENDER.maximumWorkers, (navigator.hardwareConcurrency || 2) - 1));
const workerLimit = () => Math.max(1, Math.min(WORKER_COUNT, state.preferences.threads || WORKER_COUNT));

const KIND_LABELS = Object.freeze({ blast: 'Blast', storm: 'Storm', barrage: 'Barrage', flight: 'Flight', formation: 'Formation', meteor: 'Meteor', shower: 'Shower', whip: 'Whip', booster: 'Booster', fireworks: 'Fireworks' });
const FLASH_TYPE_LABELS = Object.freeze({ 'cloud-to-ground': 'Ground flash', 'intra-cloud': 'Cloud flash' });

const $ = id => document.getElementById(id);

const storage = {
  read(key) {
    try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
  },
  write(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be unavailable; the app works without it. */ }
  }
};

function restoredScene(mode) {
  try {
    const scene = readScene(storage.read(sceneStorageKey(mode)));
    if (scene.mode === mode) return scene;
  } catch { /* A missing or broken scene falls back to the default. */ }
  return defaultScene(mode);
}

const preferences = {
  realDelay: true, wavefronts: { thunder: true, blast: true, sonic: true }, contours: true, names: true, map: false, cone: true, clouds: true, autoRender: true, preview: false, mode: 'thunder',
  terrainDraft: { cellMetres: 30 }, cubeViews: {},
  panelWidth: 340, resultsHeight: 220,
  ...(storage.read(PREFERENCES_STORAGE_KEY) ?? {})
};
if (!MODES.includes(preferences.mode)) preferences.mode = 'thunder';

const state = {
  scene: restoredScene(preferences.mode),
  selection: null,
  results: null,
  playedPeak: null,
  pause: null,
  envelopes: new Map(),
  revision: 0,
  workers: [],
  renderTimer: null,
  watchdog: null,
  detailsId: null,
  soloId: null,
  preferences
};
state.selection = { type: 'emitter', id: state.scene.emitters[0].id };

const player = createPlayer();
const mobile = createMobileLayout({ onResults: () => drawResults() });
createSettings({
  read: () => ({
    quality: state.scene.render.quality,
    preview: state.preferences.preview,
    threads: workerLimit(),
    maximumThreads: WORKER_COUNT,
    echoCellMetres: echoesActive(state.scene) ? state.scene.terrain.echoCellMetres : null,
    flashes: state.scene.emitters.some(emitter => emitter.kind === 'lightning' || emitter.kind === 'storm'),
    forest: state.scene.ground.forest,
    scatterShare: scatterShare(),
    last: state.lastRender
  }),
  save: ({ quality, preview, threads }) => {
    state.preferences.threads = threads === WORKER_COUNT ? 0 : threads;
    const previewChanged = preview !== state.preferences.preview;
    state.preferences.preview = preview;
    savePreferences();
    syncToggles();
    const current = state.scene.render.quality;
    if (Object.keys(quality).some(key => quality[key] !== current[key])) commit(next => { next.render.quality = quality; });
    else if (previewChanged) { invalidateResults(); requestRender(); }
  }
});

function scatterShare() {
  if (!echoesActive(state.scene)) return 0;
  if (!state.results) return RENDER_COST.scatterShare;
  let scattered = 0;
  let all = 0;
  for (const { arrivals } of state.results.values()) {
    for (let index = 0; index < arrivals.count; index += 1) if (arrivals.kinds[index] === PATH_SCATTER) scattered += 1;
    all += arrivals.count;
  }
  return all ? scattered / all : 0;
}
const liveFields = { receiver: null, orientation: null };

function panelOnNextFrame() {
  if (panelOnNextFrame.pending) return;
  panelOnNextFrame.pending = true;
  requestAnimationFrame(() => { panelOnNextFrame.pending = false; refreshPanel(); });
}

const orientationBall = createOrientationBall($('cube-orientation-ball'), {
  getView: () => views[0].getView(),
  onChange: (heading, pitch) => { const target = orientationTarget(); if (target) orient(target.id, heading, pitch); },
  onCommit: () => storeScene()
});

// Focus is drawn plainly while moving by keyboard, and quietly after a pointer (styles.css).
document.addEventListener('keydown', event => { if (event.key === 'Tab') document.documentElement.dataset.keyboard = ''; }, true);
document.addEventListener('pointerdown', () => { delete document.documentElement.dataset.keyboard; }, true);

const mapLayer = createMapLayer(() => redrawViews());

const views = [createCubeView($('cube'), {
  onView: next => { state.preferences.cubeViews = { ...state.preferences.cubeViews, [state.scene.mode]: next }; savePreferences(); },
  onViewChange: () => orientationBall?.draw(),
  onSelect: selection => { select(selection); refreshPanel(); },
  onMove: (handle, point) => {
    const item = findItem(handle.type, handle.id);
    if (handle.field === 'flightHeading') {
      const heading = headingToward(emitterAnchor(item), point);
      if (heading === item.headingDegrees) return;
      item.headingDegrees = heading;
      handle.changed = true;
      invalidateResults();
      redrawViews();
      drawInfo();
      panelOnNextFrame();
      return;
    }
    if (handle.field === 'headingDegrees') {
      orient(item.id, headingToward(item.positionMetres, point), item.pitchDegrees);
      return;
    }
    const before = JSON.stringify(item[handle.field]);
    if (handle.field === 'cloudBaseMetres' || handle.field === 'cloudTopMetres') {
      const { cloudBaseMetres: base, cloudTopMetres: top } = PARAMETERS;
      const height = Math.round(point.z / 10) * 10;
      if (handle.field === 'cloudBaseMetres') item.cloudBaseMetres = Math.min(base.maximum, item.cloudTopMetres - THUNDER.minimumCloudDepthMetres, Math.max(base.minimum, height));
      else item.cloudTopMetres = Math.min(top.maximum, Math.max(top.minimum, item.cloudBaseMetres + THUNDER.minimumCloudDepthMetres, height));
    } else if (handle.field === 'radiusMetres') {
      item.radiusMetres = Math.round(Math.min(PARAMETERS.radiusMetres.maximum, Math.hypot(point.x - item.centreMetres.x, point.y - item.centreMetres.y)));
    } else {
      item[handle.field] = storedPoint(handle, item, point);
      const live = liveFields[handle.type]?.[handle.field];
      if (live) {
        panelOnNextFrame.skip = true;
        live.set(item[handle.field]);
      }
    }
    if (JSON.stringify(item[handle.field]) === before) { panelOnNextFrame.skip = false; return; }
    handle.changed = true;
    invalidateResults();
    redrawViews();
    drawInfo();
    if (!panelOnNextFrame.skip) panelOnNextFrame();
    panelOnNextFrame.skip = false;
  },
  onCommit: handle => {
    if (handle.field === 'headingDegrees') storeScene();
    else if (handle.changed) commit(() => {});
  },
  focus: () => focusReceiver(),
  contours: () => state.preferences.contours,
  names: () => state.preferences.names,
  map: () => (state.preferences.map && state.scene.terrain?.enabled ? mapLayer.tiles(state.scene.terrain) : null),
  clouds: () => state.preferences.clouds
})];

function groundAnchored(handle, item) {
  if (handle.field === 'centreMetres' || handle.field === 'padMetres') return true;
  if (handle.field === 'startMetres') return item.kind === 'whip';
  if (handle.field === 'baseMetres') return item.flashType === 'cloud-to-ground';
  return handle.field === 'positionMetres';
}

/** A ground-anchored point keeps its height above the ground; on a wall its height is measured from the ground under it. */
function storedPoint(handle, item, point) {
  if (!groundAnchored(handle, item)) return point;
  if (handle.onGround) return { ...point, z: 0 };
  if (handle.plane?.fixed === 'z') return { ...point, z: item[handle.field].z };
  const above = point.z - currentSurface().heightAt(point.x, point.y);
  const step = Math.min(.1, handle.resolution ?? .1);
  return { ...point, z: +(Math.round(Math.min(PARAMETERS.heightMetres.maximum, Math.max(0, above)) / step) * step).toFixed(Math.max(0, -Math.log10(step))) };
}
views[0].setView(state.preferences.cubeViews?.[state.scene.mode] ?? VIEW.box.defaultView);
attachSplitters($('cube').closest('.layout'), { column: $('split-column'), row: $('split-row') }, state.preferences, sizes => {
  Object.assign(state.preferences, sizes);
  savePreferences();
});

function findItem(type, id) {
  if (!type) return null;
  return (type === 'emitter' ? state.scene.emitters : state.scene.receivers).find(item => item.id === id);
}

function select(selection) {
  state.selection = selection;
  if (selection.type === 'receiver') state.soloId = selection.id;
}

function setStatus(text, error = false) {
  const status = $('status');
  clearTimeout(setStatus.timer);
  status.textContent = text;
  status.classList.toggle('error', error);
  status.classList.remove('faded');
  if (text && !error) setStatus.timer = setTimeout(() => status.classList.add('faded'), VIEW.statusSeconds * 1000);
}

function applyScene(change) {
  const next = structuredClone(state.scene);
  change(next);
  try {
    state.scene = parseScene(next);
  } catch (error) {
    setStatus(error.message, true);
    refreshPanel();
    return false;
  }
  storeScene();
  return true;
}

function commit(change) {
  if (!applyScene(change)) return;
  scheduleTerrainCoverage();
  if (state.selection.type && !findItem(state.selection.type, state.selection.id)) state.selection = { type: null, id: null };
  if (state.soloId && !findItem('receiver', state.soloId)) state.soloId = null;
  invalidateResults();
  refreshPanel();
  requestRender();
}

function invalidateResults() {
  player.stop();
  state.pause = null;
  state.results = null;
  $('export').disabled = true;
  syncPlayButton();
}

const operations = new Map();
let operationsTimer = null;

function operation(key, text, { share = null, limitSeconds = null } = {}) {
  if (text === null) operations.delete(key);
  else operations.set(key, { text, share, limitSeconds, since: operations.get(key)?.since ?? performance.now() });
  drawOperations();
  if (key === 'render') syncPlayButton();
}

function drawOperations() {
  const now = performance.now();
  $('cube-operations').replaceChildren(...[...operations.values()].map(({ text, share, limitSeconds, since }) => {
    const seconds = Math.floor((now - since) / 1000);
    const parts = [text];
    if (share !== null) parts.push(`${Math.round(share * 100)} %`);
    if (limitSeconds) parts.push(`${seconds} / ${limitSeconds} s`);
    else if (seconds >= 1) parts.push(`${seconds} s`);
    const bar = element('li', 'operation', parts.join(' · '));
    bar.style.setProperty('--share', share === null ? '0%' : `${Math.min(100, share * 100)}%`);
    return bar;
  }));
  if (operations.size && !operationsTimer) operationsTimer = setInterval(drawOperations, 500);
  if (!operations.size && operationsTimer) { clearInterval(operationsTimer); operationsTimer = null; }
}

const timeLimit = seconds => AbortSignal.timeout(seconds * 1000);

function syncPlayButton() {
  const button = $('play');
  const playing = player.playing();
  const rendering = operations.has('render');
  const busy = !playing && rendering;
  button.textContent = playing ? 'Stop' : busy ? '' : state.results ? 'Play' : 'Render';
  button.setAttribute('aria-label', busy ? 'Rendering' : button.textContent);
  if (busy) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
  button.disabled = !playing && (rendering || (!state.results && !state.scene.emitters.some(emitter => emitter.enabled)));
  button.setAttribute('aria-pressed', playing ? 'true' : 'false');
  const pause = $('plot-play');
  pause.disabled = !state.results;
  pause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  pause.classList.toggle('playing', playing);
  $('results').classList.toggle('playable', Boolean(state.results));
}

function requestRender() {
  clearTimeout(state.renderTimer);
  if (state.preferences.autoRender) scheduleRender();
  else syncPlayButton();
}

function scheduleRender() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(startRender, RENDER.autoDelayMilliseconds);
}

function failRender(message) {
  stopWorkers();
  setStatus(message, true);
  drawResults();
}

function stopWorkers() {
  state.workers.forEach(worker => worker.terminate());
  state.workers = [];
  clearInterval(state.watchdog);
  operation('render', null);
  state.fullRender?.reject(new Error('The full render did not finish.'));
  state.fullRender = null;
}

/** Renders the scene in full; with `variant`, renders that scene instead and resolves with its results, leaving the scene's own. */
function renderFull(variant = null) {
  return new Promise((resolve, reject) => {
    startRender({ full: true, variant });
    if (!operations.has('render')) { reject(new Error('Nothing to render.')); return; }
    state.fullRender = { resolve, reject };
  });
}

function spawnWorker(revision, message, { onProgress, onResult }, transfer = []) {
  const worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
  state.workers.push(worker);
  worker.addEventListener('message', ({ data }) => {
    if (data.revision !== state.revision) return;
    state.heard = performance.now();
    if (data.type === 'progress') { onProgress?.(data.fraction); return; }
    if (data.type === 'error') { failRender(data.message); return; }
    worker.terminate();
    onResult(data);
  });
  worker.addEventListener('error', event => {
    if (revision !== state.revision) return;
    failRender(event.message || 'The renderer failed to start.');
  });
  worker.postMessage({ revision, ...message }, transfer);
}

/**
 * Renders on a pool of workers: each receiver's tracing is split across workers and assembled here,
 * then its arrivals are split into time ranges that reuse the traced paths, and the diffuse tails
 * are added once to the sum. Every worker gets the scene as it was when the render started.
 */
function startRender({ full = false, variant = null } = {}) {
  state.revision += 1;
  const revision = state.revision;
  stopWorkers();
  setStatus('');
  const scene = variant ?? (state.preferences.preview && !full ? previewScene(state.scene) : state.scene);
  if (!scene.emitters.some(emitter => emitter.enabled)) {
    if (scene.emitters.length) setStatus('No emitter is enabled.');
    drawResults();
    return;
  }
  let sources;
  let prepared;
  let workerCount = workerLimit();
  try {
    prepared = prepareScene(scene);
    sources = prepared.reduce((sum, item) => sum + item.sources.length, 0);
    workerCount = Math.max(1, Math.min(workerLimit(), Math.floor(RENDER.sourceCopiesBudget / Math.max(1, sources))));
  } catch (error) {
    setStatus(error.message, true);
    drawResults();
    return;
  }
  const started = performance.now();
  state.heard = performance.now();
  operation('render', 'Tracing paths', { share: 0 });
  const channels = (scene.render.ambisonicOrder + 1) ** 2;
  const shares = Math.max(1, Math.min(channels, Math.floor(workerCount / scene.receivers.length)));
  const responses = hasTails(scene)
    ? Promise.all(scene.receivers.map((_, index) => Promise.all(Array.from({ length: shares }, (_, share) => new Promise(resolve => {
      const range = [Math.floor(share * channels / shares), Math.floor((share + 1) * channels / shares)];
      spawnWorker(revision, { type: 'responses', scene, receivers: [index], channels: range }, { onResult: data => resolve(data.responses[0]) });
    }))).then(joinResponses)))
    : Promise.resolve(scene.receivers.map(() => null));
  // A worker the browser stops, as when it runs out of memory, may never report; this ends the wait.
  state.watchdog = setInterval(() => {
    if (revision !== state.revision || performance.now() - state.heard < RENDER.stallSeconds * 1000) return;
    failRender(`The render stopped responding with ${sources.toLocaleString('en')} point sources, likely out of memory`);
  }, 5000);
  const parts = Math.max(1, Math.floor(workerCount / scene.receivers.length));
  const jobs = scene.receivers.flatMap((_, receiver) => Array.from({ length: parts }, (_, part) => ({ receiver, part, parts })));
  const tracers = Math.min(workerCount, jobs.length);
  const traced = scene.receivers.map(() => new Array(parts));
  const progress = new Array(tracers).fill(0);
  let tracing = tracers;
  for (let index = 0; index < tracers; index += 1) {
    const own = jobs.filter((_, job) => job % tracers === index);
    spawnWorker(revision, { type: 'trace', scene, jobs: own }, {
      onProgress: fraction => {
        progress[index] = fraction;
        operation('render', 'Tracing paths', { share: progress.reduce((a, b) => a + b, 0) / tracers });
      },
      onResult: data => {
        data.parts.forEach((result, position) => { traced[own[position].receiver][own[position].part] = result; });
        tracing -= 1;
        if (tracing > 0) return;
        let arrivals;
        let tracedPaths;
        try {
          tracedPaths = scene.receivers.map((receiver, receiverIndex) => assemblePaths(prepared, receiver, scene, traced[receiverIndex]));
          arrivals = scene.receivers.map((receiver, receiverIndex) => arrivalTable(prepared, receiver, scene, { paths: tracedPaths[receiverIndex] }));
        } catch (error) {
          failRender(error.message);
          return;
        }
        renderRanges(revision, scene, arrivals, tracedPaths, responses, { sources, workerCount, started, variant: Boolean(variant) });
      }
    });
  }
}

function renderJobs(scene, arrivals, workerCount) {
  const receivers = scene.receivers.map((_, index) => index);
  if (receivers.length >= workerCount) {
    return Array.from({ length: workerCount }, (_, job) => ({ receivers: receivers.filter(index => index % workerCount === job), fromSeconds: -Infinity, toSeconds: Infinity }));
  }
  const total = arrivals.reduce((sum, table) => sum + table.count, 0) || 1;
  const shares = arrivals.map(table => Math.max(1, Math.floor(workerCount * table.count / total)));
  for (let spare = workerCount - shares.reduce((a, b) => a + b, 0); spare > 0; spare -= 1) {
    let busiest = 0;
    arrivals.forEach((table, index) => { if (table.count / shares[index] > arrivals[busiest].count / shares[busiest]) busiest = index; });
    shares[busiest] += 1;
  }
  return receivers.flatMap(index => {
    const boundaries = partitionSeconds(null, scene, shares[index], [arrivals[index]]);
    return Array.from({ length: shares[index] }, (_, part) => ({ receivers: [index], fromSeconds: boundaries[part], toSeconds: boundaries[part + 1] }));
  });
}

function renderRanges(revision, scene, arrivals, tracedPaths, responses, info) {
  const jobs = renderJobs(scene, arrivals, info.workerCount);
  const progress = new Array(jobs.length).fill(0);
  const parts = new Array(jobs.length);
  let remaining = jobs.length;
  operation('render', 'Rendering', { share: 0 });
  jobs.forEach((job, index) => {
    spawnWorker(revision, { type: 'render', scene, ...job, paths: job.receivers.map(index => tracedPaths[index]) }, {
      onProgress: fraction => {
        progress[index] = fraction;
        operation('render', 'Rendering', { share: progress.reduce((a, b) => a + b, 0) / jobs.length });
      },
      onResult: data => {
        parts[index] = data.segments;
        remaining -= 1;
        if (remaining === 0) responses.then(list => { if (revision === state.revision) addRenderTails(revision, scene, arrivals, parts, list, info); });
      }
    });
  });
}

const receiverSegments = (parts, receiver) => parts.map(list => list.find(segment => segment.receiverId === receiver.id)).filter(Boolean);

function addRenderTails(revision, scene, arrivals, parts, responses, info) {
  let sums;
  try {
    sums = scene.receivers.map((receiver, index) => sumSegments(receiverSegments(parts, receiver), scene.render.sampleRate, tailSamples(responses[index])));
  } catch (error) {
    failRender(error.message);
    return;
  }
  const lengths = sums.map((sum, index) => (responses[index] ? sum.channels[0].length - tailSamples(responses[index]) : 0));
  const total = lengths.reduce((a, b) => a + b, 0);
  const jobs = lengths.flatMap((length, index) => (length > 0
    ? tailStretches(length, Math.max(1, Math.round(info.workerCount * length / total)), tailSamples(responses[index])).map(([from, to]) => ({ index, from, to }))
    : []));
  const finish = () => finishRender(scene, arrivals, sums, parts, { sources: info.sources, workers: info.workerCount, milliseconds: performance.now() - info.started, variant: info.variant });
  if (!jobs.length) { finish(); return; }
  let remaining = jobs.length;
  operation('render', 'Adding tails', { share: 0 });
  // Every stretch is cut from the sum before any tail is added to it.
  jobs.forEach(({ index, from, to }) => {
    const pressure = sums[index].channels[0].slice(from, to);
    spawnWorker(revision, { type: 'tails', pressure, responses: responses[index], channels: sums[index].channels.length }, {
      onResult: data => {
        addTails(sums[index], from, data.tails);
        remaining -= 1;
        operation('render', 'Adding tails', { share: 1 - remaining / jobs.length });
        if (remaining === 0) finish();
      }
    }, [pressure.buffer]);
  });
}

function finishRender(scene, arrivals, sums, parts, info) {
  state.workers = [];
  clearInterval(state.watchdog);
  let results;
  try {
    results = new Map(scene.receivers.map((receiver, index) => {
      const nonlinearPaths = receiverSegments(parts, receiver).reduce((sum, segment) => sum + segment.nonlinearPaths, 0);
      return [receiver.id, receiverResult(receiver, scene, finishSum(sums[index], scene.render.sampleRate), arrivals[index], nonlinearPaths)];
    }));
  } catch (error) {
    setStatus(error.message, true);
    if (info.variant) failRender(error.message); else drawResults();
    return;
  }
  if (info.variant) {
    operation('render', null);
    state.fullRender?.resolve(results);
    state.fullRender = null;
    return;
  }
  state.results = results;
  state.resultsPreview = Boolean(scene.render.preview);
  state.lastRender = { milliseconds: info.milliseconds, workers: info.workers, quality: scene.render.quality };
  state.envelopes = envelopes([...state.results.values()]);
  earCache.clear();
  setStatus(`${state.resultsPreview ? 'Preview: rendered' : 'Rendered'} ${info.sources.toLocaleString('en')} point sources in ${(info.milliseconds / 1000).toFixed(1)} s on ${info.workers} threads`);
  operation('render', null);
  $('export').disabled = false;
  drawResults();
  drawInfo();
  prepareEar();
  state.fullRender?.resolve();
  state.fullRender = null;
}

function envelopes(results) {
  const raw = results.map(result => {
    const window = Math.max(1, Math.round(result.sampleRate * VIEW.envelopeSeconds));
    const values = new Float32Array(Math.ceil(result.samples.length / window));
    for (let block = 0; block < values.length; block += 1) {
      let sum = 0;
      const end = Math.min(result.samples.length, (block + 1) * window);
      for (let index = block * window; index < end; index += 1) sum += result.samples[index] ** 2;
      values[block] = Math.sqrt(sum / Math.max(1, end - block * window));
    }
    return { result, values };
  });
  const maximum = Math.max(0, ...raw.map(({ values }) => values.reduce((a, b) => Math.max(a, b), 0)));
  for (const { values } of raw) {
    for (let block = 0; block < values.length; block += 1) {
      values[block] = maximum > 0 && values[block] > 0 ? Math.max(0, 1 + 20 * Math.log10(values[block] / maximum) / VIEW.envelopeRangeDb) : 0;
    }
  }
  return new Map(raw.map(({ result, values }) => [result.receiverId, { window: VIEW.envelopeSeconds, startSeconds: result.startSeconds, values }]));
}

function focusReceiver() {
  const solo = state.soloId && findItem('receiver', state.soloId);
  if (solo) return solo;
  const { heads, omnis } = listeningKind(state.scene.receivers, state.scene.render.ambisonicOrder);
  return heads[0] ?? omnis[0] ?? state.scene.receivers[0];
}

function outputGainForPeak(peakPa) {
  const { levelMode, fullScalePa } = state.scene.render;
  if (levelMode === 'fixed') return 1 / fullScalePa;
  return peakPa > 0 ? RENDER.peakTarget / peakPa : 1;
}

const earCache = new Map();

function earOnWorker(parts, sampleRate, setting) {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./ear-worker.js', import.meta.url), { type: 'module' });
    worker.addEventListener('message', ({ data }) => {
      worker.terminate();
      if (data.type === 'error') reject(new Error(data.message));
      else resolve(data.results);
    });
    worker.addEventListener('error', event => {
      worker.terminate();
      reject(new Error(event.message || 'The ear model failed to start.'));
    });
    worker.postMessage({ sampleRate, ...setting, parts }, parts.flat().map(channel => channel.buffer));
  });
}

let earPending = 0;

/** The composition through the ear model, on a worker; cached per render and setting, so Play finds it ready. */
async function earApplied(composition) {
  const { earReflex: reflex, earLoudness: loudness, earCapOnsets: capOnsets } = state.scene.render;
  if (!composition || (!reflex && !loudness)) return composition;
  const results = state.results;
  const key = part => `${part.receiverId}:${reflex}:${loudness}:${capOnsets}:${composition.startSeconds}:${composition.length}`;
  const parts = [...composition.heads.map(head => ({ part: head, channels: head.channels })), ...composition.omnis.map(omni => ({ part: omni, channels: [omni.channel] }))];
  const missing = parts.filter(({ part }) => earCache.get(key(part))?.results !== results);
  if (missing.length) {
    earPending += 1;
    operation('ear', 'Ear model');
    const batch = earOnWorker(missing.map(({ channels }) => channels), composition.sampleRate, { reflex, loudness, capOnsets });
    batch.finally(() => {
      earPending -= 1;
      if (!earPending) operation('ear', null);
    }).catch(() => {});
    missing.forEach(({ part }, index) => {
      // Only the latest setting is kept per receiver: a long render's channels are large.
      for (const stored of earCache.keys()) if (stored.startsWith(`${part.receiverId}:`)) earCache.delete(stored);
      const entry = { results, channels: batch.then(all => all[index]) };
      earCache.set(key(part), entry);
      // A failed run is not kept, so the next request tries again.
      entry.channels.catch(() => { if (earCache.get(key(part)) === entry) earCache.delete(key(part)); });
    });
  }
  const processed = await Promise.all(parts.map(({ part }) => earCache.get(key(part)).channels));
  const heads = composition.heads.map((head, index) => ({ ...head, channels: processed[index] }));
  const omnis = composition.omnis.map((omni, index) => ({ ...omni, channel: processed[heads.length + index][0] }));
  let peakPa = 0;
  for (const channel of [...heads.map(head => head.channels[0]), ...omnis.map(omni => omni.channel)]) {
    for (const value of channel) peakPa = Math.max(peakPa, Math.abs(value));
  }
  const playedKey = `${reflex}:${loudness}:${capOnsets}|${[...heads, ...omnis].map(part => part.receiverId).join(',')}`;
  if (results === state.results && (state.playedPeak?.results !== results || state.playedPeak.key !== playedKey || state.playedPeak.peakPa !== peakPa)) {
    state.playedPeak = { results, key: playedKey, peakPa };
    drawInfo();
  }
  return { ...composition, heads, omnis, peakPa };
}

function playedPeakPa() {
  const { heads, omnis } = listeningKind(state.scene.receivers, state.scene.render.ambisonicOrder);
  const ids = [...heads, ...omnis].map(receiver => receiver.id);
  const raw = Math.max(0, ...ids.map(id => state.results?.get(id)?.peakPa ?? 0));
  const { earReflex, earLoudness, earCapOnsets } = state.scene.render;
  if (!earReflex && !earLoudness) return raw;
  const key = `${earReflex}:${earLoudness}:${earCapOnsets}|${ids.join(',')}`;
  return state.playedPeak?.results === state.results && state.playedPeak.key === key ? state.playedPeak.peakPa : raw;
}

function prepareEar() {
  const { earReflex, earLoudness } = state.scene.render;
  if (!state.results || (!earReflex && !earLoudness)) return;
  listening().catch(error => setStatus(`Ear model failed: ${error.message}`, true));
}

/** The composition and its gain: binaural decoding gets RENDER.binauralHeadroom, a mix is scaled by 1/√parts. */
async function listening() {
  const composition = await earApplied(composeListening(state.scene, state.results));
  if (!composition) return null;
  let gain = outputGainForPeak(composition.peakPa);
  if (composition.heads.length) gain *= RENDER.binauralHeadroom;
  if (composition.kind === 'mix') gain /= Math.sqrt(composition.parts);
  return { composition, gain };
}

function savePreferences() {
  storage.write(PREFERENCES_STORAGE_KEY, state.preferences);
}

const hasSeed = emitter => !['blast', 'meteor', 'whip', 'booster'].includes(emitter.kind) && !isFlightKind(emitter);

function emitterKindLabel(emitter) {
  return emitter.kind === 'lightning' ? FLASH_TYPE_LABELS[emitter.flashType] : KIND_LABELS[emitter.kind];
}

const updateEmitter = (id, change) => commit(scene => change(scene.emitters.find(emitter => emitter.id === id)));
const updateReceiver = (id, change) => commit(scene => change(scene.receivers.find(receiver => receiver.id === id)));

function preview(change) {
  change(state.scene);
  invalidateResults();
  redrawViews();
  drawInfo();
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, onClick, { disabled = false, title = '' } = {}) {
  const node = element('button', '', text);
  node.type = 'button';
  node.disabled = disabled;
  if (title) node.title = title;
  node.addEventListener('click', onClick);
  return node;
}

function emitterSummary(emitter) {
  if (emitter.kind === 'blast') return `${formatCharge(emitter.chargeKilograms)} at ${formatMetres(emitter.positionMetres.z)}`;
  if (emitter.kind === 'meteor') return `${+emitter.diameterMetres.toPrecision(3)} m meteoroid at ${emitter.speedKilometresPerSecond} km/s, ${emitter.entryDegrees}° down from ${formatMetres(emitter.startMetres.z)}`;
  if (emitter.kind === 'shower') return `${emitter.meteorCount} meteoroids of about ${+emitter.diameterMetres.toPrecision(3)} m over ${emitter.durationSeconds} s`;
  if (emitter.kind === 'booster') return `From ${formatMetres(emitter.startHeightMetres)} at Mach ${emitter.mach.toFixed(2)}, ${emitter.descentDegrees}° down`;
  if (emitter.kind === 'whip') return `Tip at Mach ${emitter.mach.toFixed(2)}, ${formatMetres(emitter.startMetres.z)} above the ground`;
  if (isFlightKind(emitter)) return `${emitter.kind === 'formation' ? `${emitter.memberCount} × ` : ''}${FLIGHT.bodies[emitter.body].label} at Mach ${emitter.mach.toFixed(2)} and ${formatMetres(emitter.startMetres.z)} for ${emitter.durationSeconds} s`;
  if (emitter.kind === 'fireworks') return `${emitter.shellCount} shells of about ${Math.round(emitter.shellDiameterMillimetres)} mm over ${emitter.durationSeconds} s, ${Math.round(emitter.crackleShare * 100)} % crackling`;
  if (emitter.kind === 'barrage') {
    const salvos = Math.ceil(emitter.roundCount / emitter.salvoSize);
    return `${emitter.roundCount} rounds of ${formatCharge(emitter.chargeKilograms)} in ${salvos} salvo${salvos > 1 ? 's' : ''} over ${emitter.durationSeconds} s`;
  }
  const flashes = cachedFlashes(emitter);
  if (emitter.kind === 'storm') {
    const ground = flashes.filter(flash => flash.type === 'cloud-to-ground').length;
    return `${flashes.length} flashes (${ground} ground, ${flashes.length - ground} cloud) over ${emitter.durationSeconds} s`;
  }
  const [flash] = flashes;
  if (!flash) return '';
  const branches = flash.channels.filter(channel => !channel.main).length;
  const terminations = flash.channels.filter(channel => channel.termination).length;
  return `${formatMetres(flash.channels[0].arcs.at(-1))} channel · ${branches} branches · ${flash.strokes.length} strokes`
    + (terminations ? ` · ${terminations} new ground point${terminations > 1 ? 's' : ''}` : '');
}

function paintTrack(element, from, to) {
  const at = t => `calc(${VIEW.panels.thumbHalfPixels}px + (100% - ${2 * VIEW.panels.thumbHalfPixels}px) * ${t})`;
  element.style.setProperty('--from', from === 0 ? '0%' : at(from));
  element.style.setProperty('--to', at(to));
}

function holdViews(on) {
  views.forEach(view => view.hold(on));
}

function typeEntry(value, emitter, macro) {
  const field = element('input', 'macro-entry');
  field.type = 'text';
  field.value = entryText(macro.entry, emitter);
  field.setAttribute('aria-label', macro.label);
  let done = false;
  const finish = apply => {
    if (done) return;
    done = true;
    if (!apply) { field.replaceWith(value); value.focus(); return; }
    let number;
    try {
      number = parseEntry(macro.entry, field.value, emitter);
    } catch (error) {
      setStatus(`${macro.label}: ${error.message}`, true);
      field.replaceWith(value);
      return;
    }
    commit(scene => macro.entry.set(scene.emitters.find(item => item.id === emitter.id), number));
  };
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); finish(true); }
    if (event.key === 'Escape') { event.preventDefault(); finish(false); }
  });
  field.addEventListener('blur', () => finish(true));
  value.replaceWith(field);
  field.focus();
  field.select();
}

function macroRow(container, emitter, macro) {
  const id = `macro-${emitter.id}-${macro.label}`;
  const label = element('label', '', macro.label);
  label.htmlFor = id;
  const steps = macro.steps ?? VIEW.panels.macroSteps;
  const value = element(macro.entry ? 'button' : 'span', 'macro-value', macro.show(emitter));
  if (macro.entry) {
    value.type = 'button';
    value.setAttribute('aria-label', `${macro.label} ${macro.show(emitter)}`);
    value.addEventListener('click', () => typeEntry(value, emitter, macro));
  }
  const slider = position => {
    const input = element('input');
    input.type = 'range';
    input.min = '0';
    input.max = String(steps);
    input.step = '1';
    input.value = String(Math.round(position * steps));
    return input;
  };
  const apply = read => preview(scene => {
    const item = scene.emitters.find(candidate => candidate.id === emitter.id);
    macro.write(item, ...read());
    value.textContent = macro.show(item);
    if (macro.entry) value.setAttribute('aria-label', `${macro.label} ${value.textContent}`);
  });
  if (macro.dual) {
    const [low, high] = macro.read(emitter);
    const holder = element('div', 'dual');
    const lower = slider(low);
    const upper = slider(high);
    lower.id = id;
    lower.setAttribute('aria-label', `${macro.label} lower`);
    upper.setAttribute('aria-label', `${macro.label} upper`);
    const read = () => {
      const a = Number(lower.value);
      const b = Number(upper.value);
      return [Math.min(a, b) / steps, Math.max(a, b) / steps];
    };
    // Safari does not pass custom properties from a parent on to a slider's track, so both inputs carry them.
    const paint = () => { const [from, to] = read(); paintTrack(lower, from, to); paintTrack(upper, from, to); };
    paint();
    for (const input of [lower, upper]) {
      input.addEventListener('input', () => { holdViews(true); paint(); apply(read); });
      input.addEventListener('change', () => { holdViews(false); commit(() => {}); });
    }
    holder.append(lower, upper);
    container.append(label, holder, value);
    return;
  }
  const input = slider(macro.read(emitter));
  input.id = id;
  paintTrack(input, 0, Number(input.value) / steps);
  input.addEventListener('input', () => { holdViews(true); paintTrack(input, 0, Number(input.value) / steps); apply(() => [Number(input.value) / steps]); });
  input.addEventListener('change', () => { holdViews(false); commit(() => {}); });
  container.append(label, input, value);
}

function cardNode(selected, { checked, title, onCheck, onToggle }, ...parts) {
  const node = element('div', 'card');
  node.setAttribute('aria-selected', String(selected));
  const header = element('div', 'card-header');
  header.tabIndex = 0;
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', String(selected));
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = checked;
  checkbox.title = title;
  checkbox.addEventListener('click', event => event.stopPropagation());
  checkbox.addEventListener('change', () => onCheck(checkbox.checked));
  header.append(checkbox, ...parts);
  header.addEventListener('click', onToggle);
  header.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onToggle(); } });
  node.append(header);
  return node;
}

function emitterCard(container, emitter, selected) {
  const { scene } = state;
  const remove = element('button', 'icon-button');
  remove.type = 'button';
  remove.title = 'Remove';
  remove.setAttribute('aria-label', `Remove ${emitter.name}`);
  remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
  remove.addEventListener('click', event => {
    event.stopPropagation();
    commit(next => { next.emitters = next.emitters.filter(item => item.id !== emitter.id); });
  });
  remove.addEventListener('keydown', event => event.stopPropagation());
  const card = cardNode(selected, {
    checked: emitter.enabled, title: 'Enabled',
    onCheck: on => updateEmitter(emitter.id, item => { item.enabled = on; }),
    onToggle: () => { state.selection = selected ? { type: null, id: null } : { type: 'emitter', id: emitter.id }; refreshPanel(); }
  }, element('span', 'name', emitter.name), element('span', 'kind', emitterKindLabel(emitter)), remove);
  if (selected) {
    card.append(element('p', 'card-summary', emitterSummary(emitter)));
    const macros = element('div', 'macros');
    macrosFor(emitter, { onset: scene.emitters.length > 1 || emitter.startSeconds > 0 }).forEach(macro => macroRow(macros, emitter, macro));
    card.append(macros);
    const actions = element('div', 'card-actions');
    actions.append(button('Details…', () => openDetails(emitter.id)));
    if (hasSeed(emitter)) {
      actions.append(button('New shape', () => updateEmitter(emitter.id, item => { item.seed = newSeed(); }), { title: 'Same parameters, new seed' }));
      actions.append(button('Variant', () => addEmitter(next => {
        const source = next.emitters.find(item => item.id === emitter.id);
        source.enabled = false;
        return { ...structuredClone(source), id: uniqueId(source.kind, next.emitters), name: `${source.name} variant`.slice(0, 64), seed: newSeed(), enabled: true };
      }), { disabled: scene.emitters.length >= RENDER.maximumEmitters, title: 'Copy with a new seed; the original is switched off' }));
    }
    card.append(actions);
  }
  container.append(card);
}

function commitListening(change) {
  if (!applyScene(change)) return;
  refreshPanel();
  drawInfo();
  if (player.playing()) resumePlayback();
  else prepareEar();
}

function orient(receiverId, headingDegrees, pitchDegrees) {
  const item = state.scene.receivers.find(candidate => candidate.id === receiverId);
  item.headingDegrees = headingDegrees;
  item.pitchDegrees = pitchDegrees;
  player.setOrientation(receiverId, headingDegrees, pitchDegrees);
  if (liveFields.orientation?.receiverId === receiverId) liveFields.orientation.set(item);
  if (orientationTarget()?.id === receiverId) orientationBall.set(item);
  $('cube-orientation-value').textContent = orientationText(item);
  redrawViews();
}

function orientationTarget() {
  const selected = state.selection.type === 'receiver' ? findItem('receiver', state.selection.id) : null;
  if (selected?.type === 'binaural') return selected;
  return state.scene.receivers.find(receiver => receiver.listen && receiver.type === 'binaural') ?? null;
}

const orientationText = receiver => `${compassLabel(receiver.headingDegrees)} · ${receiver.pitchDegrees > 0 ? '+' : ''}${receiver.pitchDegrees}°`;

function drawOrientation() {
  const target = orientationTarget();
  $('cube-orientation').hidden = !target;
  if (!target) return;
  $('cube-orientation-name').textContent = target.name;
  $('cube-orientation-value').textContent = orientationText(target);
  orientationBall.set(target);
}

function storeScene() {
  storage.write(sceneStorageKey(state.scene.mode), state.scene);
}

const RECEIVER_TYPE_LABELS = Object.freeze({ omni: 'Omni', binaural: 'Binaural' });

function receiverCard(container, receiver, selected) {
  const card = cardNode(selected, {
    checked: receiver.listen, title: 'Listen',
    onCheck: on => commitListening(next => { next.receivers.find(item => item.id === receiver.id).listen = on; }),
    onToggle: () => { select(selected ? { type: null, id: null } : { type: 'receiver', id: receiver.id }); refreshPanel(); }
  }, element('span', 'name', receiver.name), element('span', 'kind', `${RECEIVER_TYPE_LABELS[receiver.type]} · ${formatMetres(receiver.positionMetres.z)}`));
  if (selected) {
    const fields = element('div', 'fields');
    textField(fields, { label: 'Name', value: receiver.name, onCommit: value => updateReceiver(receiver.id, item => { item.name = value; }) });
    selectField(fields, {
      label: 'Type', value: receiver.type, options: Object.entries(RECEIVER_TYPE_LABELS),
      onCommit: value => {
        // A binaural microphone hears the sound field, so it turns the Ambisonic render on if it was off.
        if (value === 'binaural' && state.scene.render.ambisonicOrder === 0) {
          commit(next => { next.receivers.find(item => item.id === receiver.id).type = value; next.render.ambisonicOrder = 1; });
        } else commitListening(next => { next.receivers.find(item => item.id === receiver.id).type = value; });
      }
    });
    liveFields.receiver = {
      positionMetres: pointFields(fields, {
        label: 'Position (m)', point: receiver.positionMetres,
        onCommit: value => updateReceiver(receiver.id, item => { item.positionMetres = value; })
      })
    };
    card.append(fields);
    if (receiver.type === 'binaural') {
      const orientation = element('div', 'fields');
      const facing = numberField(orientation, {
        key: 'facingDegrees', value: receiver.headingDegrees,
        onCommit: heading => commitListening(next => { next.receivers.find(item => item.id === receiver.id).headingDegrees = heading; })
      });
      const elevation = numberField(orientation, {
        key: 'pitchDegrees', value: receiver.pitchDegrees,
        onCommit: pitch => commitListening(next => { next.receivers.find(item => item.id === receiver.id).pitchDegrees = pitch; })
      });
      liveFields.orientation = { receiverId: receiver.id, set: item => { facing.set(item.headingDegrees); elevation.set(item.pitchDegrees); } };
      card.append(orientation);
    }
    const actions = element('div', 'card-actions');
    actions.append(button('Send to Echotect', event => sendToEchotect(receiver.id, event.currentTarget), { disabled: !state.results }));
    // Whether the sound takes its place along, or Echotect keeps its own; shared with the export's choice.
    const place = element('label', 'card-option');
    const placeBox = Object.assign(document.createElement('input'), { type: 'checkbox', checked: state.preferences.exportPlace ?? true });
    placeBox.addEventListener('change', () => { state.preferences.exportPlace = placeBox.checked; savePreferences(); });
    place.append(placeBox, element('span', '', 'Place'));
    actions.append(place);
    actions.append(button('Remove', () => commit(next => { next.receivers = next.receivers.filter(item => item.id !== receiver.id); }), { disabled: state.scene.receivers.length <= 1 }));
    card.append(actions);
  }
  container.append(card);
}

function detailSections(emitter) {
  const set = key => value => updateEmitter(emitter.id, item => { item[key] = value; });
  const section = (title, build) => ({ title, build });
  const numbers = keys => container => keys.forEach(key => numberField(container, { key, value: emitter[key], onCommit: set(key) }));
  const placement = container => {
    textField(container, { label: 'Name', value: emitter.name, onCommit: set('name') });
    if (hasSeed(emitter)) seedField(container, { value: emitter.seed, onCommit: set('seed'), onNew: () => set('seed')(newSeed()) });
    numberField(container, { key: 'startSeconds', value: emitter.startSeconds, onCommit: set('startSeconds') });
  };
  const centrePlacement = section('Placement', container => {
    placement(container);
    pointFields(container, { label: 'Centre', point: emitter.centreMetres, axes: ['x', 'y'], onCommit: set('centreMetres') });
  });
  const blastSections = [
    section('Source', container => {
      selectField(container, {
        label: 'Explosive', value: emitter.explosive, reliability: 'B',
        options: EXPLOSIVE_TYPES.map(type => [type, BLAST.explosives[type].label]), onCommit: set('explosive')
      });
      numbers(['chargeKilograms', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds'])(container);
      checkboxField(container, { label: 'Secondary shock', value: emitter.secondaryShock, reliability: 'B', onCommit: set('secondaryShock') });
    }),
    section('Fireball', numbers(['fireballDecibels', 'fireballSecondsPerSixthRootKilogram']))
  ];
  if (emitter.kind === 'lightning') {
    const ground = emitter.flashType === 'cloud-to-ground';
    return [
      section('Placement', container => {
        placement(container);
        selectField(container, {
          label: 'Type', value: emitter.flashType, options: Object.entries(FLASH_TYPE_LABELS),
          onCommit: value => updateEmitter(emitter.id, item => {
            item.flashType = value;
            if (value === 'cloud-to-ground') item.baseMetres = { ...item.baseMetres, z: 0 };
            else item.newTerminationProbability = 0;
          })
        });
        pointFields(container, { label: ground ? 'Ground point' : 'Start', point: emitter.baseMetres, axes: ground ? ['x', 'y'] : ['x', 'y', 'z'], onCommit: set('baseMetres') });
        pointFields(container, { label: ground ? 'Cloud end' : 'End', point: emitter.topMetres, onCommit: set('topMetres') });
      }),
      section('Channel', numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees',
        'branchCount', 'branchDepth', 'branchLengthRatio', 'branchEnergyRatio'])),
      section('Source', numbers(['energyJoulesPerMetre', 'energyVariation', 'acousticEfficiency', 'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds',
        ...(ground ? ['currentDecayHeightMetres'] : [])])),
      ...(ground ? [section('In cloud', numbers(['inCloudLengthMetres', 'inCloudEnergyRatio', 'inCloudSpeedMetresPerSecond']))] : []),
      section('Strokes', numbers(['channelSpeedMetresPerSecond', 'strokeCount', 'strokeIntervalSeconds', 'strokeIntervalSpread', 'subsequentStrokeEnergyRatio',
        ...(ground ? ['newTerminationProbability'] : [])]))
    ];
  }
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') {
    return [
      ...(emitter.kind === 'shower' ? [section('Shower', numbers(['meteorCount', 'radiusMetres', 'durationSeconds', 'diameterSpread']))] : []),
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Start', point: emitter.startMetres, onCommit: set('startMetres') });
        numbers(['headingDegrees', 'entryDegrees', 'endHeightMetres'])(container);
      }),
      section('Meteoroid', numbers(['speedKilometresPerSecond', 'diameterMetres', 'densityKilogramsPerCubicMetre', 'dragCoefficient', 'riseTimeSeconds'])),
      section('Breakup', numbers(['strengthMegapascals', 'breakupCount', 'breakupShare', 'burstShare']))
    ];
  }
  if (emitter.kind === 'booster') {
    return [
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Pad', point: emitter.padMetres, axes: ['x', 'y'], onCommit: set('padMetres') });
      }),
      section('Descent', numbers(['startHeightMetres', 'mach', 'descentDegrees', 'headingDegrees', 'ballisticKilogramsPerSquareMetre'])),
      section('Body', numbers(['lengthMetres', 'shapeFactor', 'riseTimeSeconds']))
    ];
  }
  if (emitter.kind === 'whip') {
    return [
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Start', point: emitter.startMetres, onCommit: set('startMetres') });
        numbers(['headingDegrees', 'climbDegrees'])(container);
      }),
      section('Tip', container => {
        numberField(container, { key: 'whipMach', value: emitter.mach, onCommit: set('mach') });
        numbers(['crackerLengthMetres', 'crackerShapeFactor', 'riseTimeSeconds'])(container);
      })
    ];
  }
  if (isFlightKind(emitter)) {
    return [
      ...(emitter.kind === 'formation' ? [section('Formation', numbers(['memberCount', 'lateralSpacingMetres', 'trailSpacingMetres']))] : []),
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Start', point: emitter.startMetres, onCommit: set('startMetres') });
      }),
      section('Flight', container => {
        numbers(['headingDegrees', 'climbDegrees', 'mach', 'accelerationMetresPerSecondSquared', 'turnDegreesPerSecond'])(container);
        numberField(container, { key: 'flightSeconds', value: emitter.durationSeconds, onCommit: set('durationSeconds') });
      }),
      section('Body', container => {
        selectField(container, {
          label: 'Body', value: emitter.body, reliability: 'B', options: BODY_TYPES.map(type => [type, FLIGHT.bodies[type].label]),
          onCommit: body => updateEmitter(emitter.id, item => {
            item.body = body;
            if (FLIGHT.bodies[body].lengthMetres) Object.assign(item, { lengthMetres: FLIGHT.bodies[body].lengthMetres, shapeFactor: FLIGHT.bodies[body].shapeFactor });
          })
        });
        for (const key of ['lengthMetres', 'shapeFactor']) {
          numberField(container, { key, value: emitter[key], onCommit: value => updateEmitter(emitter.id, item => { item[key] = value; item.body = 'custom'; }) });
        }
        numbers(['riseTimeSeconds'])(container);
      })
    ];
  }
  if (emitter.kind === 'fireworks') {
    return [
      centrePlacement,
      section('Shells', numbers(['radiusMetres', 'durationSeconds', 'shellCount', 'salvoSize', 'salvoSpreadSeconds', 'shellDiameterMillimetres', 'diameterSpread'])),
      section('Crackle', numbers(['crackleShare', 'starCount', 'popsPerStar', 'popMilligrams'])),
      section('Source', numbers(['riseTimeSeconds']))
    ];
  }
  if (emitter.kind === 'barrage') {
    return [
      centrePlacement,
      section('Rounds', numbers(['radiusMetres', 'durationSeconds', 'roundCount', 'salvoSize', 'salvoSpreadSeconds', 'chargeSpread', 'airburstShare', 'airburstHeightMetres'])),
      ...blastSections
    ];
  }
  if (emitter.kind === 'storm') {
    return [
      centrePlacement,
      section('Extent', numbers(['radiusMetres', 'durationSeconds', 'flashCount', 'groundFlashShare', 'cloudBaseMetres', 'cloudTopMetres', 'newTerminationProbability'])),
      section('Source', numbers(['energyJoulesPerMetre', 'energySpread', 'energyVariation', 'acousticEfficiency', 'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds', 'currentDecayHeightMetres'])),
      section('Ground flashes in cloud', numbers(['inCloudLengthMetres', 'inCloudEnergyRatio', 'inCloudSpeedMetresPerSecond'])),
      section('Channel', numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees', 'branchCount', 'branchDepth', 'branchEnergyRatio']))
    ];
  }
  return [
    section('Placement', container => {
      placement(container);
      pointFields(container, { label: 'Position', point: emitter.positionMetres, onCommit: set('positionMetres') });
    }),
    ...blastSections
  ];
}

function openDetails(id) {
  state.detailsId = id;
  renderDetails();
  if ($('details').open) return;
  $('details').showModal();
  // Focus the dialog itself, so its first control is not ringed when it opens.
  $('details').focus();
}

function renderDetails() {
  if (deferWhileEditing($('details-body'), renderDetails)) return;
  keepingFocus($('details-body'), rebuildDetails);
}

function rebuildDetails() {
  const emitter = state.scene.emitters.find(item => item.id === state.detailsId);
  if (!emitter) { $('details').close(); return; }
  const kind = emitterKindLabel(emitter);
  $('details-title').textContent = kind === emitter.name ? emitter.name : `${emitter.name} · ${kind}`;
  const body = $('details-body');
  const scroll = body.scrollTop;
  body.replaceChildren(...detailSections(emitter).map(({ title, build }) => {
    const group = element('section', 'details-section');
    group.append(element('h3', '', title));
    const fields = element('div', 'fields');
    build(fields);
    group.append(fields);
    return group;
  }));
  body.scrollTop = scroll;
}

let terrainCoverageTimer = null;
let terrainCoverageRunning = false;

function sceneBounds(scene) {
  const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
  const include = point => {
    bounds.west = Math.min(bounds.west, point.x); bounds.east = Math.max(bounds.east, point.x);
    bounds.south = Math.min(bounds.south, point.y); bounds.north = Math.max(bounds.north, point.y);
  };
  for (const emitter of scene.emitters) {
    if (emitter.kind === 'blast') include(emitter.positionMetres);
    else if (isTrackKind(emitter)) { for (const path of cachedTracks(emitter, scene.air)) path.x.forEach((x, index) => include({ x, y: path.y[index] })); }
    else if (emitter.kind === 'storm' || isFieldKind(emitter)) {
      const { x, y } = emitter.centreMetres;
      include({ x: x - emitter.radiusMetres, y: y - emitter.radiusMetres });
      include({ x: x + emitter.radiusMetres, y: y + emitter.radiusMetres });
    } else for (const flash of cachedFlashes(emitter)) for (const channel of flash.channels) channel.points.forEach(include);
  }
  scene.receivers.forEach(receiver => include(receiver.positionMetres));
  return bounds;
}

function neededPatches(scene, resolutionMetres) {
  const bounds = sceneBounds(scene);
  const size = Math.max(bounds.east - bounds.west, bounds.north - bounds.south);
  const margin = Math.max(GROUND.terrain.echoMarginMetres, GROUND.terrain.echoMarginShare * size);
  const area = { west: bounds.west - margin, east: bounds.east + margin, south: bounds.south - margin, north: bounds.north + margin };
  let cellMetres = resolutionMetres;
  while (patchCount(patchRange(area, cellMetres)) > GROUND.terrain.maximumPatches && cellMetres < GROUND.terrain.maximumCellMetres) cellMetres *= 2;
  return { cellMetres, range: patchRange(area, cellMetres) };
}

const sameRange = (a, b) => a && b && a.column0 === b.column0 && a.column1 === b.column1 && a.row0 === b.row0 && a.row1 === b.row1;
const terrainCoverageKey = terrain => (terrain ? `${terrain.latitude},${terrain.longitude},${terrain.cellMetres},${Object.values(terrainRange(terrain)).join(',')}` : '');

async function coveredTerrain(terrain, anchor, needed, label) {
  const { cellMetres, range } = needed;
  const keep = terrain && terrain.cellMetres === cellMetres && terrain.latitude === anchor.latitude && terrain.longitude === anchor.longitude
    ? terrain.patches.filter(patch => patch.column >= range.column0 && patch.column <= range.column1 && patch.row >= range.row0 && patch.row <= range.row1) : [];
  const have = new Set(keep.map(patch => `${patch.column},${patch.row}`));
  const missing = rangePatches(range).filter(({ column, row }) => !have.has(`${column},${row}`));
  const fetched = missing.length ? await capturePatches(anchor, cellMetres, missing, { onProgress: share => operation('terrain', label, { share }) }) : [];
  const bounds = rangeBounds(range, cellMetres);
  const names = (terrain?.names ?? []).filter(item => item.x >= bounds.west && item.x <= bounds.east && item.y >= bounds.south && item.y <= bounds.north);
  return { latitude: anchor.latitude, longitude: anchor.longitude, cellMetres, patches: [...keep, ...fetched], names };
}

let terrainCoverageAgain = false;

function scheduleTerrainCoverage() {
  clearTimeout(terrainCoverageTimer);
  terrainCoverageTimer = setTimeout(async () => {
    const { terrain } = state.scene;
    // Without emitters the scene is being cleared for new ones in the same place, so its terrain stays.
    if (!terrain?.enabled || !state.scene.emitters.length) return;
    if (terrainCoverageRunning) { terrainCoverageAgain = true; return; }
    const needed = neededPatches(state.scene, state.preferences.terrainDraft.cellMetres);
    if (needed.cellMetres === terrain.cellMetres && sameRange(needed.range, terrainRange(terrain))) return;
    terrainCoverageRunning = true;
    try {
      const next = await coveredTerrain(terrain, terrain, needed, 'Loading terrain');
      const covered = terrainCoverageKey(next) !== terrainCoverageKey(state.scene.terrain);
      commit(scene => { if (scene.terrain) Object.assign(scene.terrain, next); });
      if (covered) loadPlaceNames(state.scene.terrain);
    } catch (error) {
      setStatus(`The terrain could not be loaded: ${error.message}`, true);
    } finally {
      terrainCoverageRunning = false;
      operation('terrain', null);
      if (terrainCoverageAgain) { terrainCoverageAgain = false; scheduleTerrainCoverage(); }
    }
  }, GROUND.terrain.coverageDelayMilliseconds);
}

let placeNamesLoading = false;

async function loadPlaceNames(terrain) {
  if (placeNamesLoading) return;
  placeNamesLoading = true;
  $('names').disabled = true;
  operation('names', 'Place names', { limitSeconds: GROUND.terrain.placeNamesLimitSeconds });
  let names = null;
  try {
    names = await fetchPlaceNames(terrain, timeLimit(GROUND.terrain.placeNamesLimitSeconds));
  } catch {
  } finally {
    operation('names', null);
    placeNamesLoading = false;
    $('names').disabled = false;
  }
  if (!names || terrainCoverageKey(state.scene.terrain) !== terrainCoverageKey(terrain)) return;
  state.scene.terrain.names = names;
  storeScene();
  redrawViews();
}

/** Loads terrain around `place` and moves the scene there; the scene stays as it was if loading fails. */
async function loadTerrain(trigger, place = state.scene.place) {
  if (trigger) trigger.disabled = true;
  try {
    const covered = await coveredTerrain(null, place, neededPatches(state.scene, state.preferences.terrainDraft.cellMetres), 'Loading terrain');
    const datumMetres = terrainSurface({ ...covered, enabled: true, datumMetres: 0 }).heightAt(0, 0);
    const settings = state.scene.terrain ? Object.fromEntries(Object.keys(TERRAIN_DEFAULTS).map(key => [key, state.scene.terrain[key]])) : TERRAIN_DEFAULTS;
    commit(next => { next.place = place; next.terrain = { ...settings, ...covered, datumMetres }; });
    loadPlaceNames(state.scene.terrain);
  } catch (error) {
    setStatus(`The terrain could not be loaded: ${error.message}`, true);
  } finally {
    if (trigger) trigger.disabled = false;
    operation('terrain', null);
  }
}

/** Moves the scene to another place; loaded terrain is loaded again there. */
async function setPlace(change, trigger) {
  const place = { ...state.scene.place, ...change };
  if (state.scene.terrain) await loadTerrain(trigger, place);
  else commit(next => { next.place = place; });
}

function terrainPanel(container) {
  const { scene } = state;
  const draft = state.preferences.terrainDraft;
  const mapButton = button('', () => openPlaceDialog(), { title: 'Choose on a map' });
  mapButton.className = 'map-button';
  mapButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 3l4-2 4 2 4-2v10l-4 2-4-2-4 2z M5 1v10 M9 3v10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  mapButton.setAttribute('aria-label', 'Choose on a map');
  actionField(container, {
    label: 'Place', value: scene.place.name, action: 'Find', extra: mapButton,
    onAction: async (text, trigger) => {
      trigger.disabled = true;
      const found = await findPlace(text);
      if (found) {
        setStatus(found.name);
        await setPlace({ name: text, latitude: +found.latitude.toFixed(5), longitude: +found.longitude.toFixed(5) }, trigger);
      }
      trigger.disabled = false;
    }
  });
  for (const key of ['latitude', 'longitude']) {
    numberField(container, { key, value: scene.place[key], onCommit: value => setPlace({ name: '', [key]: value }, null) });
  }
  numberField(container, { key: 'terrainCellMetres', value: draft.cellMetres, onCommit: value => { draft.cellMetres = value; savePreferences(); } });
  const actions = element('div', 'field-actions');
  actions.append(button(scene.terrain ? 'Load again' : 'Load terrain', event => loadTerrain(event.currentTarget)));
  if (scene.terrain) actions.append(button('Remove', () => commit(next => { next.terrain = null; })));
  container.append(actions);
  if (!scene.terrain) return;
  const { terrain } = scene;
  const surface = currentSurface();
  const area = rangeBounds(terrainRange(terrain), terrain.cellMetres);
  container.append(element('p', 'field-note', `${placeLabel(scene.place)} · ${formatMetres(area.east - area.west)} × ${formatMetres(area.north - area.south)} at ${formatMetres(terrain.cellMetres)}`
    + (terrain.enabled ? ` · origin ${Math.round(surface.datumMetres)} m above sea level` : '')));
  checkboxField(container, { label: 'Terrain', value: terrain.enabled, reliability: 'B', onCommit: value => commit(next => { next.terrain.enabled = value; }) });
  checkboxField(container, { label: 'Shielding', value: terrain.shielding, reliability: 'B', onCommit: value => commit(next => { next.terrain.shielding = value; }) });
  checkboxField(container, { label: 'Echoes', value: terrain.echoes, reliability: 'C', onCommit: value => commit(next => { next.terrain.echoes = value; }) });
  if (terrain.echoes) {
    for (const key of ['scattering', 'echoCellMetres', 'echoLimit']) numberField(container, { key, value: terrain[key], onCommit: value => commit(next => { next.terrain[key] = value; }) });
  }
  checkboxField(container, { label: 'Contours', value: state.preferences.contours, onCommit: value => { state.preferences.contours = value; savePreferences(); redrawViews(); } });
}

const placeMap = createPlaceMap($('place-map'), $('place-overlay'), { onChange: showPlaceCoordinates });
let placeShown = '';

function showPlaceCoordinates({ latitude, longitude }) {
  $('place-coordinates').textContent = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

function placeExtentMetres() {
  const bounds = rangeBounds(neededPatches(state.scene, state.preferences.terrainDraft.cellMetres).range, state.preferences.terrainDraft.cellMetres);
  return Math.max(bounds.east - bounds.west, bounds.north - bounds.south);
}

function openPlaceDialog() {
  const { place } = state.scene;
  $('place-query').value = place.name;
  placeShown = place.name;
  $('place-dialog').showModal();
  // Focus the dialog itself, so its first control is not ringed when it opens.
  $('place-dialog').focus();
  placeMap.show(place, placeExtentMetres());
  showPlaceCoordinates(place);
}

async function findPlace(text) {
  operation('place', `Finding ${text}`, { limitSeconds: GROUND.terrain.placeSearchLimitSeconds });
  try {
    const found = await searchPlace(text, { signal: timeLimit(GROUND.terrain.placeSearchLimitSeconds) });
    if (!found) setStatus(`No place found for ${text}`, true);
    return found;
  } catch (error) {
    setStatus(`The place search failed: ${error.message}`, true);
    return null;
  } finally {
    operation('place', null);
  }
}

async function showFoundPlace(text) {
  const found = await findPlace(text);
  if (!found) return false;
  placeMap.show(found, placeExtentMetres());
  showPlaceCoordinates(found);
  placeShown = text;
  return true;
}

$('place-search').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('place-query').value.trim();
  if (text) showFoundPlace(text);
});
$('place-overlay').addEventListener('pointerdown', () => { placeShown = $('place-query').value.trim(); });
$('place-cancel').addEventListener('click', () => $('place-dialog').close());
$('place-done').addEventListener('click', async () => {
  const text = $('place-query').value.trim();
  if (text && text !== placeShown && !(await showFoundPlace(text))) return;
  const { latitude, longitude } = placeMap.centre();
  $('place-dialog').close();
  await setPlace({ name: $('place-query').value.trim(), latitude: +latitude.toFixed(5), longitude: +longitude.toFixed(5) }, $('place-done'));
});

/** Puts the focus back in the field that had it after a rebuild, so a number field's next step still lands. */
function keepingFocus(root, rebuild) {
  const focused = document.activeElement;
  const fields = () => [...root.querySelectorAll('input, select')];
  const index = root.contains(focused) ? fields().indexOf(focused) : -1;
  rebuild();
  if (index < 0) return;
  const again = fields()[index];
  if (again && again.dataset.key === focused.dataset.key && again.type === focused.type) again.focus({ preventScroll: true });
}

/** Waits for a focused number field to lose focus before rebuilding: replacing it ends its steps, in Safari even with the focus put back. */
function refreshPanel() {
  const panel = document.querySelector('aside.panel');
  if (deferWhileEditing(panel, refreshPanel)) return;
  keepingFocus(panel, rebuildPanel);
}

function deferWhileEditing(root, again) {
  const active = document.activeElement;
  if (!(root.contains(active) && active.matches('input[type="number"]'))) return false;
  if (!active.dataset.deferred) {
    active.dataset.deferred = 'true';
    active.addEventListener('focusout', () => requestAnimationFrame(again), { once: true });
  }
  return true;
}

function rebuildPanel() {
  useTerrain(state.scene.terrain);
  const { scene, selection } = state;
  const emitterList = $('emitter-list');
  emitterList.replaceChildren();
  scene.emitters.forEach(emitter => emitterCard(emitterList, emitter, selection.type === 'emitter' && selection.id === emitter.id));

  const receiverList = $('receiver-list');
  receiverList.replaceChildren();
  liveFields.receiver = null;
  liveFields.orientation = null;
  scene.receivers.forEach(receiver => receiverCard(receiverList, receiver, selection.type === 'receiver' && selection.id === receiver.id));

  const environment = $('environment-fields');
  environment.replaceChildren();
  const airField = key => numberField(environment, { key, value: scene.air[key], onCommit: value => commit(next => { next.air[key] = value; }) });
  ['temperatureCelsius', 'lapseRateKelvinPerMetre', 'relativeHumidityPercent', 'pressureKpa', 'turbulenceStrength', 'turbulenceScaleMetres'].forEach(airField);
  checkboxField(environment, { label: 'Refraction', value: scene.air.refraction, reliability: 'A', onCommit: value => commit(next => { next.air.refraction = value; }) });
  if (scene.air.refraction) {
    ['shadowFloorDecibels', 'windSpeedMetresPerSecond', 'windFromDegrees', 'windShearPerSecond', 'humidityScaleHeightMetres', 'tropopauseMetres', 'groundLayerMetres'].forEach(airField);
    if (scene.air.groundLayerMetres > 0) airField('groundLayerLapseKelvinPerMetre');
    if (scene.mode === 'sonic') ['upperWindMetresPerSecond', 'upperWindFromDegrees'].forEach(airField);
  }
  checkboxField(environment, { label: 'Air absorption', value: scene.air.absorption, reliability: 'B', onCommit: value => commit(next => { next.air.absorption = value; }) });
  checkboxField(environment, { label: 'Ground reflection', value: scene.ground.enabled, reliability: 'B', onCommit: value => commit(next => { next.ground.enabled = value; }) });
  selectField(environment, {
    label: 'Ground', value: scene.ground.type, reliability: 'B',
    options: GROUND_TYPES.map(type => [type, GROUND_LABELS[type]]),
    onCommit: value => commit(next => { next.ground.type = value; })
  });
  checkboxField(environment, { label: 'Forest', value: scene.ground.forest, reliability: 'B', onCommit: value => commit(next => { next.ground.forest = value; }) });
  if (scene.ground.forest) {
    numberField(environment, { key: 'treeHeightMetres', value: scene.ground.treeHeightMetres, onCommit: value => commit(next => { next.ground.treeHeightMetres = value; }) });
    numberField(environment, { key: 'forestDensity', value: scene.ground.forestDensity, onCommit: value => commit(next => { next.ground.forestDensity = value; }) });
  }
  checkboxField(environment, { label: 'Surroundings', value: scene.ground.surroundings, reliability: 'C', onCommit: value => commit(next => { next.ground.surroundings = value; }) });

  const terrainFields = $('terrain-fields');
  terrainFields.replaceChildren();
  terrainPanel(terrainFields);
  $('cube-attribution').hidden = !scene.terrain;
  $('names').hidden = !scene.terrain;
  $('map').hidden = !scene.terrain;
  $('cone').hidden = scene.mode !== 'sonic';
  $('clouds').hidden = !scene.emitters.some(emitter => emitter.kind === 'storm');
  syncToggles();

  const output = $('output-fields');
  output.replaceChildren();
  selectField(output, {
    label: 'Level', value: scene.render.levelMode,
    options: [['peak', 'Peak −3 dBFS'], ['fixed', 'Fixed full scale']],
    onCommit: value => commitListening(next => { next.render.levelMode = value; })
  });
  if (scene.render.levelMode === 'fixed') {
    numberField(output, { key: 'fullScalePa', value: scene.render.fullScalePa, onCommit: value => commitListening(next => { next.render.fullScalePa = value; }) });
  }
  checkboxField(output, { label: 'Ear reflex', value: scene.render.earReflex, reliability: 'B', onCommit: value => commitListening(next => { next.render.earReflex = value; }) });
  checkboxField(output, { label: 'Loudness', value: scene.render.earLoudness, reliability: 'C', onCommit: value => commitListening(next => { next.render.earLoudness = value; }) });
  if (scene.render.earLoudness) checkboxField(output, { label: 'Cap onsets', value: scene.render.earCapOnsets, reliability: 'C', onCommit: value => commitListening(next => { next.render.earCapOnsets = value; }) });
  selectField(output, {
    label: 'Spatial', value: String(scene.render.ambisonicOrder),
    options: [['0', 'Off'], ['1', '1st order'], ['2', '2nd order'], ['3', '3rd order']],
    onCommit: value => commit(next => { next.render.ambisonicOrder = Number(value); })
  });

  const { kind, heads, omnis } = listeningKind(scene.receivers, scene.render.ambisonicOrder);
  const names = [...heads, ...omnis].map(receiver => receiver.name).join(', ');
  const kindLabel = kind === 'surround' ? `Surround ${omnis.length} ch` : LISTENING_LABELS[kind];
  $('listen-label').textContent = names ? `${kindLabel} · ${names}` : kindLabel;
  const full = scene.emitters.length >= RENDER.maximumEmitters;
  document.querySelectorAll('.add-row [data-mode]').forEach(item => { item.hidden = item.dataset.mode !== scene.mode; item.disabled = full; });
  document.querySelectorAll('.modes [data-mode]').forEach(item => item.setAttribute('aria-checked', String(item.dataset.mode === scene.mode)));
  $('add-receiver').disabled = scene.receivers.length >= RENDER.maximumReceivers;
  if ($('details').open) renderDetails();
  redrawViews();
  drawResults();
  drawInfo();
}

const COMPASS = Object.freeze(['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west']);

function compassLabel(degrees) {
  return `${Math.round(degrees)}° ${COMPASS[Math.round(degrees / 45) % 8]}`;
}

function bearing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return { metres: Math.hypot(dx, dy), direction: COMPASS[Math.round(angle / 45) % 8] };
}

function drawInfo() {
  useTerrain(state.scene.terrain);
  drawOrientation();
  const { scene, selection } = state;
  const receiver = focusReceiver();
  const selected = findItem(selection.type, selection.id);
  const selectedInfo = $('cube-selected');
  selectedInfo.replaceChildren();
  if (selected && selection.type === 'emitter') {
    const kind = emitterKindLabel(selected);
    selectedInfo.append(element('strong', '', selected.name));
    if (kind !== selected.name || !selected.enabled) selectedInfo.append(element('span', '', kind + (selected.enabled ? '' : ' · off')));
    selectedInfo.append(element('span', '', emitterSummary(selected)));
    const { metres, direction } = bearing(receiver.positionMetres, emitterAnchor(selected));
    const anchorName = selected.kind === 'lightning' ? (selected.flashType === 'cloud-to-ground' ? 'ground point' : 'start') : selected.kind === 'storm' || isFieldKind(selected) ? 'centre' : selected.kind === 'booster' ? 'pad' : isTrackKind(selected) ? 'start' : 'blast';
    selectedInfo.append(element('span', '', metres < 1 ? `${receiver.name} is at its ${anchorName}` : `Its ${anchorName} is ${formatMetres(metres)} ${direction} of ${receiver.name}`));
    if (selected.kind === 'storm') selectedInfo.append(element('span', '', `Cloud ${formatMetres(selected.cloudBaseMetres)}–${formatMetres(selected.cloudTopMetres)} · ${formatMetres(selected.radiusMetres)} radius`));
    if (selected.startSeconds) selectedInfo.append(element('span', '', `Onset ${formatSeconds(selected.startSeconds)}`));
  } else if (selected) {
    const surface = currentSurface();
    const sea = surface.flat ? '' : ` · ${formatMetres(surface.datumMetres + surface.heightAt(selected.positionMetres.x, selected.positionMetres.y) + selected.positionMetres.z)} above sea level`;
    selectedInfo.append(element('strong', '', selected.name), element('span', '', `${formatMetres(selected.positionMetres.z)} above ground${sea}`));
    const { metres, direction } = bearing({ x: 0, y: 0 }, selected.positionMetres);
    selectedInfo.append(element('span', '', metres < 1 ? 'At the origin' : `${formatMetres(metres)} ${direction} of the origin`));
  }
  const listenInfo = $('cube-listen');
  listenInfo.replaceChildren(element('strong', '', receiver.listen ? `Listening at ${receiver.name}` : `At ${receiver.name} · muted`));
  let nearest = Infinity;
  const measure = point => { nearest = Math.min(nearest, Math.hypot(point.x - receiver.positionMetres.x, point.y - receiver.positionMetres.y, point.z - receiver.positionMetres.z)); };
  for (const item of scene.emitters) {
    if (!item.enabled) continue;
    if (item.kind === 'blast') measure(item.positionMetres);
    else if (isFieldKind(item)) cachedRounds(item, scene.air).forEach(round => measure(round.positionMetres));
    else if (isTrackKind(item)) { for (const path of cachedTracks(item, scene.air)) path.x.forEach((x, index) => measure({ x, y: path.y[index], z: path.z[index] })); }
    else for (const flash of cachedFlashes(item)) for (const channel of flash.channels) channel.points.forEach(measure);
  }
  if (Number.isFinite(nearest)) listenInfo.append(element('span', '', `Nearest source ${formatMetres(nearest)}`));
  const result = state.results?.get(receiver.id);
  if (result?.arrivals.count) {
    let first = Infinity;
    let last = -Infinity;
    for (let index = 0; index < result.arrivals.count; index += 1) {
      first = Math.min(first, result.arrivals.seconds[index]);
      last = Math.max(last, result.arrivals.seconds[index]);
    }
    listenInfo.append(element('span', '', last > first ? `Sound ${formatSeconds(first)}–${formatSeconds(last)} after the flash` : `Sound ${formatSeconds(first)} after the flash`));
    listenInfo.append(element('span', '', `Peak ${result.peakPa.toPrecision(3)} Pa · c ${result.speedOfSound.toFixed(1)} m/s`));
    let shadowed = 0;
    let sources = 0;
    for (let index = 0; index < result.arrivals.count; index += 1) {
      if (result.arrivals.kinds[index] === PATH_SHADOW) shadowed += 1;
      if (result.arrivals.kinds[index] === PATH_DIRECT || result.arrivals.kinds[index] === PATH_SHADOW) sources += 1;
    }
    const share = shadowed / sources * 100;
    if (shadowed) listenInfo.append(element('span', '', shadowed === sources ? 'All sources in the refraction shadow' : `${share < 1 ? '<1' : Math.round(share)} % of sources in the refraction shadow`));
    if (result.nonlinearPaths) listenInfo.append(element('span', 'warning', `${result.nonlinearPaths} paths start in the nonlinear zone`));
    const over = 20 * Math.log10(playedPeakPa() / scene.render.fullScalePa);
    if (scene.render.levelMode === 'fixed' && over > 0) {
      const severe = over >= RENDER.breakUpDecibels;
      listenInfo.append(element('span', severe ? 'warning severe' : 'warning', `Peak ${Math.max(1, Math.round(over))} dB above full scale: ${severe ? 'playback may break up' : 'clips'}`));
    }
  }
  if (scene.emitters.filter(item => item.enabled).length > 1) listenInfo.append(element('span', 'warning', 'Several emitters sound together'));
  mobile.update({ mode: scene.mode, name: selected?.name ?? receiver.name, selected: selected ? selection.type : null });
}

function redrawViews() {
  views.forEach(view => view.update(state.scene, state.selection));
}

function uniqueId(prefix, items) {
  let index = items.length + 1;
  while (items.some(item => item.id === `${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

function addEmitter(create) {
  commit(scene => {
    const emitter = create(scene);
    scene.emitters.push(emitter);
    state.selection = { type: 'emitter', id: emitter.id };
  });
}

function drawResults(playheadSeconds = state.pause?.seconds ?? null, { frame = false } = {}) {
  const { receivers } = state.scene;
  const soloId = receivers.length > 1 && state.soloId && findItem('receiver', state.soloId) ? state.soloId : null;
  const traces = receivers.map((receiver, index) => ({ id: receiver.id, index, listening: receiver.listen, result: state.results?.get(receiver.id) ?? null }));
  const key = `${state.results ? state.revision : 'none'}|${soloId}|${traces.map(trace => `${trace.id}:${trace.listening}`).join(',')}`;
  drawWaveform($('waveform'), { key, traces, soloId }, playheadSeconds);
  // A blast is one point, so its arrivals are shown by the direction they come from rather than by height.
  const byDirection = state.scene.mode === 'blast';
  drawArrivals($('arrivals'), { key: `${key}|${byDirection}`, traces, soloId, byDirection }, playheadSeconds);
  if (!frame) {
    drawPlotTabs(soloId);
    $('arrivals-caption').textContent = byDirection ? 'Arrival · direction' : 'Arrival · height';
    $('arrivals').setAttribute('aria-label', byDirection ? 'Arrival time by direction' : 'Arrival time by source height');
  }
}

function drawPlotTabs(soloId) {
  const tabs = $('plot-tabs');
  const { receivers } = state.scene;
  if (receivers.length < 2) { tabs.replaceChildren(); return; }
  tabs.replaceChildren(...receivers.map(receiver => {
    const tab = button(receiver.name, () => {
      state.soloId = soloId === receiver.id ? null : receiver.id;
      drawResults();
      drawInfo();
      redrawViews();
    });
    tab.setAttribute('aria-pressed', String(soloId === receiver.id));
    tab.style.setProperty('--mic', microphoneColor(receivers.indexOf(receiver)));
    tab.classList.toggle('muted', !receiver.listen);
    return tab;
  }));
}

function arrivalDelay(from) {
  if (!from || !state.results) return 0;
  const to = placedPoint(focusReceiver().positionMetres);
  return travelSeconds(pathProfile(soundSpeedProfile(state.scene.air), from, to), from, to);
}

const isBlastKind = emitter => emitter.kind === 'blast' || isFieldKind(emitter);
const isMeteorKind = emitter => emitter.kind === 'meteor' || emitter.kind === 'shower';

function strokeTimeline(emitter) {
  if (emitter.kind === 'blast') return [{ flash: 0, time: emitter.startSeconds, route: [], position: emitter.positionMetres, from: placedPoint(emitter.positionMetres) }];
  if (isMeteorKind(emitter)) {
    return cachedBursts(emitter, state.scene.air).flatMap((places, index) => places.map(burst => ({ flash: index, time: burst.emissionSeconds, route: [], position: burst.positionMetres, from: burst.positionMetres })));
  }
  if (isTrackKind(emitter)) return [];
  if (isFieldKind(emitter)) {
    return cachedRounds(emitter, state.scene.air).map((round, index) => ({
      flash: index, time: round.startSeconds, route: [], position: round.positionMetres, from: placedPoint(round.positionMetres),
      shell: round.id.endsWith(':burst') ? round.seed : null
    }));
  }
  return cachedFlashes(emitter).flatMap((flash, index) => flash.strokes.map(stroke => ({ flash: index, time: flash.startSeconds + stroke.offsetSeconds, route: stroke.route })));
}

/** What the scene view shows at the playback clock. A stroke's light runs figuratively in VIEW.flash.traverseSeconds; physically it takes microseconds. */
function animationState() {
  const clock = playbackClock();
  if (!clock) return null;
  const now = clock.sceneSeconds();
  const strokes = new Map();
  const result = state.results?.get(focusReceiver().id);
  const profile = soundSpeedProfile(state.scene.air);
  const realDelay = !clock.skippedSeconds && state.preferences.realDelay;
  for (const emitter of state.scene.emitters) {
    if (!emitter.enabled) continue;
    const timeline = strokeTimeline(emitter);
    if (realDelay || isBlastKind(emitter) || isMeteorKind(emitter)) {
      strokes.set(emitter.id, timeline
        .map(stroke => ({ ...stroke, elapsed: realDelay ? now - stroke.time : now - stroke.time - arrivalDelay(stroke.from) }))
        .filter(stroke => stroke.elapsed >= 0 && stroke.elapsed < VIEW.flash.traverseSeconds + VIEW.flash.visibleSeconds));
    }
  }
  const receiver = placedPoint(focusReceiver().positionMetres);
  const sound = !realDelay && result ? { seconds: now, key: `${receiver.x},${receiver.y},${receiver.z}|${JSON.stringify(state.scene.air)}`, travelSeconds: point => travelSeconds(profile, point, receiver) } : null;
  const receivers = new Map();
  for (const [id, envelopeData] of state.envelopes) {
    receivers.set(id, envelopeData.values[Math.floor((now - envelopeData.startSeconds) / envelopeData.window)] ?? 0);
  }
  const wavefronts = wavefrontsShown() ? { profile, spheres: wavefrontSpheres(now, profile), total: wavefrontCandidates(state.scene).length } : null;
  const flights = new Map();
  let cones = [];
  for (const emitter of state.scene.emitters) {
    if (!isTrackKind(emitter) || !emitter.enabled) continue;
    const paths = cachedTracks(emitter, state.scene.air);
    flights.set(emitter.id, paths.flatMap(path => {
      const index = Math.round((now - path.seconds[0]) / path.step);
      return index >= 0 && index < path.seconds.length ? [{ x: path.x[index], y: path.y[index], z: path.z[index] }] : [];
    }));
    if (!state.preferences.cone) continue;
    const amplitudes = coneAmplitudes(emitter);
    paths.forEach((path, member) => {
      const cone = machCone(path, now, profile);
      if (!cone) return;
      const { amplitude, frequencyHz } = amplitudes.get(`${emitter.id}:${member}`) ?? { amplitude: 0, frequencyHz: 1000 };
      const strengths = cone.radii.map(radius => frontStrength(amplitude, radius, frequencyHz));
      const strength = Math.max(...strengths);
      if (strength > 0) cones.push({ ...cone, strengths, strength });
    });
  }
  cones = cones.sort((a, b) => b.strength - a.strength).slice(0, VIEW.cone.bodies);
  return { strokes, receivers, sound, wavefronts, flights, cones };
}

const coneCache = new WeakMap();

function coneAmplitudes(emitter) {
  const key = JSON.stringify([emitter, state.scene.air]);
  const cached = coneCache.get(emitter);
  if (cached?.key === key) return cached.amplitudes;
  const amplitudes = wavefrontAmplitudes(emitter);
  coneCache.set(emitter, { key, amplitudes });
  return amplitudes;
}

function wavefrontsShown() {
  return Boolean(state.preferences.wavefronts?.[state.scene.mode]);
}

const wavefrontSources = new WeakMap();

function wavefrontAmplitudes(emitter) {
  const air = state.scene.air;
  const front = (amplitude, durationSeconds) => ({ amplitude, frequencyHz: 1 / Math.max(durationSeconds, 1e-6) });
  const blastFront = blast => { const [shock] = blastSources(blast, air); return front(shock.amplitudePaMetres, shock.durationSeconds); };
  const boomFront = (mach, lengthMetres, shapeFactor, distanceMetres) => {
    const boom = carlsonBoom({ mach, vehiclePressurePa: air.pressureKpa * 1000, groundPressurePa: air.pressureKpa * 1000, vehicleSoundSpeed: 340, lengthMetres, shapeFactor, distanceMetres });
    return front(boom.overpressurePa * distanceMetres, boom.durationSeconds);
  };
  if (emitter.kind === 'blast') return new Map([[emitter.id, blastFront(emitter)]]);
  if (isFlightKind(emitter)) {
    const boom = boomFront(Math.max(1.01, emitter.mach), emitter.lengthMetres, emitter.shapeFactor, 1000);
    return new Map(cachedTracks(emitter, air).map((_, index) => [`${emitter.id}:${index}`, boom]));
  }
  if (emitter.kind === 'booster') {
    // At Mach 1.5, about where the booster's boom leaves its path.
    return new Map([[`${emitter.id}:0`, boomFront(1.5, emitter.lengthMetres, emitter.shapeFactor, 1000)]]);
  }
  if (emitter.kind === 'whip') {
    return new Map([[`${emitter.id}:0`, boomFront(Math.max(1.01, emitter.mach), emitter.crackerLengthMetres, emitter.crackerShapeFactor, 1)]]);
  }
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') {
    return new Map(showerMembers(emitter).map((meteor, index) => {
      const height = meteor.endHeightMetres;
      const boom = meteorBoom(meteor, air, height, height, air.pressureKpa * 1000);
      return [`${emitter.id}:${index}`, front(boom.overpressurePa * height, boom.durationSeconds)];
    }));
  }
  if (isFieldKind(emitter)) return new Map(cachedRounds(emitter, air).map(round => [round.id, blastFront(round)]));
  const energy = new Map();
  for (const source of emitterSources(emitter, air, currentSurface()).sources) {
    const group = `${emitter.id}:${source.flash}`;
    const sum = energy.get(group) ?? { energy: 0, frequency: 0 };
    const share = source.amplitudePaMetres ** 2;
    energy.set(group, { energy: sum.energy + share, frequency: sum.frequency + share / Math.max(source.durationSeconds, 1e-6) });
  }
  return new Map([...energy].map(([group, { energy: total, frequency }]) => [group, { amplitude: Math.sqrt(total), frequencyHz: total > 0 ? frequency / total : 1000 }]));
}

function wavefrontCandidates(scene) {
  if (wavefrontSources.has(scene)) return wavefrontSources.get(scene);
  const candidates = [];
  const amplitudes = new Map();
  for (const emitter of scene.emitters) {
    if (!emitter.enabled) continue;
    for (const [group, amplitude] of wavefrontAmplitudes(emitter)) amplitudes.set(group, amplitude);
    if (emitter.kind === 'blast') { candidates.push({ point: placedPoint(emitter.positionMetres), emitted: emitter.startSeconds, group: emitter.id }); continue; }
    if (isTrackKind(emitter)) {
      cachedTracks(emitter, scene.air).forEach((path, member) => {
        const every = Math.max(1, Math.ceil(path.seconds.length / VIEW.wavefront.flightFronts));
        for (let index = 0; index < path.seconds.length; index += every) candidates.push({ point: { x: path.x[index], y: path.y[index], z: path.z[index] }, emitted: path.seconds[index], group: `${emitter.id}:${member}` });
      });
      continue;
    }
    if (isFieldKind(emitter)) {
      cachedRounds(emitter, scene.air).forEach(round => candidates.push({ point: placedPoint(round.positionMetres), emitted: round.startSeconds, group: round.id }));
      continue;
    }
    for (const [flashIndex, flash] of cachedFlashes(emitter).entries()) {
      const [stroke] = flash.strokes;
      for (const step of stroke.route) {
        const channel = flash.channels[step.channel];
        channel.points.forEach((point, index) => {
          const arc = channel.arcs[index];
          if (arc >= step.fromArc) candidates.push({ point, emitted: emissionSeconds(flash, stroke, step, arc), group: `${emitter.id}:${flashIndex}` });
        });
      }
    }
  }
  const stride = Math.max(1, Math.ceil(candidates.length / VIEW.wavefront.spheres));
  const sampled = candidates.filter((_, index) => index % stride === 0).map((candidate, order) => ({ ...candidate, order, ...(amplitudes.get(candidate.group) ?? { amplitude: 0, frequencyHz: 1000 }) }));
  wavefrontSources.set(scene, sampled);
  return sampled;
}

const placedPoint = point => ({ ...point, z: currentSurface().heightAt(point.x, point.y) + point.z });

const absorptionCache = { air: null, decibels: new Map() };

function absorptionDecibels(frequencyHz) {
  if (!state.scene.air.absorption) return 0;
  if (absorptionCache.air !== state.scene.air) Object.assign(absorptionCache, { air: state.scene.air, decibels: new Map() });
  const step = Math.round(12 * Math.log2(frequencyHz));
  if (!absorptionCache.decibels.has(step)) absorptionCache.decibels.set(step, atmosphericAbsorptionNepersPerMetre(2 ** (step / 12), state.scene.air) * 20 / Math.LN10);
  return absorptionCache.decibels.get(step);
}

function frontStrength(amplitude, radius, frequencyHz) {
  const absorption = absorptionDecibels(frequencyHz);
  const level = 20 * Math.log10(Math.max(amplitude, 1e-30) / Math.max(radius, 1) / REFERENCE_SOUND_PRESSURE_PA) - absorption * radius;
  return Math.min(1, Math.max(0, (level - VIEW.wavefront.floorDb) / (VIEW.wavefront.topDb - VIEW.wavefront.floorDb)));
}

function wavefrontSpheres(now, profile) {
  return wavefrontCandidates(state.scene)
    .filter(candidate => now > candidate.emitted)
    .map(({ point, emitted, group, order, amplitude, frequencyHz }) => {
      const front = { ...wavefront(localProfile(profile, point.z), point, now - emitted) };
      front.strength = frontStrength(amplitude, front.radiusMetres, frequencyHz);
      if (!profile.wind) return { source: point, group, order, ...front };
      // The wind carries the front with it, at its speed at the source's height (drawn only, class C).
      const seconds = now - emitted;
      const drift = axis => (profile.wind[axis] + profile.shear[axis] * point.z) * seconds;
      return { source: point, group, order, ...front, centre: { ...front.centre, x: front.centre.x + drift('x'), y: front.centre.y + drift('y') } };
    });
}

views.forEach(view => view.setAnimation(animationState));

let animating = false;

function startAnimation() {
  if (animating) return;
  animating = true;
  requestAnimationFrame(animate);
}

function animate() {
  const clock = player.clock();
  redrawViews();
  drawResults(clock ? clock.sceneSeconds() : null, { frame: true });
  drawTimeline(clock && player.playing() ? clock.sceneSeconds() : null);
  if (player.playing()) requestAnimationFrame(animate);
  else { animating = false; drawStill(); }
}

function drawStill() {
  redrawViews();
  drawResults();
  drawTimeline(state.pause?.seconds ?? null);
}

function playbackClock() {
  const pause = state.pause;
  return player.clock() ?? (pause ? { skippedSeconds: pause.skippedSeconds ?? 0, sceneSeconds: () => pause.seconds } : null);
}

function drawTimeline(seconds) {
  const holder = $('cube-timeline');
  const result = state.results?.get(focusReceiver().id);
  if (seconds === null || !result) { holder.hidden = true; return; }
  holder.hidden = false;
  const end = result.startSeconds + result.samples.length / result.sampleRate;
  const share = value => `${Math.min(100, Math.max(0, value / end * 100))}%`;
  // Always two decimals, so the clock keeps its width as it counts.
  $('cube-timeline-time').textContent = `${Math.max(0, seconds).toFixed(2)} s`;
  $('cube-timeline-arrival').style.left = share(result.startSeconds);
  $('cube-timeline-progress').style.width = share(seconds);
}

function showPlaying() {
  syncPlayButton();
  startAnimation();
}

let resuming = null;

async function resumePlayback() {
  if (resuming) { resuming.again = true; return; }
  if (!player.playing() || !player.clock()) return;
  resuming = { again: false };
  let started = false;
  try {
    const current = await listening();
    // Playback may have stopped while the ear model ran.
    const clock = player.clock();
    if (!player.playing() || !clock) return;
    if (!current) { player.stop(); syncPlayButton(); return; }
    started = await player.play(current.composition, current.gain, {
      realDelay: state.preferences.realDelay, onEnded: syncPlayButton, atSceneSeconds: clock.sceneSeconds(), skippedSeconds: clock.skippedSeconds, continuing: true
    });
  } catch (error) {
    player.stop();
    syncPlayButton();
    setStatus(`Playback failed: ${error.message}`, true);
  } finally {
    const { again } = resuming;
    resuming = null;
    if (started) showPlaying();
    if (started && again) resumePlayback();
  }
}

/** Plays from where playback paused or was scrubbed to; call it first thing in a user gesture, which the audio context needs. */
async function startPlayback() {
  const unlocked = player.unlock(state.scene.render.sampleRate);
  const { results } = state;
  try {
    let current;
    let scene;
    do {
      scene = state.scene;
      current = await listening();
      // The render may have been replaced meanwhile.
      if (results !== state.results) return;
    } while (scene !== state.scene);
    if (!current) { setStatus('No sound reaches the listening microphones'); return; }
    await unlocked;
    const from = state.pause;
    state.pause = null;
    const options = { realDelay: state.preferences.realDelay, onEnded: syncPlayButton };
    if (from) Object.assign(options, { atSceneSeconds: from.seconds, skippedSeconds: from.skippedSeconds });
    if (await player.play(current.composition, current.gain, options)) showPlaying();
  } catch (error) {
    player.stop();
    syncPlayButton();
    setStatus(`Playback failed: ${error.message}`, true);
  }
}

function pausePlayback() {
  const clock = player.clock();
  if (!clock || !player.playing()) return;
  state.pause = { seconds: clock.sceneSeconds(), skippedSeconds: clock.skippedSeconds };
  player.stop();
  syncPlayButton();
}

$('play').addEventListener('click', () => {
  if (player.playing()) {
    state.pause = null;
    player.stop();
    syncPlayButton();
    return;
  }
  if (!state.results) {
    if (!operations.has('render')) {
      clearTimeout(state.renderTimer);
      startRender();
    }
    return;
  }
  startPlayback();
});

$('plot-play').addEventListener('click', () => {
  if (player.playing()) pausePlayback();
  else if (state.results) startPlayback();
});

for (const canvas of [$('waveform'), $('arrivals')]) {
  canvas.addEventListener('pointerdown', event => {
    if (!state.results || event.button !== 0) return;
    const seconds = plotSeconds(canvas, event.clientX);
    if (seconds === null) return;
    const clock = player.clock();
    const skippedSeconds = clock ? clock.skippedSeconds : state.pause?.skippedSeconds ?? null;
    if (player.playing()) { player.stop(); syncPlayButton(); }
    state.pause = { seconds, skippedSeconds };
    drawStill();
    canvas.setPointerCapture(event.pointerId);
    const move = moveEvent => {
      state.pause = { seconds: plotSeconds(canvas, moveEvent.clientX, true), skippedSeconds };
      drawStill();
    };
    const release = () => {
      canvas.removeEventListener('pointermove', move);
      canvas.removeEventListener('pointerup', release);
      canvas.removeEventListener('pointercancel', release);
      if (state.pause && state.results) startPlayback();
    };
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', release);
    canvas.addEventListener('pointercancel', release);
  });
}

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('save').addEventListener('click', () => {
  download('boomtect-scene.json', new Blob([serializeScene(state.scene)], { type: 'application/json' }));
});

$('open').addEventListener('click', () => $('open-file').click());
$('open-file').addEventListener('change', async () => {
  const file = $('open-file').files[0];
  $('open-file').value = '';
  if (!file) return;
  try {
    const scene = readScene(JSON.parse(await file.text()));
    state.scene = scene;
    state.selection = { type: 'emitter', id: scene.emitters[0].id };
    storeScene();
    state.preferences.mode = scene.mode;
    savePreferences();
    invalidateResults();
    refreshPanel();
    requestRender();
    setStatus(`Opened ${file.name}`);
  } catch (error) {
    setStatus(`Could not open ${file.name}: ${error.message}`, true);
  }
});

/**
 * The export plan and results of the scene without its terrain echoes, at the playback gain: the
 * scene rendered again with them switched off, or its own when it has none. The surroundings'
 * rumble, which stands in for the echoes when they are off, stays off too, so that the render with
 * echoes less this one is the echoes alone.
 */
async function withoutTerrainEchoes(gain) {
  if (!echoesActive(state.scene)) return { plan: exportPlan(state.scene, state.results, gain), results: state.results };
  const scene = structuredClone(state.scene);
  scene.terrain.echoes = false;
  scene.ground.surroundings = false;
  const results = await renderFull(scene);
  const plan = exportPlan(scene, results, gain);
  if (!plan) throw new Error('Nothing is heard without the terrain echoes.');
  return { plan, results };
}

/** The handoff of one microphone of a plan, its field (omni first) on the plan's timeline. */
const microphoneHandoff = (plan, results, microphone, file) => soundHandoff({
  withPlace: state.preferences.exportPlace ?? true,
  scene: plan.scene, receiver: plan.scene.receivers.find(receiver => receiver.id === microphone.receiverId),
  channels: microphone.channels, arrivals: results.get(microphone.receiverId).arrivals, fullScalePa: 1 / plan.gain,
  startSeconds: plan.everyone.startSeconds, file, terrainEchoes: false, appVersion: APP_VERSION, id: crypto.randomUUID(), createdAt: new Date().toISOString()
});

/** Sends a microphone's sound without terrain echoes to Echotect, opening it in another window. */
async function sendToEchotect(receiverId, trigger) {
  let link;
  try {
    link = openTect(ECHOTECT_URL, 'Echotect');
  } catch (error) {
    setStatus(error.message, true);
    return;
  }
  trigger.disabled = true;
  operation('send', 'Sending to Echotect');
  try {
    if (state.resultsPreview) await renderFull();
    const current = await listening();
    if (!current) throw new Error('A microphone must listen to set the level.');
    const { plan, results } = await withoutTerrainEchoes(current.gain);
    const microphone = plan.microphones.find(item => item.receiverId === receiverId);
    if (!microphone) throw new Error('The microphone has no sound.');
    const samples = microphone.channels[0].map(value => value * plan.gain);
    await link.send(handoffMessage(microphoneHandoff(plan, results, microphone, null), samples), [samples.buffer]);
    setStatus(`Sent ${microphone.name} to Echotect`);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), true);
  } finally {
    trigger.disabled = false;
    operation('send', null);
  }
}

/** What of the terrain echoes the exported files hold. */
const TERRAIN_ECHO_CHOICES = Object.freeze({ with: 'With', without: 'Without', only: 'Only' });
const exportEchoChoice = () => (TERRAIN_ECHO_CHOICES[state.preferences.exportEchoChoice] ? state.preferences.exportEchoChoice : 'with');

const EXPORT_LABELS = Object.freeze({ scene: 'Scene (JSON)', stereo: 'Stereo', microphones: 'Microphones', ambix: 'Ambisonics', echotect: 'Echotect' });
const formatBytes = bytes => (bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`);
let exportState = null;

function exportSelection() {
  return new Set([...document.querySelectorAll('#export-list input:checked')].map(input => input.value));
}

function updateExportSummary() {
  const { plan } = exportState;
  const selected = exportSelection();
  const echoes = $('export-echoes');
  const sizes = exportSizes(plan, selected, { echoFree: exportState.echoFree, withoutEchoes: echoes?.value === 'without' });
  for (const item of availableItems(plan)) $(`export-size-${item}`).textContent = formatBytes(sizes[item]);
  const count = [...selected].reduce((sum, item) => sum + itemFiles(plan, item), 0);
  const bytes = [...selected].reduce((sum, item) => sum + sizes[item], 0);
  $('export-summary').textContent = selected.size ? `${count} file${count === 1 ? '' : 's'} · ≈ ${formatBytes(bytes)}${count > 1 ? ' · ZIP' : ''}` : '';
  const aligned = selected.has('microphones') || selected.has('ambix');
  const timeline = aligned ? plan.everyone : plan.listening;
  $('export-contract').textContent = `${timeline.sampleRate / 1000} kHz · 32-bit float · full scale ${Number((1 / plan.gain).toPrecision(3)).toLocaleString('en')} Pa · from ${formatSeconds(timeline.startSeconds)} after the flash`;
  $('export-submit').disabled = selected.size === 0;
}

$('export').addEventListener('click', async () => {
  let current;
  if (state.resultsPreview) {
    try {
      await renderFull();
    } catch (error) {
      setStatus(error.message, true);
      return;
    }
  }
  try {
    current = await listening();
  } catch (error) {
    setStatus(`Ear model failed: ${error.message}`, true);
    return;
  }
  if (!current) return;
  const plan = exportPlan(state.scene, state.results, current.gain);
  if (!plan) return;
  exportState = { plan, composition: current.composition, echoFree: echoesActive(state.scene) ? echoFreeShare(state.results) : 1 };
  const chosen = new Set(state.preferences.exportItems ?? ['scene', 'stereo']);
  $('export-list').replaceChildren(...availableItems(plan).map(item => {
    const row = element('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', value: item, checked: chosen.has(item) });
    box.addEventListener('change', updateExportSummary);
    const text = element('span');
    text.append(element('strong', '', EXPORT_LABELS[item]));
    const size = element('small');
    size.id = `export-size-${item}`;
    row.append(box, text, size);
    return row;
  }));
  const options = [];
  {
    const row = element('label');
    const box = Object.assign(document.createElement('input'), { type: 'checkbox', id: 'export-place', checked: state.preferences.exportPlace ?? true });
    const text = element('span');
    text.append(element('strong', '', 'Place'));
    row.append(box, text, element('small', '', placeLabel(state.scene.place)));
    options.push(row);
  }
  if (echoesActive(state.scene)) {
    const row = element('label');
    const select = document.createElement('select');
    select.id = 'export-echoes';
    select.addEventListener('change', updateExportSummary);
    for (const [value, label] of Object.entries(TERRAIN_ECHO_CHOICES)) select.add(new Option(label, value, false, value === exportEchoChoice()));
    const text = element('span');
    text.append(element('strong', '', 'Terrain echoes'));
    row.append(element('span'), text, select);
    options.push(row);
  }
  $('export-options').replaceChildren(...options);
  $('export-name').value = state.preferences.exportName ?? `boomtect-${state.scene.mode}`;
  $('export-error').hidden = true;
  updateExportSummary();
  $('export-dialog').showModal();
  // Focus the dialog itself, so its first control is not ringed when it opens.
  $('export-dialog').focus();
});

$('export-all').addEventListener('click', () => {
  document.querySelectorAll('#export-list input').forEach(input => { input.checked = true; });
  updateExportSummary();
});

$('export-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (event.submitter?.value === 'cancel') { $('export-dialog').close(); return; }
  const name = $('export-name').value.trim();
  if (!name) { $('export-name').reportValidity(); return; }
  const selected = exportSelection();
  if (!selected.size) return;
  const echoes = $('export-echoes');
  state.preferences.exportItems = [...selected];
  state.preferences.exportName = name;
  if (echoes) state.preferences.exportEchoChoice = echoes.value;
  state.preferences.exportPlace = $('export-place').checked;
  savePreferences();
  const submit = $('export-submit');
  submit.disabled = true;
  $('export-error').hidden = true;
  operation('export', 'Exporting');
  try {
    const { plan: full, composition } = exportState;
    const stem = fileStem(name);
    // Without terrain echoes, the scene is rendered again with them switched off.
    const choice = echoes ? echoes.value : 'with';
    const dry = choice !== 'with' || (echoes && selected.has('echotect')) ? await withoutTerrainEchoes(full.gain) : { plan: full, results: state.results };
    const plan = choice === 'with' ? full : choice === 'without' ? dry.plan : exportPlan(state.scene, new Map(
      [...state.results].map(([id, result]) => [id, resultDifference(result, dry.results.get(id))])
    ), full.gain);
    if (!plan) throw new Error('Nothing is heard in the terrain echoes alone.');
    const echotect = { plan: dry.plan, handoff: (microphone, { file }) => microphoneHandoff(dry.plan, dry.results, microphone, file) };
    const files = await exportFiles(plan, selected, stem, ({ files: written, startSeconds, sampleRate }) => ({
      ...parseScene(state.scene),
      export: {
        listening: composition.kind,
        heads: composition.heads.map(head => ({ receiverId: head.receiverId, headingDegrees: head.headingDegrees, pitchDegrees: head.pitchDegrees })),
        omnis: composition.omnis.map(omni => omni.receiverId),
        files: written,
        ambisonics: plan.order > 0 ? AMBISONIC_CONVENTION : null,
        sampleRate,
        sampleFormat: 'ieee-float32',
        startSeconds,
        fullScalePa: 1 / plan.gain,
        peakPa: plan === full ? composition.peakPa : plan.listening.peakPa,
        terrainEchoContent: echoesActive(state.scene) ? choice : null,
        speedOfSoundMetresPerSecond: soundSpeedProfile(state.scene.air).groundSpeed,
        soundSpeedGradientPerSecond: soundSpeedProfile(state.scene.air).gradient,
        modelVersion: MODEL_VERSION,
        exportedAt: new Date().toISOString()
      }
    }), echotect);
    const { name: fileName, blob } = exportDownload(files, stem);
    download(fileName, blob);
    $('export-dialog').close();
  } catch (error) {
    $('export-error').textContent = error instanceof Error ? error.message : String(error);
    $('export-error').hidden = false;
  } finally {
    submit.disabled = false;
    operation('export', null);
  }
});

$('details-close').addEventListener('click', () => $('details').close());
$('details').addEventListener('close', () => { state.detailsId = null; });

document.querySelectorAll('.modes [data-mode]').forEach(button => button.addEventListener('click', () => {
  const mode = button.dataset.mode;
  if (mode === state.scene.mode) return;
  state.scene = restoredScene(mode);
  state.selection = { type: 'emitter', id: state.scene.emitters[0].id };
  state.preferences.mode = mode;
  savePreferences();
  views[0].setView(state.preferences.cubeViews?.[mode] ?? VIEW.box.defaultView);
  invalidateResults();
  refreshPanel();
  if (state.preferences.autoRender) startRender();
}));

const TOGGLES = Object.freeze({
  'auto-render': {
    read: () => state.preferences.autoRender,
    write: on => { state.preferences.autoRender = on; },
    after: () => { if (state.preferences.autoRender && !state.results && !operations.has('render')) startRender(); }
  },
  'real-delay': { read: () => state.preferences.realDelay, write: on => { state.preferences.realDelay = on; } },
  preview: {
    read: () => state.preferences.preview,
    write: on => { state.preferences.preview = on; },
    after: () => { invalidateResults(); requestRender(); }
  },
  wavefront: {
    read: wavefrontsShown,
    write: on => { state.preferences.wavefronts = { ...state.preferences.wavefronts, [state.scene.mode]: on }; },
    after: () => redrawViews()
  },
  cone: { read: () => state.preferences.cone, write: on => { state.preferences.cone = on; }, after: () => redrawViews() },
  clouds: { read: () => state.preferences.clouds, write: on => { state.preferences.clouds = on; }, after: () => redrawViews() },
  names: {
    read: () => state.preferences.names,
    write: on => { state.preferences.names = on; },
    after: () => {
      // Switched on over a terrain without names, it asks for them again: the service may have failed before.
      if (state.preferences.names && state.scene.terrain && !state.scene.terrain.names.length) loadPlaceNames(state.scene.terrain);
      redrawViews();
    }
  },
  map: { read: () => state.preferences.map, write: on => { state.preferences.map = on; }, after: () => redrawViews() }
});

function syncToggles() {
  for (const [id, { read }] of Object.entries(TOGGLES)) $(id).setAttribute('aria-pressed', String(Boolean(read())));
}

for (const [id, { read, write, after }] of Object.entries(TOGGLES)) {
  $(id).addEventListener('click', () => {
    write(!read());
    savePreferences();
    syncToggles();
    after?.();
  });
}
syncToggles();
$('attribution-button').addEventListener('click', () => {
  const open = $('attribution-text').hidden;
  $('attribution-text').hidden = !open;
  $('attribution-button').setAttribute('aria-expanded', String(open));
});
const ADD_EMITTERS = Object.freeze({
  lightning: [defaultLightning, 'Ground flash'], cloud: [defaultCloudFlash, 'Cloud flash'], storm: [defaultStorm, 'Storm'],
  meteor: [defaultMeteor, 'Meteor'], shower: [defaultShower, 'Shower'], formation: [defaultFormation, 'Formation'], booster: [defaultBooster, 'Booster'],
  whip: [defaultWhip, 'Whip'], flight: [defaultFlight, 'Flight'], fireworks: [defaultFireworks, 'Fireworks'], barrage: [defaultBarrage, 'Barrage'], blast: [defaultBlast, 'Blast']
});
for (const [prefix, [create, base]] of Object.entries(ADD_EMITTERS)) {
  $(`add-${prefix}`).addEventListener('click', () => addEmitter(scene => create(uniqueId(prefix, scene.emitters), `${base} ${scene.emitters.length + 1}`, newSeed())));
}
$('add-receiver').addEventListener('click', () => commit(scene => {
  const receiver = defaultReceiver(uniqueId('receiver', scene.receivers), `Mic ${scene.receivers.length + 1}`);
  receiver.positionMetres = { ...receiver.positionMetres, x: receiver.positionMetres.x + 1000 * scene.receivers.length };
  const source = scene.emitters.find(emitter => emitter.enabled) ?? scene.emitters[0];
  if (source) receiver.headingDegrees = headingToward(receiver.positionMetres, emitterAnchor(source));
  scene.receivers.push(receiver);
  select({ type: 'receiver', id: receiver.id });
}));

window.addEventListener('resize', () => drawResults());

refreshPanel();
if (state.preferences.autoRender) startRender(); else syncPlayButton();
