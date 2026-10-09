import { speedOfSoundMetresPerSecond } from './domain/air.js';
import { MAXIMUM_EMITTERS, MAXIMUM_RECEIVERS, MODEL_VERSION } from './domain/constants.js';
import { GROUND_LABELS, GROUND_TYPES } from './domain/ground.js';
import { newSeed } from './domain/random.js';
import { arrivalTable, combineSegments, MISSING_PHENOMENA, partitionSeconds, prepareScene } from './domain/render.js';
import {
  defaultBlast, defaultCloudFlash, defaultLightning, defaultReceiver, defaultScene, defaultStorm, parseScene, serializeScene
} from './domain/scene.js';
import { encodeFloat32Wav } from './domain/wav.js';
import { formatSeconds } from './ui/canvas.js';
import { checkboxField, numberField, pointFields, seedField, selectField, textField } from './ui/fields.js';
import { createPlayer } from './ui/player.js';
import { drawArrivals, drawWaveform } from './ui/plots.js';
import { cachedFlashes, createSceneView } from './ui/scene-view.js';

const SCENE_STORAGE_KEY = 'boomtect.scene';
const PREFERENCES_STORAGE_KEY = 'boomtect.preferences';
const RENDER_DEBOUNCE_MILLISECONDS = 200;
/** Peak normalization leaves 3 dB of headroom for resampling and inter-sample peaks. */
const PEAK_TARGET = 10 ** (-3 / 20);
const FLASH_DECAY_SECONDS = .15;
const ENVELOPE_SECONDS = .01;
const WORKER_COUNT = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));

const KIND_LABELS = Object.freeze({ blast: 'Blast', storm: 'Storm' });
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

function restoredScene() {
  try { return parseScene(storage.read(SCENE_STORAGE_KEY)); } catch { return defaultScene(); }
}

const state = {
  scene: restoredScene(),
  selection: null,
  results: null,
  envelopes: new Map(),
  revision: 0,
  workers: [],
  renderTimer: null,
  lastEmitterId: null,
  lastReceiverId: null,
  preferences: { realDelay: true, listenReceiverId: null, ...(storage.read(PREFERENCES_STORAGE_KEY) ?? {}) }
};
state.selection = { type: 'emitter', id: state.scene.emitters[0].id };

const player = createPlayer();
const liveFields = { emitter: null, receiver: null };

const views = ['elevation', 'plan'].map(id => createSceneView($(id), {
  vertical: id === 'elevation' ? 'z' : 'y',
  onSelect: selection => { state.selection = selection; refreshPanel(); },
  onMove: (handle, point) => {
    findItem(handle.type, handle.id)[handle.field] = point;
    liveFields[handle.type]?.[handle.field]?.set(point);
    invalidateResults();
    redrawViews();
  },
  onCommit: () => commit(() => {})
}));

function findItem(type, id) {
  return (type === 'emitter' ? state.scene.emitters : state.scene.receivers).find(item => item.id === id);
}

function setStatus(text, error = false) {
  $('status').textContent = text;
  $('status').classList.toggle('error', error);
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
  storage.write(SCENE_STORAGE_KEY, state.scene);
  if (!findItem(state.selection?.type, state.selection?.id)) state.selection = { type: 'emitter', id: state.scene.emitters[0].id };
  invalidateResults();
  refreshPanel();
  scheduleRender();
}

function invalidateResults() {
  player.stop();
  state.results = null;
  $('play').disabled = true;
  $('export').disabled = true;
  $('play').textContent = 'Play';
  $('play').setAttribute('aria-pressed', 'false');
}

function scheduleRender() {
  clearTimeout(state.renderTimer);
  state.renderTimer = setTimeout(startRender, RENDER_DEBOUNCE_MILLISECONDS);
}

function stopWorkers() {
  state.workers.forEach(worker => worker.terminate());
  state.workers = [];
}

/**
 * Renders on a pool of workers. Arrivals are split into equal time ranges; every worker renders
 * its range for all receivers, and the segments are summed in range order.
 */
