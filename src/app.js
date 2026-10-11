import { atmosphericAbsorptionNepersPerMetre } from './domain/air.js';
import { BLAST, FLIGHT, GROUND, MODEL_VERSION, REFERENCE_SOUND_PRESSURE_PA, RENDER, THUNDER, VIEW } from './domain/constants.js';
import { blastSources, emitterSources } from './domain/emitters.js';
import { EXPLOSIVE_TYPES } from './domain/explosives.js';
import { GROUND_LABELS, GROUND_TYPES } from './domain/ground.js';
import { emissionSeconds } from './domain/lightning.js';
import { newSeed } from './domain/random.js';
import { localProfile, PATH_DIRECT, PATH_SHADOW, pathProfile, soundSpeedProfile, travelSeconds, wavefront } from './domain/refraction.js';
import { addTails, arrivalTable, assemblePaths, finishSum, hasTails, joinResponses, partitionSeconds, prepareScene, sumSegments, tailSamples, tailStretches } from './domain/render.js';
import {
  defaultBarrage, defaultBlast, defaultCloudFlash, defaultFlight, defaultFormation, defaultMeteor, defaultShower, defaultLightning, defaultReceiver, defaultScene, defaultStorm, MODES, PARAMETERS, parseScene, serializeScene, TERRAIN_DEFAULTS
} from './domain/scene.js';
import { AMBISONIC_CONVENTION, availableItems, exportDownload, exportFiles, exportPlan, exportSizes, fileStem } from './ui/export-package.js';
import { formatMetres, formatSeconds, microphoneColor } from './ui/canvas.js';
import { actionField, checkboxField, numberField, pointFields, seedField, selectField, textField } from './ui/fields.js';
import { captureTerrain, fetchPlaceNames, searchPlace } from './ui/terrain-loader.js';
import { createPlaceMap } from './ui/place-map.js';
import { createCubeView } from './ui/cube-view.js';
import { createMapLayer } from './ui/map-layer.js';
import { cachedFlashes, cachedRounds, cachedTracks, currentSurface, isFlightKind, isTrackKind, useTerrain } from './ui/geometry-cache.js';
import { BODY_TYPES, carlsonBoom, machCone } from './domain/flight.js';
import { meteorBoom, meteorBursts, showerMembers } from './domain/meteor.js';
import { macrosFor } from './ui/macros.js';
import { composeListening, LISTENING_LABELS, listeningKind } from './ui/listening.js';
import { createOrientationBall } from './ui/orientation-ball.js';
import { createPlayer } from './ui/player.js';
import { drawArrivals, drawWaveform, plotSeconds } from './ui/plots.js';
import { attachSplitters } from './ui/splitters.js';

const sceneStorageKey = mode => `boomtect.scene.${mode}`;
const PREFERENCES_STORAGE_KEY = 'boomtect.preferences';
const WORKER_COUNT = Math.max(1, Math.min(RENDER.maximumWorkers, (navigator.hardwareConcurrency || 2) - 1));

const KIND_LABELS = Object.freeze({ blast: 'Blast', storm: 'Storm', barrage: 'Barrage', flight: 'Flight', formation: 'Formation', meteor: 'Meteor', shower: 'Shower' });
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
    const scene = parseScene(storage.read(sceneStorageKey(mode)));
    if (scene.mode === mode) return scene;
  } catch { /* A missing or outdated scene falls back to the default. */ }
  return defaultScene(mode);
}

const preferences = {
  // Wavefronts per mode, all shown at first.
  realDelay: true, wavefronts: { thunder: true, blast: true, sonic: true }, contours: true, names: true, map: false, cone: true, clouds: true, autoRender: true, mode: 'thunder',
  terrainDraft: { place: 'Koli', latitude: 63.0964, longitude: 29.8061, extentMetres: 5000, cellMetres: 30 }, cubeViews: {},
  panelWidth: 340, resultsHeight: 220,
  ...(storage.read(PREFERENCES_STORAGE_KEY) ?? {})
};
if (!MODES.includes(preferences.mode)) preferences.mode = 'thunder';

const state = {
  scene: restoredScene(preferences.mode),
  selection: null,
  results: null,
  /** Where paused or scrubbed playback stands: scene seconds and the lead-in it skips, or null. */
  pause: null,
  envelopes: new Map(),
  revision: 0,
  workers: [],
  renderTimer: null,
  watchdog: null,
  detailsId: null,
  /** The microphone the plots and scene facts follow; null follows the first listening one. */
  soloId: null,
  preferences
};
state.selection = { type: 'emitter', id: state.scene.emitters[0].id };

const player = createPlayer();
const liveFields = { receiver: null, orientation: null };

/** Rebuilds the panel at the next frame, at most once a frame. */
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

/** The topographic map on the floor, requested only once it is switched on. */
const mapLayer = createMapLayer(() => redrawViews());

const views = [createCubeView($('cube'), {
  // Each mode keeps its own view: a blast's box is far smaller than a storm's.
  onView: next => { state.preferences.cubeViews = { ...state.preferences.cubeViews, [state.scene.mode]: next }; savePreferences(); },
  onViewChange: () => orientationBall?.draw(),
  onSelect: selection => { select(selection); refreshPanel(); },
  onMove: (handle, point) => {
    const item = findItem(handle.type, handle.id);
    if (handle.field === 'flightHeading') {
      item.headingDegrees = Math.round((Math.atan2(point.x - item.startMetres.x, point.y - item.startMetres.y) * 180 / Math.PI + 360) % 360);
      invalidateResults();
      redrawViews();
      drawInfo();
      panelOnNextFrame();
      return;
    }
    if (handle.field === 'headingDegrees') {
      orient(item.id, Math.round((Math.atan2(point.x - item.positionMetres.x, point.y - item.positionMetres.y) * 180 / Math.PI + 360) % 360), item.pitchDegrees);
      return;
    }
    if (handle.field === 'cloudBaseMetres' || handle.field === 'cloudTopMetres') {
      const { cloudBaseMetres: base, cloudTopMetres: top } = PARAMETERS;
      const height = Math.round(point.z / 10) * 10;
      if (handle.field === 'cloudBaseMetres') item.cloudBaseMetres = Math.min(base.maximum, item.cloudTopMetres - THUNDER.minimumCloudDepthMetres, Math.max(base.minimum, height));
      else item.cloudTopMetres = Math.min(top.maximum, Math.max(top.minimum, item.cloudBaseMetres + THUNDER.minimumCloudDepthMetres, height));
    } else if (handle.field === 'radiusMetres') {
      item.radiusMetres = Math.round(Math.min(PARAMETERS.radiusMetres.maximum, Math.hypot(point.x - item.centreMetres.x, point.y - item.centreMetres.y)));
    } else {
      item[handle.field] = storedPoint(handle, item, point);
      // A receiver's fields follow directly; the panel of any other item is rebuilt once a frame.
      const live = liveFields[handle.type]?.[handle.field];
      if (live) {
        panelOnNextFrame.skip = true;
        live.set(item[handle.field]);
      }
    }
    invalidateResults();
    redrawViews();
    drawInfo();
    // The panel follows the handles, once a frame.
    if (!panelOnNextFrame.skip) panelOnNextFrame();
    panelOnNextFrame.skip = false;
  },
  onCommit: handle => (handle.field === 'headingDegrees' ? storeScene() : commit(() => {})),
  focus: () => focusReceiver(),
  contours: () => state.preferences.contours,
  names: () => state.preferences.names,
  map: () => (state.preferences.map && state.scene.terrain?.enabled ? mapLayer.tiles(state.scene.terrain) : null),
  clouds: () => state.preferences.clouds
})];