function startRender() {
  state.revision += 1;
  const revision = state.revision;
  stopWorkers();
  const scene = state.scene;
  if (!scene.emitters.some(emitter => emitter.enabled)) {
    setStatus('No emitter is enabled.');
    drawResults();
    return;
  }
  let prepared;
  let boundaries;
  try {
    prepared = prepareScene(scene);
    boundaries = partitionSeconds(prepared, scene, WORKER_COUNT);
  } catch (error) {
    setStatus(error.message, true);
    drawResults();
    return;
  }
  const sources = prepared.reduce((sum, item) => sum + item.sources.length, 0);
  const started = performance.now();
  const progress = new Array(WORKER_COUNT).fill(0);
  const parts = new Array(WORKER_COUNT);
  let remaining = WORKER_COUNT;
  setStatus('Rendering…');
  for (let index = 0; index < WORKER_COUNT; index += 1) {
    const worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    state.workers.push(worker);
    worker.addEventListener('message', ({ data }) => {
      if (data.revision !== state.revision) return;
      if (data.type === 'progress') {
        progress[index] = data.fraction;
        setStatus(`Rendering ${Math.round(progress.reduce((a, b) => a + b, 0) / WORKER_COUNT * 100)} %`);
        return;
      }
      if (data.type === 'error') {
        stopWorkers();
        setStatus(data.message, true);
        drawResults();
        return;
      }
      parts[index] = data.segments;
      worker.terminate();
      remaining -= 1;
      if (remaining === 0) finishRender(scene, prepared, parts, { sources, milliseconds: performance.now() - started });
    });
    worker.addEventListener('error', event => {
      if (revision !== state.revision) return;
      stopWorkers();
      setStatus(event.message || 'The renderer failed to start.', true);
    });
    worker.postMessage({ revision, scene, fromSeconds: boundaries[index], toSeconds: boundaries[index + 1] });
  }
}

function finishRender(scene, prepared, parts, info) {
  state.workers = [];
  const speedOfSound = speedOfSoundMetresPerSecond(scene.air.temperatureCelsius);
  try {
    state.results = new Map(scene.receivers.map(receiver => {
      const segments = parts.map(list => list.find(segment => segment.receiverId === receiver.id));
      const combined = combineSegments(segments, scene.render.sampleRate);
      return [receiver.id, {
        receiverId: receiver.id,
        sampleRate: scene.render.sampleRate,
        ...combined,
        speedOfSound,
        arrivals: arrivalTable(prepared, receiver, scene),
        nonlinearPaths: segments.reduce((sum, segment) => sum + segment.nonlinearPaths, 0),
        modelVersion: MODEL_VERSION
      }];
    }));
  } catch (error) {
    setStatus(error.message, true);
    drawResults();
    return;
  }
  state.envelopes = new Map([...state.results.values()].map(result => [result.receiverId, envelope(result)]));
  setStatus(`Rendered ${info.sources.toLocaleString('en')} point sources in ${(info.milliseconds / 1000).toFixed(1)} s on ${WORKER_COUNT} threads`);
  $('play').disabled = false;
  $('export').disabled = false;
  drawResults();
}

/** RMS envelope in ENVELOPE_SECONDS windows, normalized to its own maximum. */
function envelope(result) {
  const window = Math.max(1, Math.round(result.sampleRate * ENVELOPE_SECONDS));
  const values = new Float32Array(Math.ceil(result.samples.length / window));
  let maximum = 0;
  for (let block = 0; block < values.length; block += 1) {
    let sum = 0;
    const end = Math.min(result.samples.length, (block + 1) * window);
    for (let index = block * window; index < end; index += 1) sum += result.samples[index] ** 2;
    values[block] = Math.sqrt(sum / Math.max(1, end - block * window));
    maximum = Math.max(maximum, values[block]);
  }
  if (maximum > 0) for (let block = 0; block < values.length; block += 1) values[block] /= maximum;
  return { window: ENVELOPE_SECONDS, values };
}

function listenReceiver() {
  const { receivers } = state.scene;
  return receivers.find(receiver => receiver.id === state.preferences.listenReceiverId) ?? receivers[0];
}

function outputGain(result) {
  const { levelMode, fullScalePa } = state.scene.render;
  if (levelMode === 'fixed') return 1 / fullScalePa;
  return result.peakPa > 0 ? PEAK_TARGET / result.peakPa : 1;
}

function savePreferences() {
  storage.write(PREFERENCES_STORAGE_KEY, state.preferences);
}

/* Panel */

function emitterKindLabel(emitter) {
  return emitter.kind === 'lightning' ? FLASH_TYPE_LABELS[emitter.flashType] : KIND_LABELS[emitter.kind];
}

function listItem(container, { selected, kind, name, enabled, onSelect, onToggle }) {
  const item = document.createElement('div');
  item.className = 'item';
  item.setAttribute('role', 'option');
  item.setAttribute('aria-selected', String(selected));
  item.tabIndex = 0;
  if (onToggle) {
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = enabled;
    checkbox.title = 'Enabled';
    checkbox.addEventListener('click', event => event.stopPropagation());
    checkbox.addEventListener('change', () => onToggle(checkbox.checked));
    item.append(checkbox);
  }
  const nameElement = document.createElement('span');
  nameElement.className = 'name';
  nameElement.textContent = name;
  const kindElement = document.createElement('span');
  kindElement.className = 'kind';
  kindElement.textContent = kind;
  item.append(nameElement, kindElement);
  item.addEventListener('click', onSelect);
  item.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(); } });
  container.append(item);
}

function heading(container, text) {
  const element = document.createElement('div');
  element.className = 'unit-row';
  element.textContent = text;
  container.append(element);
}

const updateEmitter = (id, change) => commit(scene => change(scene.emitters.find(emitter => emitter.id === id)));
const updateReceiver = (id, change) => commit(scene => change(scene.receivers.find(receiver => receiver.id === id)));