/** Whether a point is stored as a height above the ground under it rather than above the datum. */
function groundAnchored(handle, item) {
  if (handle.field === 'centreMetres') return true;
  if (handle.field === 'baseMetres') return item.flashType === 'cloud-to-ground';
  return handle.field === 'positionMetres';
}

/**
 * The stored form of a dragged point. The view moves points in the scene frame; a point anchored
 * to the ground keeps its height above the ground while it moves sideways, and on a wall its new
 * height is measured from the ground under it.
 */
function storedPoint(handle, item, point) {
  if (!groundAnchored(handle, item)) return point;
  if (handle.onGround) return { ...point, z: 0 };
  if (handle.plane?.fixed === 'z') return { ...point, z: item[handle.field].z };
  const above = point.z - currentSurface().heightAt(point.x, point.y);
  return { ...point, z: Math.round(Math.min(PARAMETERS.heightMetres.maximum, Math.max(0, above)) * 10) / 10 };
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

/** Selecting a microphone also makes the plots follow it. */
function select(selection) {
  state.selection = selection;
  if (selection.type === 'receiver') state.soloId = selection.id;
}

/** The last message in the scene's corner: a note fades after VIEW.statusSeconds, an error stays until the next message. */
function setStatus(text, error = false) {
  const status = $('status');
  clearTimeout(setStatus.timer);
  status.textContent = text;
  status.classList.toggle('error', error);
  status.classList.remove('faded');
  if (text && !error) setStatus.timer = setTimeout(() => status.classList.add('faded'), VIEW.statusSeconds * 1000);
}

/** Applies a change to a copy of the scene and keeps it only if the result validates. */
function commit(change) {
  const next = structuredClone(state.scene);
  change(next);
  try {
    state.scene = parseScene(next);
  } catch (error) {
    setStatus(error.message, true);
    refreshPanel();
    return;
  }
  storage.write(sceneStorageKey(state.scene.mode), state.scene);
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

/**
 * Operations in progress, listed in the corner of the scene as compact bars: their text, how far they
 * have come where that is known, how long they have run, and for network requests the time at which
 * they give up. Each key holds one; a null text removes it.
 */
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
  // The clock in each bar keeps running while anything is in progress.
  if (operations.size && !operationsTimer) operationsTimer = setInterval(drawOperations, 500);
  if (!operations.size && operationsTimer) { clearInterval(operationsTimer); operationsTimer = null; }
}

/** An abort signal that fires after a limit, for a network request listed with that limit. */
const timeLimit = seconds => AbortSignal.timeout(seconds * 1000);

/** One button for the result: Render when there is none, Rendering while it is made, then Play and Stop. */
function syncPlayButton() {
  const button = $('play');
  const playing = player.playing();
  const rendering = operations.has('render');
  button.textContent = playing ? 'Stop' : rendering ? 'Rendering' : state.results ? 'Play' : 'Render';
  button.disabled = !playing && (rendering || (!state.results && !state.scene.emitters.some(emitter => emitter.enabled)));
  button.setAttribute('aria-pressed', playing ? 'true' : 'false');
  const pause = $('plot-play');
  pause.disabled = !state.results;
  pause.setAttribute('aria-label', playing ? 'Pause' : 'Play');
  pause.classList.toggle('playing', playing);
  $('results').classList.toggle('playable', Boolean(state.results));
}

/** Renders after a change: soon when Auto is on, otherwise when the button is pressed. */
function requestRender() {
  clearTimeout(state.renderTimer);
  if (state.preferences.autoRender) scheduleRender();
  else syncPlayButton();
}

function scheduleRender() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(startRender, RENDER.autoDelayMilliseconds);
}

function stopWorkers() {
  state.workers.forEach(worker => worker.terminate());
  state.workers = [];
  clearInterval(state.watchdog);
  operation('render', null);
}

/**
 * Starts a worker for the current revision. `onResult` gets its result message; errors, stalls, and
 * a newer revision end the whole render.
 */
function spawnWorker(revision, message, { onProgress, onResult }, transfer = []) {
  const worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
  state.workers.push(worker);
  worker.addEventListener('message', ({ data }) => {
    if (data.revision !== state.revision) return;
    state.heard = performance.now();
    if (data.type === 'progress') { onProgress?.(data.fraction); return; }
    if (data.type === 'error') {
      stopWorkers();
      setStatus(data.message, true);
      drawResults();
      return;
    }
    worker.terminate();
    onResult(data);
  });
  worker.addEventListener('error', event => {
    if (revision !== state.revision) return;
    stopWorkers();
    setStatus(event.message || 'The renderer failed to start.', true);
  });
  worker.postMessage({ revision, ...message }, transfer);
}

/**
 * Renders on a pool of workers in two steps. First the paths are traced: each receiver's sources
 * and echo places are split into contiguous parts across the workers, and the parts are put
 * together here into its paths and arrival table. Then each receiver's arrivals are split into
 * equal time ranges, with workers shared out by the number of paths; each worker receives its
 * receiver's traced paths rather than tracing them again. With more receivers than workers, each
 * worker traces and renders whole receivers. The segments are summed in range order, and the
 * diffuse tails are added once to the sum: their responses are made meanwhile, one worker per
 * receiver. Every worker gets the scene as it was when the render started.
 */
function startRender() {
  state.revision += 1;
  const revision = state.revision;
  stopWorkers();
  // A message about an earlier render no longer applies.
  setStatus('');
  const scene = state.scene;
  if (!scene.emitters.some(emitter => emitter.enabled)) {
    setStatus('No emitter is enabled.');
    drawResults();
    return;
  }
  let sources;
  let prepared;
  let workerCount = WORKER_COUNT;
  try {
    prepared = prepareScene(scene);
    sources = prepared.reduce((sum, item) => sum + item.sources.length, 0);
    workerCount = Math.max(1, Math.min(WORKER_COUNT, Math.floor(RENDER.sourceCopiesBudget / Math.max(1, sources))));
  } catch (error) {
    setStatus(error.message, true);
    drawResults();
    return;
  }
  const started = performance.now();
  state.heard = performance.now();
  operation('render', 'Tracing paths', { share: 0 });
  // Each receiver's channels are shared out over as many workers as there are for it.
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
    stopWorkers();
    setStatus(`The render stopped responding with ${sources.toLocaleString('en')} point sources, likely out of memory`, true);
    drawResults();
  }, 5000);
  // Each receiver's tracing is split into parts, so that its paths are traced on every worker; with
  // more receivers than workers each is traced whole. The parts come together here, in their order.
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
          // Each receiver's paths go on to the workers that render it, so none traces them again.
          tracedPaths = scene.receivers.map((receiver, receiverIndex) => assemblePaths(prepared, receiver, scene, traced[receiverIndex]));
          arrivals = scene.receivers.map((receiver, receiverIndex) => arrivalTable(prepared, receiver, scene, { paths: tracedPaths[receiverIndex] }));
        } catch (error) {
          stopWorkers();
          setStatus(error.message, true);
          drawResults();
          return;
        }
        renderRanges(revision, scene, arrivals, tracedPaths, responses, { sources, workerCount, started });
      }
    });
  }
}