function buildEmitterFields(container, emitter) {
  const set = key => value => updateEmitter(emitter.id, item => { item[key] = value; });
  const numbers = keys => keys.forEach(key => numberField(container, { key, value: emitter[key], onCommit: set(key) }));
  const fields = {};
  textField(container, { label: 'Name', value: emitter.name, onCommit: set('name') });
  if (emitter.kind !== 'blast') seedField(container, { value: emitter.seed, onCommit: set('seed'), onNew: () => set('seed')(newSeed()) });
  numbers(['startSeconds']);
  if (emitter.kind === 'lightning') {
    selectField(container, { label: 'Type', value: emitter.flashType, options: Object.entries(FLASH_TYPE_LABELS), onCommit: set('flashType') });
    fields.baseMetres = pointFields(container, { label: 'Channel start (m)', point: emitter.baseMetres, onCommit: set('baseMetres') });
    fields.topMetres = pointFields(container, { label: 'Channel end (m)', point: emitter.topMetres, onCommit: set('topMetres') });
    heading(container, 'Channel');
    numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'branchCount', 'branchLengthRatio', 'branchEnergyRatio']);
    heading(container, 'Source');
    numbers(['energyJoulesPerMetre', 'energyVariation', 'acousticEfficiency', 'frequencyCoefficient', 'riseTimeSeconds']);
    heading(container, 'Strokes');
    numbers(['channelSpeedMetresPerSecond', 'strokeCount', 'strokeIntervalSeconds', 'subsequentStrokeEnergyRatio']);
  } else if (emitter.kind === 'storm') {
    fields.centreMetres = pointFields(container, { label: 'Centre (m)', point: emitter.centreMetres, axes: ['x', 'y'], onCommit: set('centreMetres') });
    heading(container, 'Extent');
    numbers(['radiusMetres', 'durationSeconds', 'flashCount', 'groundFlashShare', 'cloudBaseMetres', 'cloudTopMetres']);
    heading(container, 'Source');
    numbers(['energyJoulesPerMetre', 'energySpread', 'energyVariation', 'acousticEfficiency', 'frequencyCoefficient', 'riseTimeSeconds']);
    heading(container, 'Channel');
    numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'branchCount', 'branchEnergyRatio']);
  } else {
    fields.positionMetres = pointFields(container, { label: 'Position (m)', point: emitter.positionMetres, onCommit: set('positionMetres') });
    heading(container, 'Source');
    numbers(['chargeKilograms', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds']);
  }
  return fields;
}

function refreshPanel() {
  const { scene, selection } = state;
  const emitterList = $('emitter-list');
  emitterList.replaceChildren();
  for (const emitter of scene.emitters) {
    listItem(emitterList, {
      selected: selection.type === 'emitter' && selection.id === emitter.id,
      kind: emitterKindLabel(emitter),
      name: emitter.name,
      enabled: emitter.enabled,
      onSelect: () => { state.selection = { type: 'emitter', id: emitter.id }; refreshPanel(); },
      onToggle: enabled => updateEmitter(emitter.id, item => { item.enabled = enabled; })
    });
  }
  const selectedEmitter = scene.emitters.find(emitter => emitter.id === (selection.type === 'emitter' ? selection.id : state.lastEmitterId))
    ?? scene.emitters[0];
  state.lastEmitterId = selectedEmitter.id;
  const emitterFields = $('emitter-fields');
  emitterFields.replaceChildren();
  liveFields.emitter = buildEmitterFields(emitterFields, selectedEmitter);

  const receiverList = $('receiver-list');
  receiverList.replaceChildren();
  for (const receiver of scene.receivers) {
    listItem(receiverList, {
      selected: selection.type === 'receiver' && selection.id === receiver.id,
      kind: `${receiver.positionMetres.z} m`,
      name: receiver.name,
      onSelect: () => { state.selection = { type: 'receiver', id: receiver.id }; refreshPanel(); }
    });
  }
  const selectedReceiver = scene.receivers.find(receiver => receiver.id === (selection.type === 'receiver' ? selection.id : state.lastReceiverId))
    ?? scene.receivers[0];
  state.lastReceiverId = selectedReceiver.id;
  const receiverFields = $('receiver-fields');
  receiverFields.replaceChildren();
  textField(receiverFields, { label: 'Name', value: selectedReceiver.name, onCommit: value => updateReceiver(selectedReceiver.id, item => { item.name = value; }) });
  liveFields.receiver = {
    positionMetres: pointFields(receiverFields, {
      label: 'Position (m)', point: selectedReceiver.positionMetres,
      onCommit: value => updateReceiver(selectedReceiver.id, item => { item.positionMetres = value; })
    })
  };

  const environment = $('environment-fields');
  environment.replaceChildren();
  ['temperatureCelsius', 'relativeHumidityPercent', 'pressureKpa'].forEach(key =>
    numberField(environment, { key, value: scene.air[key], onCommit: value => commit(next => { next.air[key] = value; }) }));
  checkboxField(environment, { label: 'Air absorption', value: scene.air.absorption, reliability: 'B', onCommit: value => commit(next => { next.air.absorption = value; }) });
  checkboxField(environment, { label: 'Ground reflection', value: scene.ground.enabled, reliability: 'B', onCommit: value => commit(next => { next.ground.enabled = value; }) });
  selectField(environment, {
    label: 'Ground', value: scene.ground.type, reliability: 'B',
    options: GROUND_TYPES.map(type => [type, GROUND_LABELS[type]]),
    onCommit: value => commit(next => { next.ground.type = value; })
  });

  const output = $('output-fields');
  output.replaceChildren();
  selectField(output, {
    label: 'Level', value: scene.render.levelMode,
    options: [['peak', 'Peak −3 dBFS'], ['fixed', 'Fixed full scale']],
    onCommit: value => commit(next => { next.render.levelMode = value; })
  });
  if (scene.render.levelMode === 'fixed') {
    numberField(output, { key: 'fullScalePa', value: scene.render.fullScalePa, onCommit: value => commit(next => { next.render.fullScalePa = value; }) });
  }

  const receiverSelect = $('receiver-select');
  receiverSelect.replaceChildren(...scene.receivers.map(receiver => new Option(receiver.name, receiver.id, false, receiver.id === listenReceiver().id)));

  const full = scene.emitters.length >= MAXIMUM_EMITTERS;
  ['add-lightning', 'add-cloud', 'add-storm', 'add-blast', 'duplicate-emitter'].forEach(id => { $(id).disabled = full; });
  $('remove-emitter').disabled = scene.emitters.length <= 1;
  $('add-receiver').disabled = scene.receivers.length >= MAXIMUM_RECEIVERS;
  $('remove-receiver').disabled = scene.receivers.length <= 1;
  redrawViews();
  drawResults();
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

function drawResults(playheadSeconds = null) {
  const receiver = listenReceiver();
  const result = state.results?.get(receiver.id) ?? null;
  drawWaveform($('waveform'), result, playheadSeconds);
  drawArrivals($('arrivals'), result, playheadSeconds);
  if (playheadSeconds !== null) return;
  $('waveform-caption').textContent = result ? `Pressure · ${receiver.name}` : 'Pressure';
  const summary = $('summary');
  const warnings = $('warnings');
  warnings.replaceChildren();
  const warn = text => warnings.append(Object.assign(document.createElement('li'), { textContent: text }));
  if (!result?.arrivals.count) {
    summary.textContent = state.workers.length ? 'Rendering…' : '';
  } else {
    let first = Infinity;
    let last = -Infinity;
    for (let index = 0; index < result.arrivals.count; index += 1) {
      first = Math.min(first, result.arrivals.seconds[index]);
      last = Math.max(last, result.arrivals.seconds[index]);
    }
    const fullScale = 1 / outputGain(result);
    summary.textContent = `${receiver.name}: sound from ${formatSeconds(first)} to ${formatSeconds(last)} after the first flash. `
      + `Model peak ${result.peakPa.toPrecision(3)} Pa (uncalibrated), c = ${result.speedOfSound.toFixed(1)} m/s. `
      + `Full scale ${fullScale.toPrecision(3)} Pa.`;
    if (result.nonlinearPaths) warn(`${result.nonlinearPaths} paths start inside the nonlinear zone; their level is not reliable.`);
    if (state.scene.render.levelMode === 'fixed' && result.peakPa > state.scene.render.fullScalePa) warn('The peak exceeds the fixed full scale and will clip on playback.');
  }
  if (state.scene.emitters.filter(emitter => emitter.enabled).length > 1) warn('Several emitters are enabled; they sound together.');
  const missing = [...MISSING_PHENOMENA];
  if (!state.scene.air.absorption) missing.unshift('Air absorption');
  if (!state.scene.ground.enabled) missing.unshift('Ground reflection');
  $('missing').replaceChildren(...missing.map(text => Object.assign(document.createElement('li'), { textContent: text })));
}

/* Playback */

/** Scene times at which each flash of an emitter lights up, one list per flash. */
function flashTimes(emitter) {
  if (emitter.kind === 'blast') return [[emitter.startSeconds]];
  return cachedFlashes(emitter).map(flash => flash.strokes.map(stroke => flash.startSeconds + stroke.offsetSeconds));
}

function animationState() {
  const clock = player.clock();
  if (!clock) return null;
  const now = clock.sceneSeconds();
  const shown = time => Math.max(time, clock.skippedSeconds);
  const flashes = new Map();
  const fronts = new Map();
  const result = state.results?.get(listenReceiver().id);
  for (const emitter of state.scene.emitters) {
    if (!emitter.enabled) continue;
    flashes.set(emitter.id, flashTimes(emitter).map(times => Math.min(1, times.reduce(
      (sum, time) => sum + (now >= shown(time) ? Math.exp(-(now - shown(time)) / FLASH_DECAY_SECONDS) : 0), 0))));
    if (emitter.kind === 'blast' && result && now >= emitter.startSeconds && !clock.skippedSeconds) {
      fronts.set(emitter.id, (now - emitter.startSeconds) * result.speedOfSound);
    }
  }
  const receivers = new Map();
  const envelopeData = state.envelopes.get(listenReceiver().id);
  if (envelopeData && result) {
    const index = Math.floor((now - result.startSeconds) / envelopeData.window);
    receivers.set(listenReceiver().id, envelopeData.values[index] ?? 0);
  }
  return { flashes, fronts, receivers };
}

views.forEach(view => view.setAnimation(animationState));

function animate() {
  const clock = player.clock();
  redrawViews();
  drawResults(clock ? clock.sceneSeconds() : null);
  if (player.playing()) requestAnimationFrame(animate);
  else { redrawViews(); drawResults(); }
}

function showStopped() {
  $('play').textContent = 'Play';
  $('play').setAttribute('aria-pressed', 'false');
}

$('play').addEventListener('click', async () => {
  if (player.playing()) {
    player.stop();
    showStopped();
    return;
  }
  const result = state.results?.get(listenReceiver().id);
  if (!result?.samples.length) return;
  await player.play(result, outputGain(result), { realDelay: state.preferences.realDelay, onEnded: showStopped });
  $('play').textContent = 'Stop';
  $('play').setAttribute('aria-pressed', 'true');
  requestAnimationFrame(animate);
});

/* Files */

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'receiver';

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
    storage.write(SCENE_STORAGE_KEY, scene);
    invalidateResults();
    refreshPanel();
    scheduleRender();
    setStatus(`Opened ${file.name}`);
  } catch (error) {
    setStatus(`Could not open ${file.name}: ${error.message}`, true);
  }
});

$('export').addEventListener('click', () => {
  const receiver = listenReceiver();
  const result = state.results?.get(receiver.id);
  if (!result) return;
  const gain = outputGain(result);
  const samples = result.samples.map(value => value * gain);
  const base = `boomtect-${slug(receiver.name)}`;
  download(`${base}.wav`, new Blob([encodeFloat32Wav([samples], result.sampleRate)], { type: 'audio/wav' }));
  const exportDocument = {
    ...parseScene(state.scene),
    export: {
      receiverId: receiver.id,
      file: `${base}.wav`,
      sampleRate: result.sampleRate,
      channels: 1,
      sampleFormat: 'ieee-float32',
      startSeconds: result.startSeconds,
      fullScalePa: 1 / gain,
      peakPa: result.peakPa,
      speedOfSoundMetresPerSecond: result.speedOfSound,
      modelVersion: result.modelVersion,
      exportedAt: new Date().toISOString()
    }
  };
  download(`${base}.json`, new Blob([JSON.stringify(exportDocument, null, 2)], { type: 'application/json' }));
});

/* Controls */

$('real-delay').checked = state.preferences.realDelay;
$('real-delay').addEventListener('change', () => { state.preferences.realDelay = $('real-delay').checked; savePreferences(); });
$('receiver-select').addEventListener('change', () => {
  player.stop();
  showStopped();
  state.preferences.listenReceiverId = $('receiver-select').value;
  savePreferences();
  drawResults();
});