/** The render jobs: receivers and a time range for each worker. */
function renderJobs(scene, arrivals, workerCount) {
  const receivers = scene.receivers.map((_, index) => index);
  if (receivers.length >= workerCount) {
    return Array.from({ length: workerCount }, (_, job) => ({ receivers: receivers.filter(index => index % workerCount === job), fromSeconds: -Infinity, toSeconds: Infinity }));
  }
  const total = arrivals.reduce((sum, table) => sum + table.count, 0) || 1;
  const shares = arrivals.map(table => Math.max(1, Math.floor(workerCount * table.count / total)));
  // Workers left over by rounding down go to the receivers with the most paths per worker.
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

/**
 * Sums each receiver's segments and adds its diffuse tails. Its pressure is cut into stretches,
 * shared out over the workers by length; the tails of each come back and are added to the sum.
 */
function addRenderTails(revision, scene, arrivals, parts, responses, info) {
  let sums;
  try {
    sums = scene.receivers.map((receiver, index) => sumSegments(receiverSegments(parts, receiver), scene.render.sampleRate, tailSamples(responses[index])));
  } catch (error) {
    stopWorkers();
    setStatus(error.message, true);
    drawResults();
    return;
  }
  const lengths = sums.map((sum, index) => (responses[index] ? sum.channels[0].length - tailSamples(responses[index]) : 0));
  const total = lengths.reduce((a, b) => a + b, 0);
  const jobs = lengths.flatMap((length, index) => (length > 0
    ? tailStretches(length, Math.max(1, Math.round(info.workerCount * length / total)), tailSamples(responses[index])).map(([from, to]) => ({ index, from, to }))
    : []));
  const finish = () => finishRender(scene, arrivals, sums, parts, { sources: info.sources, workers: info.workerCount, milliseconds: performance.now() - info.started });
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
  const speedOfSound = soundSpeedProfile(scene.air).groundSpeed;
  try {
    state.results = new Map(scene.receivers.map((receiver, receiverIndex) => {
      const segments = receiverSegments(parts, receiver);
      const combined = finishSum(sums[receiverIndex], scene.render.sampleRate);
      return [receiver.id, {
        receiverId: receiver.id,
        sampleRate: scene.render.sampleRate,
        ...combined,
        samples: combined.channels[0],
        speedOfSound,
        arrivals: arrivals[receiverIndex],
        nonlinearPaths: segments.reduce((sum, segment) => sum + segment.nonlinearPaths, 0),
        modelVersion: MODEL_VERSION
      }];
    }));
  } catch (error) {
    setStatus(error.message, true);
    drawResults();
    return;
  }
  state.envelopes = envelopes([...state.results.values()]);
  earCache.clear();
  setStatus(`Rendered ${info.sources.toLocaleString('en')} point sources in ${(info.milliseconds / 1000).toFixed(1)} s on ${info.workers} threads`);
  operation('render', null);
  $('export').disabled = false;
  drawResults();
  drawInfo();
  prepareEar();
}

/**
 * RMS envelopes in VIEW.envelopeSeconds windows for every microphone, on one decibel scale from the
 * loudest window of any microphone (1) down VIEW.envelopeRangeDb (0), so their rings compare.
 */
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

/** The receiver the plots and scene facts follow: the solo one, or the first listening one, heads first. */
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

/** The ear model on a worker: each part's channels (transferred) processed with one setting. */
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

/**
 * The composition as the optional ear model hears it: each listener's channels processed by the
 * reflex and loudness model, driven by its own pressure. It runs on a worker, started after each
 * render and listening change, so Play finds it ready. Cached per render and setting; a request for
 * parts on their way waits for them.
 */
async function earApplied(composition) {
  const { earReflex: reflex, earLoudness: loudness } = state.scene.render;
  if (!composition || (!reflex && !loudness)) return composition;
  const results = state.results;
  const key = part => `${part.receiverId}:${reflex}:${loudness}:${composition.startSeconds}:${composition.length}`;
  const parts = [...composition.heads.map(head => ({ part: head, channels: head.channels })), ...composition.omnis.map(omni => ({ part: omni, channels: [omni.channel] }))];
  const missing = parts.filter(({ part }) => earCache.get(key(part))?.results !== results);
  if (missing.length) {
    earPending += 1;
    operation('ear', 'Ear model');
    const batch = earOnWorker(missing.map(({ channels }) => channels), composition.sampleRate, { reflex, loudness });
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
  return { ...composition, heads, omnis, peakPa };
}

/** Starts the ear model for the current listening, if it is on, so that Play need not wait for it. */
function prepareEar() {
  const { earReflex, earLoudness } = state.scene.render;
  if (!state.results || (!earReflex && !earLoudness)) return;
  listening().catch(error => setStatus(`Ear model failed: ${error.message}`, true));
}

/**
 * What Play and Export use: the composition of the listening microphones and its gain. Binaural
 * decoding gets 3 dB more room; a mix of several parts is scaled by 1/sqrt of their number.
 */
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

/* Panel */

function emitterKindLabel(emitter) {
  return emitter.kind === 'lightning' ? FLASH_TYPE_LABELS[emitter.flashType] : KIND_LABELS[emitter.kind];
}

const updateEmitter = (id, change) => commit(scene => change(scene.emitters.find(emitter => emitter.id === id)));
const updateReceiver = (id, change) => commit(scene => change(scene.receivers.find(receiver => receiver.id === id)));

/** A change shown at once while a slider moves; `commit` validates and renders when it ends. */
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

/** One line describing what an emitter currently is. */
function emitterSummary(emitter) {
  if (emitter.kind === 'blast') return `${+emitter.chargeKilograms.toPrecision(3)} kg TNT at ${formatMetres(emitter.positionMetres.z)}`;
  if (emitter.kind === 'meteor') return `${+emitter.diameterMetres.toPrecision(3)} m meteoroid at ${emitter.speedKilometresPerSecond} km/s, ${emitter.entryDegrees}° down from ${formatMetres(emitter.startMetres.z)}`;
  if (emitter.kind === 'shower') return `${emitter.meteorCount} meteoroids of about ${+emitter.diameterMetres.toPrecision(3)} m over ${emitter.durationSeconds} s`;
  if (isFlightKind(emitter)) return `${emitter.kind === 'formation' ? `${emitter.memberCount} × ` : ''}${FLIGHT.bodies[emitter.body].label} at Mach ${emitter.mach.toFixed(2)} and ${formatMetres(emitter.startMetres.z)} for ${emitter.durationSeconds} s`;
  if (emitter.kind === 'barrage') {
    const salvos = Math.ceil(emitter.roundCount / emitter.salvoSize);
    return `${emitter.roundCount} rounds of ${+emitter.chargeKilograms.toPrecision(3)} kg TNT in ${salvos} salvo${salvos > 1 ? 's' : ''} over ${emitter.durationSeconds} s`;
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

/** Sets a slider's filled track from `from` to `to`, positions in [0, 1] of its range. */
function paintTrack(element, from, to) {
  const at = t => `calc(${VIEW.panels.thumbHalfPixels}px + (100% - ${2 * VIEW.panels.thumbHalfPixels}px) * ${t})`;
  element.style.setProperty('--from', from === 0 ? '0%' : at(from));
  element.style.setProperty('--to', at(to));
}

/** Keeps the scene box still while a slider moves, and lets it fit the scene again when it ends. */
function holdViews(on) {
  views.forEach(view => view.hold(on));
}

function macroRow(container, emitter, macro) {
  const id = `macro-${emitter.id}-${macro.label}`;
  const label = element('label', '', macro.label);
  label.htmlFor = id;
  const steps = macro.steps ?? VIEW.panels.macroSteps;
  const value = element('span', 'macro-value', macro.show(emitter));
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
    // The lower input's track shows the fill between the handles; the upper one's is transparent.
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

function emitterCard(container, emitter, selected) {
  const { scene } = state;
  const card = element('div', 'card');
  card.setAttribute('aria-selected', String(selected));
  const header = element('div', 'card-header');
  header.tabIndex = 0;
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', String(selected));
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = emitter.enabled;
  checkbox.title = 'Enabled';
  checkbox.addEventListener('click', event => event.stopPropagation());
  checkbox.addEventListener('change', () => updateEmitter(emitter.id, item => { item.enabled = checkbox.checked; }));
  header.append(checkbox, element('span', 'name', emitter.name), element('span', 'kind', emitterKindLabel(emitter)));
  const select = () => { state.selection = selected ? { type: null, id: null } : { type: 'emitter', id: emitter.id }; refreshPanel(); };
  header.addEventListener('click', select);
  header.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  card.append(header);
  if (selected) {
    card.append(element('p', 'card-summary', emitterSummary(emitter)));
    const macros = element('div', 'macros');
    macrosFor(emitter).forEach(macro => macroRow(macros, emitter, macro));
    card.append(macros);
    const actions = element('div', 'card-actions');
    actions.append(button('Details…', () => openDetails(emitter.id)));
    // A flight has no seed to draw anew.
    if (emitter.kind !== 'blast' && emitter.kind !== 'meteor' && !isFlightKind(emitter)) {
      actions.append(button('New shape', () => updateEmitter(emitter.id, item => { item.seed = newSeed(); }), { title: 'Same parameters, new seed' }));
      actions.append(button('Variant', () => addEmitter(next => {
        const source = next.emitters.find(item => item.id === emitter.id);
        source.enabled = false;
        return { ...structuredClone(source), id: uniqueId(source.kind, next.emitters), name: `${source.name} variant`.slice(0, 64), seed: newSeed(), enabled: true };
      }), { disabled: scene.emitters.length >= RENDER.maximumEmitters, title: 'Copy with a new seed; the original is switched off' }));
    }
    actions.append(button('Remove', () => commit(next => { next.emitters = next.emitters.filter(item => item.id !== emitter.id); }), { disabled: scene.emitters.length <= 1 }));
    card.append(actions);
  }
  container.append(card);
}

/**
 * Applies a listening change — which microphones listen, their type, or their orientation — and
 * keeps the render, since every microphone is rendered as a full field.
 */
function commitListening(change) {
  const next = structuredClone(state.scene);
  change(next);
  try {
    state.scene = parseScene(next);
  } catch (error) {
    setStatus(error.message, true);
    refreshPanel();
    return;
  }
  storage.write(sceneStorageKey(state.scene.mode), state.scene);
  refreshPanel();
  drawInfo();
  if (player.playing()) resumePlayback();
  else prepareEar();
}

/** Live orientation while a control moves; stored when it ends. */
function orient(receiverId, headingDegrees, pitchDegrees) {
  const item = state.scene.receivers.find(candidate => candidate.id === receiverId);
  item.headingDegrees = headingDegrees;
  item.pitchDegrees = pitchDegrees;
  player.setOrientation(receiverId, headingDegrees, pitchDegrees);
  if (liveFields.orientation?.receiverId === receiverId) liveFields.orientation.set(item);
  if (orientationTarget()?.id === receiverId) orientationBall.set(item);
  $('cube-orientation-value').textContent = `${compassLabel(headingDegrees)} · ${pitchDegrees > 0 ? '+' : ''}${pitchDegrees}°`;
  redrawViews();
}

/** The binaural receiver whose orientation the sphere shows: the selected one, or the first listening head. */
function orientationTarget() {
  const selected = state.selection.type === 'receiver' ? findItem('receiver', state.selection.id) : null;
  if (selected?.type === 'binaural') return selected;
  return state.scene.receivers.find(receiver => receiver.listen && receiver.type === 'binaural') ?? null;
}

function drawOrientation() {
  const target = orientationTarget();
  $('cube-orientation').hidden = !target;
  if (!target) return;
  $('cube-orientation-name').textContent = target.name;
  $('cube-orientation-value').textContent = `${compassLabel(target.headingDegrees)} · ${target.pitchDegrees > 0 ? '+' : ''}${target.pitchDegrees}°`;
  orientationBall.set(target);
}

function storeScene() {
  storage.write(sceneStorageKey(state.scene.mode), state.scene);
}

const RECEIVER_TYPE_LABELS = Object.freeze({ omni: 'Omni', binaural: 'Binaural' });

function receiverCard(container, receiver, selected) {
  const card = element('div', 'card');
  card.setAttribute('aria-selected', String(selected));
  const header = element('div', 'card-header');
  header.tabIndex = 0;
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', String(selected));
  const checkbox = element('input');
  checkbox.type = 'checkbox';
  checkbox.checked = receiver.listen;
  checkbox.title = 'Listen';
  checkbox.addEventListener('click', event => event.stopPropagation());
  checkbox.addEventListener('change', () => commitListening(next => { next.receivers.find(item => item.id === receiver.id).listen = checkbox.checked; }));
  header.append(checkbox, element('span', 'name', receiver.name), element('span', 'kind', `${RECEIVER_TYPE_LABELS[receiver.type]} · ${formatMetres(receiver.positionMetres.z)}`));
  const choose = () => { select(selected ? { type: null, id: null } : { type: 'receiver', id: receiver.id }); refreshPanel(); };
  header.addEventListener('click', choose);
  header.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); choose(); } });
  card.append(header);
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
        key: 'headingDegrees', value: receiver.headingDegrees,
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
    actions.append(button('Remove', () => commit(next => { next.receivers = next.receivers.filter(item => item.id !== receiver.id); }), { disabled: state.scene.receivers.length <= 1 }));
    card.append(actions);
  }
  container.append(card);
}

/** Every detailed parameter of an emitter, grouped, in a modal dialog. */
function detailSections(emitter) {
  const set = key => value => updateEmitter(emitter.id, item => { item[key] = value; });
  const section = (title, build) => ({ title, build });
  const numbers = keys => container => keys.forEach(key => numberField(container, { key, value: emitter[key], onCommit: set(key) }));
  const placement = container => {
    textField(container, { label: 'Name', value: emitter.name, onCommit: set('name') });
    if (emitter.kind !== 'blast' && emitter.kind !== 'meteor' && !isFlightKind(emitter)) seedField(container, { value: emitter.seed, onCommit: set('seed'), onNew: () => set('seed')(newSeed()) });
    numberField(container, { key: 'startSeconds', value: emitter.startSeconds, onCommit: set('startSeconds') });
  };
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
        // Editing the length or shape makes the body custom.
        for (const key of ['lengthMetres', 'shapeFactor']) {
          numberField(container, { key, value: emitter[key], onCommit: value => updateEmitter(emitter.id, item => { item[key] = value; item.body = 'custom'; }) });
        }
        numbers(['riseTimeSeconds'])(container);
      })
    ];
  }
  if (emitter.kind === 'barrage') {
    return [
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Centre', point: emitter.centreMetres, axes: ['x', 'y'], onCommit: set('centreMetres') });
      }),
      section('Rounds', numbers(['radiusMetres', 'durationSeconds', 'roundCount', 'salvoSize', 'salvoSpreadSeconds', 'chargeSpread', 'airburstShare', 'airburstHeightMetres'])),
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
  }
  if (emitter.kind === 'storm') {
    return [
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Centre', point: emitter.centreMetres, axes: ['x', 'y'], onCommit: set('centreMetres') });
      }),
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
}