const nextName = (scene, base) => `${base} ${scene.emitters.length + 1}`;
$('add-lightning').addEventListener('click', () => addEmitter(scene => defaultLightning(uniqueId('lightning', scene.emitters), nextName(scene, 'Ground flash'), newSeed())));
$('add-cloud').addEventListener('click', () => addEmitter(scene => defaultCloudFlash(uniqueId('cloud', scene.emitters), nextName(scene, 'Cloud flash'), newSeed())));
$('add-storm').addEventListener('click', () => addEmitter(scene => defaultStorm(uniqueId('storm', scene.emitters), nextName(scene, 'Storm'), newSeed())));
$('add-blast').addEventListener('click', () => addEmitter(scene => defaultBlast(uniqueId('blast', scene.emitters), nextName(scene, 'Blast'), newSeed())));
$('duplicate-emitter').addEventListener('click', () => addEmitter(scene => {
  const source = scene.emitters.find(emitter => emitter.id === state.lastEmitterId) ?? scene.emitters[0];
  source.enabled = false;
  return { ...structuredClone(source), id: uniqueId(source.kind, scene.emitters), name: `${source.name} variant`.slice(0, 64), seed: newSeed(), enabled: true };
}));
$('remove-emitter').addEventListener('click', () => commit(scene => {
  scene.emitters = scene.emitters.filter(emitter => emitter.id !== state.lastEmitterId);
}));
$('add-receiver').addEventListener('click', () => commit(scene => {
  const receiver = defaultReceiver(uniqueId('receiver', scene.receivers), `Mic ${scene.receivers.length + 1}`);
  receiver.positionMetres = { ...receiver.positionMetres, x: receiver.positionMetres.x + 1000 * scene.receivers.length };
  scene.receivers.push(receiver);
  state.selection = { type: 'receiver', id: receiver.id };
}));
$('remove-receiver').addEventListener('click', () => commit(scene => {
  scene.receivers = scene.receivers.filter(receiver => receiver.id !== state.lastReceiverId);
}));

window.addEventListener('resize', () => drawResults());

refreshPanel();
startRender();