function openDetails(id) {
  state.detailsId = id;
  renderDetails();
  if ($('details').open) return;
  $('details').showModal();
  // The dialog itself takes focus, so its first button is not ringed when it opens; Tab enters it.
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

/** Half the side of the square around the origin that holds every emitter and microphone. */
function sceneHalfExtentMetres(scene) {
  let reach = 0;
  const include = point => { reach = Math.max(reach, Math.abs(point.x), Math.abs(point.y)); };
  for (const emitter of scene.emitters) {
    if (emitter.kind === 'blast') include(emitter.positionMetres);
    else if (isTrackKind(emitter)) { for (const path of cachedTracks(emitter, scene.air)) path.x.forEach((x, index) => include({ x, y: path.y[index] })); }
    else if (emitter.kind === 'storm' || emitter.kind === 'barrage') { include({ x: Math.abs(emitter.centreMetres.x) + emitter.radiusMetres, y: Math.abs(emitter.centreMetres.y) + emitter.radiusMetres }); }
    else for (const flash of cachedFlashes(emitter)) for (const channel of flash.channels) channel.points.forEach(include);
  }
  scene.receivers.forEach(receiver => include(receiver.positionMetres));
  return reach * GROUND.terrain.edgeMargin + GROUND.terrain.marginMetres;
}

/**
 * Once terrain is in use, a scene that grows past its edge gets a wider capture around the same
 * origin, at the same resolution and up to the largest area. Nothing is fetched without terrain.
 */
function scheduleTerrainCoverage() {
  clearTimeout(terrainCoverageTimer);
  terrainCoverageTimer = setTimeout(async () => {
    const { terrain } = state.scene;
    if (!terrain?.enabled || terrainCoverageRunning) return;
    const needed = neededTerrainExtentMetres(state.scene);
    if (needed <= terrain.extentMetres) return;
    terrainCoverageRunning = true;
    try {
      const draft = { place: terrain.place, latitude: terrain.latitude, longitude: terrain.longitude, extentMetres: needed, cellMetres: state.preferences.terrainDraft.cellMetres };
      const wider = await captureTerrain(draft, {
        onProgress: share => operation('terrain', `Widening terrain to ${formatMetres(needed)}`, { share })
      });
      Object.assign(state.preferences.terrainDraft, { extentMetres: needed });
      savePreferences();
      // The names already found stay until those of the wider area arrive.
      commit(next => {
        const kept = next.terrain && Object.fromEntries(Object.keys(TERRAIN_DEFAULTS).map(key => [key, next.terrain[key]]));
        next.terrain = { ...wider, ...kept, names: next.terrain?.names ?? [] };
      });
      loadPlaceNames(state.scene.terrain);
    } catch (error) {
      setStatus(`The terrain could not be widened: ${error.message}`, true);
    } finally {
      terrainCoverageRunning = false;
      operation('terrain', null);
    }
  }, GROUND.terrain.coverageDelayMilliseconds);
}

/**
 * The side of terrain, in whole half kilometres up to the largest, that holds the whole scene, with a
 * margin: channels drawn again over the terrain reach a little farther than over level ground.
 */
const neededTerrainExtentMetres = (scene, margin = 1) => Math.min(PARAMETERS.terrainExtentMetres.maximum, Math.ceil(2 * margin * sceneHalfExtentMetres(scene) / 500) * 500);

let placeNamesLoading = false;

/**
 * Place names for a terrain, fetched last and on their own: the terrain and the render do not wait for
 * them, they change nothing that is heard, so they join the scene without a new render, and names
 * already shown stay when the service cannot be reached.
 */
async function loadPlaceNames(terrain) {
  if (placeNamesLoading) return;
  placeNamesLoading = true;
  $('names').disabled = true;
  operation('names', 'Place names', { limitSeconds: GROUND.terrain.placeNamesLimitSeconds });
  let names = null;
  try {
    names = await fetchPlaceNames(terrain, timeLimit(GROUND.terrain.placeNamesLimitSeconds));
  } catch {
    // Given up at its time limit: the names already shown stay.
  } finally {
    operation('names', null);
    placeNamesLoading = false;
    $('names').disabled = false;
  }
  if (!names || state.scene.terrain?.heights !== terrain.heights) return;
  state.scene.terrain.names = names;
  storage.write(sceneStorageKey(state.scene.mode), state.scene);
  redrawViews();
}

/** Where and how finely terrain is captured next; editing it does not change the loaded terrain. */
function terrainPanel(container) {
  const { scene } = state;
  const draft = state.preferences.terrainDraft;
  const setDraft = change => { Object.assign(draft, change); savePreferences(); };
  const load = async trigger => {
    trigger.disabled = true;
    // At least the area the scene needs, so that the terrain is not widened again right after.
    const extentMetres = Math.max(draft.extentMetres, neededTerrainExtentMetres(state.scene, GROUND.terrain.loadMargin));
    try {
      const terrain = await captureTerrain({ ...draft, extentMetres }, {
        onProgress: share => operation('terrain', `Loading terrain ${formatMetres(extentMetres)}`, { share })
      });
      setDraft({ extentMetres });
      commit(next => { next.terrain = terrain; });
      loadPlaceNames(state.scene.terrain);
    } catch (error) {
      setStatus(`The terrain could not be loaded: ${error.message}`, true);
    } finally {
      trigger.disabled = false;
      operation('terrain', null);
    }
  };
  const mapButton = button('', () => openPlaceDialog(load), { title: 'Choose on a map' });
  mapButton.className = 'map-button';
  mapButton.innerHTML = '<svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><path d="M1 3l4-2 4 2 4-2v10l-4 2-4-2-4 2z M5 1v10 M9 3v10" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';
  mapButton.setAttribute('aria-label', 'Choose on a map');
  actionField(container, {
    label: 'Place', value: draft.place, action: 'Find', extra: mapButton,
    onAction: async (text, trigger) => {
      trigger.disabled = true;
      operation('place', `Finding ${text}`, { limitSeconds: GROUND.terrain.placeSearchLimitSeconds });
      try {
        const found = await searchPlace(text, { signal: timeLimit(GROUND.terrain.placeSearchLimitSeconds) });
        operation('place', null);
        if (!found) { setStatus(`No place found for ${text}`, true); return; }
        setDraft({ place: text, latitude: +found.latitude.toFixed(5), longitude: +found.longitude.toFixed(5) });
        setStatus(found.name);
        await load(trigger);
      } catch (error) {
        setStatus(`The place search failed: ${error.message}`, true);
      } finally {
        trigger.disabled = false;
        operation('place', null);
      }
    }
  });
  for (const [key, field] of [['latitude', 'latitude'], ['longitude', 'longitude'], ['terrainExtentMetres', 'extentMetres'], ['terrainCellMetres', 'cellMetres']]) {
    numberField(container, { key, value: draft[field], onCommit: value => setDraft({ [field]: value }) });
  }
  const actions = element('div', 'field-actions');
  actions.append(button(scene.terrain ? 'Load again' : 'Load terrain', event => load(event.currentTarget)));
  if (scene.terrain) actions.append(button('Remove', () => commit(next => { next.terrain = null; })));
  container.append(actions);
  if (!scene.terrain) return;
  const { terrain } = scene;
  const surface = currentSurface();
  container.append(element('p', 'field-note', `${terrain.place || `${terrain.latitude}, ${terrain.longitude}`} · ${formatMetres(terrain.extentMetres)} at ${formatMetres(terrain.cellMetres)}`
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
let placeLoad = null;
/** The text whose place the map shows, so that Load can tell a name typed but not yet found. */
let placeShown = '';

function showPlaceCoordinates({ latitude, longitude }) {
  $('place-coordinates').textContent = `${latitude.toFixed(4)}, ${longitude.toFixed(4)}`;
}

/** Opens the map at the draft place; Load takes the map's centre as the origin and loads its terrain. */
function openPlaceDialog(load) {
  const draft = state.preferences.terrainDraft;
  placeLoad = load;
  $('place-query').value = draft.place;
  placeShown = draft.place;
  $('place-dialog').showModal();
  // The dialog itself takes focus, so its first control is not ringed when it opens.
  $('place-dialog').focus();
  placeMap.show(draft, draft.extentMetres);
  showPlaceCoordinates(draft);
}

/** Moves the map to a place found by name; false when none is found. */
async function showFoundPlace(text) {
  operation('place', `Finding ${text}`, { limitSeconds: GROUND.terrain.placeSearchLimitSeconds });
  try {
    const found = await searchPlace(text, { signal: timeLimit(GROUND.terrain.placeSearchLimitSeconds) });
    if (!found) { setStatus(`No place found for ${text}`, true); return false; }
    placeMap.show(found, state.preferences.terrainDraft.extentMetres);
    showPlaceCoordinates(found);
    placeShown = text;
    return true;
  } catch (error) {
    setStatus(`The place search failed: ${error.message}`, true);
    return false;
  } finally {
    operation('place', null);
  }
}

$('place-search').addEventListener('submit', event => {
  event.preventDefault();
  const text = $('place-query').value.trim();
  if (text) showFoundPlace(text);
});
// Moving the map makes its centre the place, whatever name the field holds.
$('place-overlay').addEventListener('pointerdown', () => { placeShown = $('place-query').value.trim(); });
$('place-cancel').addEventListener('click', () => $('place-dialog').close());
$('place-done').addEventListener('click', async () => {
  const text = $('place-query').value.trim();
  if (text && text !== placeShown && !(await showFoundPlace(text))) return;
  const { latitude, longitude } = placeMap.centre();
  const draft = state.preferences.terrainDraft;
  const typed = $('place-query').value.trim();
  Object.assign(draft, { latitude: +latitude.toFixed(5), longitude: +longitude.toFixed(5), place: typed || `${latitude.toFixed(4)}, ${longitude.toFixed(4)}` });
  savePreferences();
  $('place-dialog').close();
  refreshPanel();
  placeLoad?.($('place-done'));
});

/**
 * Runs a rebuild of form fields and puts the focus back in the field that had it, found by its place
 * among the fields and its parameter: a step from a number field's arrows or keys rebuilds the panel,
 * and without this the next step would go nowhere.
 */
function keepingFocus(root, rebuild) {
  const focused = document.activeElement;
  const fields = () => [...root.querySelectorAll('input, select')];
  const index = root.contains(focused) ? fields().indexOf(focused) : -1;
  rebuild();
  if (index < 0) return;
  const again = fields()[index];
  if (again && again.dataset.key === focused.dataset.key && again.type === focused.type) again.focus({ preventScroll: true });
}

/**
 * Rebuilds the panel, but not under a number field that has the focus: replacing it would end its
 * arrows' and keys' steps (in Safari even with the focus put back). The rebuild waits until the focus
 * leaves the field, a frame later, so a field clicked next is found again.
 */
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
  }
  checkboxField(environment, { label: 'Air absorption', value: scene.air.absorption, reliability: 'B', onCommit: value => commit(next => { next.air.absorption = value; }) });
  checkboxField(environment, { label: 'Ground reflection', value: scene.ground.enabled, reliability: 'B', onCommit: value => commit(next => { next.ground.enabled = value; }) });
  selectField(environment, {
    label: 'Ground', value: scene.ground.type, reliability: 'B',
    options: GROUND_TYPES.map(type => [type, GROUND_LABELS[type]]),
    onCommit: value => commit(next => { next.ground.type = value; })
  });
  checkboxField(environment, { label: 'Forest', value: scene.ground.forest, reliability: 'B', onCommit: value => commit(next => { next.ground.forest = value; }) });
  if (scene.ground.forest) numberField(environment, { key: 'treeHeightMetres', value: scene.ground.treeHeightMetres, onCommit: value => commit(next => { next.ground.treeHeightMetres = value; }) });
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
    // The level sets the gain of playback and export only, so the result stays.
    onCommit: value => commitListening(next => { next.render.levelMode = value; })
  });
  if (scene.render.levelMode === 'fixed') {
    numberField(output, { key: 'fullScalePa', value: scene.render.fullScalePa, onCommit: value => commitListening(next => { next.render.fullScalePa = value; }) });
  }
  checkboxField(output, { label: 'Ear reflex', value: scene.render.earReflex, reliability: 'B', onCommit: value => commitListening(next => { next.render.earReflex = value; }) });
  checkboxField(output, { label: 'Loudness', value: scene.render.earLoudness, reliability: 'C', onCommit: value => commitListening(next => { next.render.earLoudness = value; }) });
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

/** A heading as degrees and the nearest compass direction. */
function compassLabel(degrees) {
  return `${Math.round(degrees)}° ${COMPASS[Math.round(degrees / 45) % 8]}`;
}

/** Distance and compass direction from one point to another, along the ground. */
function bearing(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const angle = (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
  return { metres: Math.hypot(dx, dy), direction: COMPASS[Math.round(angle / 45) % 8] };
}

function emitterAnchor(emitter) {
  if (emitter.kind === 'blast') return emitter.positionMetres;
  if (emitter.kind === 'storm' || emitter.kind === 'barrage') return emitter.centreMetres;
  if (isTrackKind(emitter)) return emitter.startMetres;
  return emitter.baseMetres;
}

/** Short facts around the scene box: the selection, the listening position, and warnings. */
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
    const anchorName = selected.kind === 'lightning' ? (selected.flashType === 'cloud-to-ground' ? 'ground point' : 'start') : selected.kind === 'storm' || selected.kind === 'barrage' ? 'centre' : isTrackKind(selected) ? 'start' : 'blast';
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
    else if (item.kind === 'barrage') cachedRounds(item).forEach(round => measure(round.positionMetres));
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
    if (scene.render.levelMode === 'fixed' && result.peakPa > scene.render.fullScalePa) listenInfo.append(element('span', 'warning', 'Peak above full scale: clips'));
  }
  if (scene.emitters.filter(item => item.enabled).length > 1) listenInfo.append(element('span', 'warning', 'Several emitters sound together'));
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

/* Results */

/**
 * Both plots show every microphone on one time axis: the listening ones in ink and the others
 * muted, or one soloed microphone over the dimmed rest.
 */
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

/** One tab per microphone when there are several; a tab solos its microphone, again to release. */
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

/* Playback */

/** Travel time of a blast's first sound from where it burst, in the scene frame, to the receiver the view follows. */
function arrivalDelay(from) {
  if (!from || !state.results) return 0;
  const to = placedPoint(focusReceiver().positionMetres);
  return travelSeconds(pathProfile(soundSpeedProfile(state.scene.air), from, to), from, to);
}

const isBlastKind = emitter => emitter.kind === 'blast' || emitter.kind === 'barrage';
const isMeteorKind = emitter => emitter.kind === 'meteor' || emitter.kind === 'shower';

/**
 * Every stroke of an emitter as its flash, scene time, and route; a blast's, a round's, and a
 * meteor's breakups and bursts also where they burst, as stored (`position`) and in the scene frame
 * over the terrain (`from`).
 */
function strokeTimeline(emitter) {
  if (emitter.kind === 'blast') return [{ flash: 0, time: emitter.startSeconds, route: [], position: emitter.positionMetres, from: placedPoint(emitter.positionMetres) }];
  if (isMeteorKind(emitter)) {
    return showerMembers(emitter).flatMap((meteor, index) => meteorBursts(meteor, state.scene.air).map(burst => ({ flash: index, time: burst.emissionSeconds, route: [], position: burst.positionMetres, from: burst.positionMetres })));
  }
  if (isTrackKind(emitter)) return [];
  if (emitter.kind === 'barrage') return cachedRounds(emitter).map((round, index) => ({ flash: index, time: round.startSeconds, route: [], position: round.positionMetres, from: placedPoint(round.positionMetres) }));
  return cachedFlashes(emitter).flatMap((flash, index) => flash.strokes.map(stroke => ({ flash: index, time: flash.startSeconds + stroke.offsetSeconds, route: stroke.route })));
}

/**
 * What the scene view shows at the playback clock: every stroke that has started and not yet
 * faded, and the listening receiver's level. A stroke's light runs its route
 * figuratively in VIEW.flash.traverseSeconds; physically a return stroke takes microseconds.
 */
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
  // Where each flight's body is at the clock, and its Mach cone.
  const flights = new Map();
  const cones = new Map();
  for (const emitter of state.scene.emitters) {
    if (!isTrackKind(emitter) || !emitter.enabled) continue;
    const paths = cachedTracks(emitter, state.scene.air);
    flights.set(emitter.id, paths.flatMap(path => {
      const index = Math.round((now - path.seconds[0]) / path.step);
      return index >= 0 && index < path.seconds.length ? [{ x: path.x[index], y: path.y[index], z: path.z[index] }] : [];
    }));
    if (state.preferences.cone) cones.set(emitter.id, paths.map(path => machCone(path, now, profile)).filter(Boolean));
  }
  return { strokes, receivers, sound, wavefronts, flights, cones };
}

/** Whether the scene's mode shows wavefronts. */
function wavefrontsShown() {
  return Boolean(state.preferences.wavefronts?.[state.scene.mode]);
}

const wavefrontSources = new WeakMap();

/** Each flash's and blast's amplitude at 1 m, Pa·m: a flash's from the energy of all its sources. */
function wavefrontAmplitudes(emitter) {
  const air = state.scene.air;
  if (emitter.kind === 'blast') return new Map([[emitter.id, blastSources(emitter, air)[0].amplitudePaMetres]]);
  if (isFlightKind(emitter)) {
    // A boom's pressure 1 km away times 1 km, so that the fronts fade roughly with it.
    const boom = carlsonBoom({ mach: Math.max(1.01, emitter.mach), vehiclePressurePa: air.pressureKpa * 1000, groundPressurePa: air.pressureKpa * 1000, vehicleSoundSpeed: 340, lengthMetres: emitter.lengthMetres, shapeFactor: emitter.shapeFactor, distanceMetres: 1000 });
    return new Map(cachedTracks(emitter, air).map((_, index) => [`${emitter.id}:${index}`, boom.overpressurePa * 1000]));
  }
  if (emitter.kind === 'meteor' || emitter.kind === 'shower') {
    // Each meteor's boom straight below the end of its trail times that distance.
    return new Map(showerMembers(emitter).map((meteor, index) => {
      const height = meteor.endHeightMetres;
      return [`${emitter.id}:${index}`, meteorBoom(meteor, air, height, height, air.pressureKpa * 1000).overpressurePa * height];
    }));
  }
  if (emitter.kind === 'barrage') return new Map(cachedRounds(emitter).map(round => [round.id, blastSources(round, air)[0].amplitudePaMetres]));
  const energy = new Map();
  for (const source of emitterSources(emitter, air, currentSurface()).sources) {
    const group = `${emitter.id}:${source.flash}`;
    energy.set(group, (energy.get(group) ?? 0) + source.amplitudePaMetres ** 2);
  }
  return new Map([...energy].map(([group, value]) => [group, Math.sqrt(value)]));
}

/**
 * Every enabled emitter's sampled source points with their emission times: a blast's point, and
 * the channel points of each flash's first stroke, which lead the later strokes' nested fronts.
 */
function wavefrontCandidates(scene) {
  if (wavefrontSources.has(scene)) return wavefrontSources.get(scene);
  const candidates = [];
  const amplitudes = new Map();
  for (const emitter of scene.emitters) {
    if (!emitter.enabled) continue;
    for (const [group, amplitude] of wavefrontAmplitudes(emitter)) amplitudes.set(group, amplitude);
    if (emitter.kind === 'blast') { candidates.push({ point: placedPoint(emitter.positionMetres), emitted: emitter.startSeconds, group: emitter.id }); continue; }
    if (isTrackKind(emitter)) {
      // Points along each body's path: their spheres together draw its Mach cone.
      cachedTracks(emitter, scene.air).forEach((path, member) => {
        const every = Math.max(1, Math.ceil(path.seconds.length / VIEW.wavefront.flightFronts));
        for (let index = 0; index < path.seconds.length; index += every) candidates.push({ point: { x: path.x[index], y: path.y[index], z: path.z[index] }, emitted: path.seconds[index], group: `${emitter.id}:${member}` });
      });
      continue;
    }
    if (emitter.kind === 'barrage') {
      cachedRounds(emitter).forEach(round => candidates.push({ point: placedPoint(round.positionMetres), emitted: round.startSeconds, group: round.id }));
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
  // Each keeps its place in the list, so that views can thin the fronts the same way in every frame.
  const sampled = candidates.filter((_, index) => index % stride === 0).map((candidate, order) => ({ ...candidate, order, amplitude: amplitudes.get(candidate.group) ?? 0 }));
  wavefrontSources.set(scene, sampled);
  return sampled;
}

const placedPoint = point => ({ ...point, z: currentSurface().heightAt(point.x, point.y) + point.z });

function wavefrontSpheres(now, profile) {
  const absorption = state.scene.air.absorption ? atmosphericAbsorptionNepersPerMetre(VIEW.wavefront.frequencyHz, state.scene.air) * 20 / Math.LN10 : 0;
  const strengthAt = (amplitude, radius) => {
    const level = 20 * Math.log10(Math.max(amplitude, 1e-30) / Math.max(radius, 1) / REFERENCE_SOUND_PRESSURE_PA) - absorption * radius;
    return Math.min(1, Math.max(0, (level - VIEW.wavefront.floorDb) / (VIEW.wavefront.topDb - VIEW.wavefront.floorDb)));
  };
  return wavefrontCandidates(state.scene)
    .filter(candidate => now > candidate.emitted)
    .map(({ point, emitted, group, order, amplitude }) => {
      const front = { ...wavefront(localProfile(profile, point.z), point, now - emitted) };
      front.strength = strengthAt(amplitude, front.radiusMetres);
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

/** The scene, the plots, and the clock at rest: stopped, or held where playback paused. */
function drawStill() {
  redrawViews();
  drawResults();
  drawTimeline(state.pause?.seconds ?? null);
}

/** The playback clock, or while paused one held where it paused. */
function playbackClock() {
  const pause = state.pause;
  return player.clock() ?? (pause ? { skippedSeconds: pause.skippedSeconds ?? 0, sceneSeconds: () => pause.seconds } : null);
}

/**
 * The scene clock while the sound plays: seconds since the flash, and a bar from the flash to the
 * end of what plays, dim until the first sound arrives at the followed microphone.
 */
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

function showStopped() {
  syncPlayButton();
}

function showPlaying() {
  syncPlayButton();
  startAnimation();
}

let resuming = null;

/**
 * After a listening change during playback, plays the new composition on from the same moment.
 * A change made while the previous one is still connecting is applied once that one has started.
 */
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
    if (!current) { player.stop(); showStopped(); return; }
    started = await player.play(current.composition, current.gain, {
      realDelay: state.preferences.realDelay, onEnded: showStopped, atSceneSeconds: clock.sceneSeconds(), skippedSeconds: clock.skippedSeconds
    });
  } catch (error) {
    player.stop();
    showStopped();
    setStatus(`Playback failed: ${error.message}`, true);
  } finally {
    const { again } = resuming;
    resuming = null;
    if (started) showPlaying();
    if (started && again) resumePlayback();
  }
}

/**
 * Plays from where playback paused or was scrubbed to, or from the start. Call it first thing in a
 * user gesture, which the audio context needs to start.
 */
async function startPlayback() {
  const unlocked = player.unlock(state.scene.render.sampleRate);
  const { results } = state;
  try {
    // A listening change made while the ear model ran asks for the composition again.
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
    const options = { realDelay: state.preferences.realDelay, onEnded: showStopped };
    if (from) Object.assign(options, { atSceneSeconds: from.seconds, skippedSeconds: from.skippedSeconds });
    if (await player.play(current.composition, current.gain, options)) showPlaying();
  } catch (error) {
    player.stop();
    showStopped();
    setStatus(`Playback failed: ${error.message}`, true);
  }
}

/** Holds playback where it is; Play goes on from there. */
function pausePlayback() {
  const clock = player.clock();
  if (!clock || !player.playing()) return;
  state.pause = { seconds: clock.sceneSeconds(), skippedSeconds: clock.skippedSeconds };
  player.stop();
  showStopped();
}

$('play').addEventListener('click', () => {
  if (player.playing()) {
    state.pause = null;
    player.stop();
    showStopped();
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

/** Pressing a plot holds playback at that moment, dragging moves it, and letting go plays on from there. */
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

/* Files */

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
    const scene = parseScene(JSON.parse(await file.text()));
    state.scene = scene;
    state.selection = { type: 'emitter', id: scene.emitters[0].id };
    storage.write(sceneStorageKey(scene.mode), scene);
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

const EXPORT_LABELS = Object.freeze({ scene: 'Scene (JSON)', stereo: 'Stereo', microphones: 'Microphones', ambix: 'Ambisonics' });
const formatBytes = bytes => (bytes >= 1024 ** 2 ? `${(bytes / 1024 ** 2).toFixed(1)} MB` : `${Math.max(1, Math.ceil(bytes / 1024))} KB`);
let exportState = null;

function exportSelection() {
  return new Set([...document.querySelectorAll('#export-list input:checked')].map(input => input.value));
}

/** Sizes, the file count, and the format line for the current selection. */
function updateExportSummary() {
  const { plan } = exportState;
  const selected = exportSelection();
  const sizes = exportSizes(plan, selected);
  for (const item of availableItems(plan)) $(`export-size-${item}`).textContent = formatBytes(sizes[item]);
  const count = [...selected].reduce((sum, item) => sum + (item === 'microphones' || item === 'ambix' ? plan.microphones.length : 1), 0);
  const bytes = [...selected].reduce((sum, item) => sum + sizes[item], 0);
  $('export-summary').textContent = selected.size ? `${count} file${count === 1 ? '' : 's'} · ≈ ${formatBytes(bytes)}${count > 1 ? ' · ZIP' : ''}` : '';
  const aligned = selected.has('microphones') || selected.has('ambix');
  const timeline = aligned ? plan.everyone : plan.listening;
  $('export-contract').textContent = `${timeline.sampleRate / 1000} kHz · 32-bit float · full scale ${Number((1 / plan.gain).toPrecision(3)).toLocaleString('en')} Pa · from ${formatSeconds(timeline.startSeconds)} after the flash`;
  $('export-submit').disabled = selected.size === 0;
}

$('export').addEventListener('click', async () => {
  let current;
  try {
    current = await listening();
  } catch (error) {
    setStatus(`Ear model failed: ${error.message}`, true);
    return;
  }
  if (!current) return;
  const plan = exportPlan(state.scene, state.results, current.gain);
  if (!plan) return;
  exportState = { plan, composition: current.composition };
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
  $('export-name').value = state.preferences.exportName ?? `boomtect-${state.scene.mode}`;
  $('export-error').hidden = true;
  updateExportSummary();
  $('export-dialog').showModal();
  // The dialog itself takes focus, so its first control is not ringed when it opens.
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
  state.preferences.exportItems = [...selected];
  state.preferences.exportName = name;
  savePreferences();
  const submit = $('export-submit');
  submit.disabled = true;
  $('export-error').hidden = true;
  operation('export', 'Exporting');
  try {
    const { plan, composition } = exportState;
    const stem = fileStem(name);
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
        peakPa: composition.peakPa,
        speedOfSoundMetresPerSecond: soundSpeedProfile(state.scene.air).groundSpeed,
        soundSpeedGradientPerSecond: soundSpeedProfile(state.scene.air).gradient,
        modelVersion: MODEL_VERSION,
        exportedAt: new Date().toISOString()
      }
    }));
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

/* Controls */

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

/**
 * The icon switches: each button is pressed while its preference is on, and a press turns it over.
 * `after` runs once the preference has changed.
 */
const TOGGLES = Object.freeze({
  'auto-render': {
    read: () => state.preferences.autoRender,
    write: on => { state.preferences.autoRender = on; },
    after: () => { if (state.preferences.autoRender && !state.results && !operations.has('render')) startRender(); }
  },
  'real-delay': { read: () => state.preferences.realDelay, write: on => { state.preferences.realDelay = on; } },
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
const nextName = (scene, base) => `${base} ${scene.emitters.length + 1}`;
$('add-lightning').addEventListener('click', () => addEmitter(scene => defaultLightning(uniqueId('lightning', scene.emitters), nextName(scene, 'Ground flash'), newSeed())));
$('add-cloud').addEventListener('click', () => addEmitter(scene => defaultCloudFlash(uniqueId('cloud', scene.emitters), nextName(scene, 'Cloud flash'), newSeed())));
$('add-storm').addEventListener('click', () => addEmitter(scene => defaultStorm(uniqueId('storm', scene.emitters), nextName(scene, 'Storm'), newSeed())));
$('add-meteor').addEventListener('click', () => addEmitter(scene => defaultMeteor(uniqueId('meteor', scene.emitters), nextName(scene, 'Meteor'), newSeed())));
$('add-shower').addEventListener('click', () => addEmitter(scene => defaultShower(uniqueId('shower', scene.emitters), nextName(scene, 'Shower'), newSeed())));
$('add-formation').addEventListener('click', () => addEmitter(scene => defaultFormation(uniqueId('formation', scene.emitters), nextName(scene, 'Formation'), newSeed())));
$('add-flight').addEventListener('click', () => addEmitter(scene => defaultFlight(uniqueId('flight', scene.emitters), nextName(scene, 'Flight'), newSeed())));
$('add-barrage').addEventListener('click', () => addEmitter(scene => defaultBarrage(uniqueId('barrage', scene.emitters), nextName(scene, 'Barrage'), newSeed())));
$('add-blast').addEventListener('click', () => addEmitter(scene => defaultBlast(uniqueId('blast', scene.emitters), nextName(scene, 'Blast'), newSeed())));
$('add-receiver').addEventListener('click', () => commit(scene => {
  const receiver = defaultReceiver(uniqueId('receiver', scene.receivers), `Mic ${scene.receivers.length + 1}`);
  receiver.positionMetres = { ...receiver.positionMetres, x: receiver.positionMetres.x + 1000 * scene.receivers.length };
  scene.receivers.push(receiver);
  select({ type: 'receiver', id: receiver.id });
}));

window.addEventListener('resize', () => drawResults());

refreshPanel();
if (state.preferences.autoRender) startRender(); else syncPlayButton();
