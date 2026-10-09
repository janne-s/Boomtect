import { speedOfSoundMetresPerSecond } from './domain/air.js';
import { MAXIMUM_EMITTERS, MAXIMUM_RECEIVERS, MODEL_VERSION } from './domain/constants.js';
import { GROUND_LABELS, GROUND_TYPES } from './domain/ground.js';
import { newSeed } from './domain/random.js';
import { arrivalTable, combineSegments, MISSING_PHENOMENA, partitionSeconds, prepareScene } from './domain/render.js';
import {
  defaultBlast, defaultCloudFlash, defaultLightning, defaultReceiver, defaultScene, defaultStorm, MODES, parseScene, serializeScene
} from './domain/scene.js';
import { encodeFloat32Wav } from './domain/wav.js';
import { formatMetres, formatSeconds } from './ui/canvas.js';
import { checkboxField, numberField, pointFields, seedField, selectField, textField } from './ui/fields.js';
import { createCubeView, DEFAULT_CUBE_VIEW, FLASH_TRAVERSE_SECONDS } from './ui/cube-view.js';
import { cachedFlashes } from './ui/geometry-cache.js';
import { macrosFor } from './ui/macros.js';
import { createPlayer } from './ui/player.js';
import { drawArrivals, drawWaveform } from './ui/plots.js';
import { attachSplitters } from './ui/splitters.js';

const sceneStorageKey = mode => `boomtect.scene.${mode}`;
const PREFERENCES_STORAGE_KEY = 'boomtect.preferences';
const RENDER_DEBOUNCE_MILLISECONDS = 200;
/** Peak normalization leaves 3 dB of headroom for resampling and inter-sample peaks. */
const PEAK_TARGET = 10 ** (-3 / 20);
/** How long a stroke stays on screen after it has run its route. */
const FLASH_VISIBLE_SECONDS = 1.2;
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

function restoredScene(mode) {
  try {
    const scene = parseScene(storage.read(sceneStorageKey(mode)));
    if (scene.mode === mode) return scene;
  } catch { /* A missing or outdated scene falls back to the default. */ }
  return defaultScene(mode);
}

const preferences = {
  realDelay: true, listenReceiverId: null, mode: 'thunder', cubeView: { ...DEFAULT_CUBE_VIEW },
  panelWidth: 340, resultsHeight: 220,
  ...(storage.read(PREFERENCES_STORAGE_KEY) ?? {})
};
if (!MODES.includes(preferences.mode)) preferences.mode = 'thunder';

const state = {
  scene: restoredScene(preferences.mode),
  selection: null,
  results: null,
  envelopes: new Map(),
  revision: 0,
  workers: [],
  renderTimer: null,
  detailsId: null,
  preferences
};
state.selection = { type: 'emitter', id: state.scene.emitters[0].id };

const player = createPlayer();
const liveFields = { receiver: null };

const views = [createCubeView($('cube'), {
  onView: next => { state.preferences.cubeView = next; savePreferences(); },
  onSelect: selection => { state.selection = selection; refreshPanel(); },
  onMove: (handle, point) => {
    findItem(handle.type, handle.id)[handle.field] = point;
    liveFields[handle.type]?.[handle.field]?.set(point);
    invalidateResults();
    redrawViews();
    drawInfo();
  },
  onCommit: () => commit(() => {})
})];
views[0].setView(state.preferences.cubeView);
attachSplitters($('cube').closest('.layout'), { column: $('split-column'), row: $('split-row') }, state.preferences, sizes => {
  Object.assign(state.preferences, sizes);
  savePreferences();
});

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
  storage.write(sceneStorageKey(state.scene.mode), state.scene);
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
  drawInfo();
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

const MACRO_STEPS = 1000;

function macroRow(container, emitter, macro) {
  const id = `macro-${emitter.id}-${macro.label}`;
  const label = element('label', '', macro.label);
  label.htmlFor = id;
  const steps = macro.steps ?? MACRO_STEPS;
  const slider = element('input');
  slider.type = 'range';
  slider.id = id;
  slider.min = '0';
  slider.max = String(steps);
  slider.step = '1';
  slider.value = String(Math.round(macro.read(emitter) * steps));
  const value = element('span', 'macro-value', macro.show(emitter));
  slider.addEventListener('input', () => preview(scene => {
    const item = scene.emitters.find(candidate => candidate.id === emitter.id);
    macro.write(item, Number(slider.value) / steps);
    value.textContent = macro.show(item);
  }));
  slider.addEventListener('change', () => commit(() => {}));
  container.append(label, slider, value);
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
  const select = () => { state.selection = { type: 'emitter', id: emitter.id }; refreshPanel(); };
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
    if (emitter.kind !== 'blast') {
      actions.append(button('New shape', () => updateEmitter(emitter.id, item => { item.seed = newSeed(); }), { title: 'Same parameters, new seed' }));
      actions.append(button('Variant', () => addEmitter(next => {
        const source = next.emitters.find(item => item.id === emitter.id);
        source.enabled = false;
        return { ...structuredClone(source), id: uniqueId(source.kind, next.emitters), name: `${source.name} variant`.slice(0, 64), seed: newSeed(), enabled: true };
      }), { disabled: scene.emitters.length >= MAXIMUM_EMITTERS, title: 'Copy with a new seed; the original is switched off' }));
    }
    actions.append(button('Remove', () => commit(next => { next.emitters = next.emitters.filter(item => item.id !== emitter.id); }), { disabled: scene.emitters.length <= 1 }));
    card.append(actions);
  }
  container.append(card);
}

function receiverCard(container, receiver, selected) {
  const card = element('div', 'card');
  card.setAttribute('aria-selected', String(selected));
  const header = element('div', 'card-header');
  header.tabIndex = 0;
  header.setAttribute('role', 'button');
  header.setAttribute('aria-expanded', String(selected));
  header.append(element('span', 'name', receiver.name), element('span', 'kind', `${formatMetres(receiver.positionMetres.z)} high`));
  const select = () => { state.selection = { type: 'receiver', id: receiver.id }; refreshPanel(); };
  header.addEventListener('click', select);
  header.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(); } });
  card.append(header);
  if (selected) {
    const fields = element('div', 'fields');
    textField(fields, { label: 'Name', value: receiver.name, onCommit: value => updateReceiver(receiver.id, item => { item.name = value; }) });
    liveFields.receiver = {
      positionMetres: pointFields(fields, {
        label: 'Position (m)', point: receiver.positionMetres,
        onCommit: value => updateReceiver(receiver.id, item => { item.positionMetres = value; })
      })
    };
    card.append(fields);
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
    if (emitter.kind !== 'blast') seedField(container, { value: emitter.seed, onCommit: set('seed'), onNew: () => set('seed')(newSeed()) });
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
        pointFields(container, { label: ground ? 'Ground point ■' : 'Start ■', point: emitter.baseMetres, axes: ground ? ['x', 'y'] : ['x', 'y', 'z'], onCommit: set('baseMetres') });
        pointFields(container, { label: ground ? 'Cloud end ●' : 'End ●', point: emitter.topMetres, onCommit: set('topMetres') });
      }),
      section('Channel', numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees',
        'branchCount', 'branchDepth', 'branchLengthRatio', 'branchEnergyRatio'])),
      section('Source', numbers(['energyJoulesPerMetre', 'energyVariation', 'acousticEfficiency', 'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds'])),
      section('Strokes', numbers(['channelSpeedMetresPerSecond', 'strokeCount', 'strokeIntervalSeconds', 'strokeIntervalSpread', 'subsequentStrokeEnergyRatio',
        ...(ground ? ['newTerminationProbability'] : [])]))
    ];
  }
  if (emitter.kind === 'storm') {
    return [
      section('Placement', container => {
        placement(container);
        pointFields(container, { label: 'Centre', point: emitter.centreMetres, axes: ['x', 'y'], onCommit: set('centreMetres') });
      }),
      section('Extent', numbers(['radiusMetres', 'durationSeconds', 'flashCount', 'groundFlashShare', 'cloudBaseMetres', 'cloudTopMetres', 'newTerminationProbability'])),
      section('Source', numbers(['energyJoulesPerMetre', 'energySpread', 'energyVariation', 'acousticEfficiency', 'periodCoefficient', 'weakShockLimitRadii', 'riseTimeSeconds'])),
      section('Channel', numbers(['segmentLengthMetres', 'straightLengthMetres', 'tortuosityDegrees', 'macroStepMetres', 'macroTortuosityDegrees', 'branchCount', 'branchDepth', 'branchEnergyRatio']))
    ];
  }
  return [
    section('Placement', container => {
      placement(container);
      pointFields(container, { label: 'Position', point: emitter.positionMetres, onCommit: set('positionMetres') });
    }),
    section('Source', numbers(['chargeKilograms', 'linearScaledDistance', 'durationSecondsPerCubeRootKilogram', 'decay', 'riseTimeSeconds']))
  ];
}

function openDetails(id) {
  state.detailsId = id;
  renderDetails();
  if (!$('details').open) $('details').showModal();
}

function renderDetails() {
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

function refreshPanel() {
  const { scene, selection } = state;
  const emitterList = $('emitter-list');
  emitterList.replaceChildren();
  scene.emitters.forEach(emitter => emitterCard(emitterList, emitter, selection.type === 'emitter' && selection.id === emitter.id));

  const receiverList = $('receiver-list');
  receiverList.replaceChildren();
  liveFields.receiver = null;
  scene.receivers.forEach(receiver => receiverCard(receiverList, receiver, selection.type === 'receiver' && selection.id === receiver.id));

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
  document.querySelectorAll('.add-row [data-mode]').forEach(item => { item.hidden = item.dataset.mode !== scene.mode; item.disabled = full; });
  document.querySelectorAll('.modes [data-mode]').forEach(item => item.setAttribute('aria-checked', String(item.dataset.mode === scene.mode)));
  $('add-receiver').disabled = scene.receivers.length >= MAXIMUM_RECEIVERS;
  if ($('details').open) renderDetails();
  redrawViews();
  drawResults();
  drawInfo();
}

/** Short facts around the scene box: the selected emitter and the listening position. */
function drawInfo() {
  const { scene, selection } = state;
  const emitter = scene.emitters.find(item => item.id === selection.id && selection.type === 'emitter');
  const selectedInfo = $('cube-selected');
  selectedInfo.replaceChildren();
  if (emitter) {
    const kind = emitterKindLabel(emitter);
    selectedInfo.append(element('strong', '', emitter.name));
    if (kind !== emitter.name || !emitter.enabled) selectedInfo.append(element('span', '', kind + (emitter.enabled ? '' : ' · off')));
    selectedInfo.append(element('span', '', emitterSummary(emitter)));
    if (emitter.startSeconds) selectedInfo.append(element('span', '', `Onset ${formatSeconds(emitter.startSeconds)}`));
  }
  const receiver = listenReceiver();
  const listenInfo = $('cube-listen');
  listenInfo.replaceChildren(element('strong', '', `Listening at ${receiver.name}`), element('span', '', `${formatMetres(receiver.positionMetres.z)} above ground`));
  let nearest = Infinity;
  const measure = point => { nearest = Math.min(nearest, Math.hypot(point.x - receiver.positionMetres.x, point.y - receiver.positionMetres.y, point.z - receiver.positionMetres.z)); };
  for (const item of scene.emitters) {
    if (!item.enabled) continue;
    if (item.kind === 'blast') measure(item.positionMetres);
    else for (const flash of cachedFlashes(item)) for (const channel of flash.channels) channel.points.forEach(measure);
  }
  if (Number.isFinite(nearest)) listenInfo.append(element('span', '', `Nearest source ${formatMetres(nearest)}`));
  const result = state.results?.get(receiver.id);
  if (result?.arrivals.count) {
    let first = Infinity;
    for (let index = 0; index < result.arrivals.count; index += 1) first = Math.min(first, result.arrivals.seconds[index]);
    listenInfo.append(element('span', '', `First sound ${formatSeconds(first)} after the flash`));
  }
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
    const span = last > first ? `from ${formatSeconds(first)} to ${formatSeconds(last)}` : `at ${formatSeconds(first)}`;
    summary.textContent = `${receiver.name}: sound ${span} after the first flash. `
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

/** Every stroke of an emitter as its flash, scene time, and route. */
function strokeTimeline(emitter) {
  if (emitter.kind === 'blast') return [{ flash: 0, time: emitter.startSeconds, route: [] }];
  return cachedFlashes(emitter).flatMap((flash, index) => flash.strokes.map(stroke => ({ flash: index, time: flash.startSeconds + stroke.offsetSeconds, route: stroke.route })));
}

/**
 * What the scene view shows at the playback clock: every stroke that has started and not yet
 * faded, the blast fronts, and the listening receiver's level. A stroke's light runs its route
 * figuratively in FLASH_TRAVERSE_SECONDS; physically a return stroke takes microseconds.
 */
function animationState() {
  const clock = player.clock();
  if (!clock) return null;
  const now = clock.sceneSeconds();
  const shown = time => Math.max(time, clock.skippedSeconds);
  const strokes = new Map();
  const fronts = new Map();
  const result = state.results?.get(listenReceiver().id);
  for (const emitter of state.scene.emitters) {
    if (!emitter.enabled) continue;
    const active = strokeTimeline(emitter)
      .map(stroke => ({ ...stroke, elapsed: now - shown(stroke.time) }))
      .filter(stroke => stroke.elapsed >= 0 && stroke.elapsed < FLASH_TRAVERSE_SECONDS + FLASH_VISIBLE_SECONDS);
    strokes.set(emitter.id, active);
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
  return { strokes, fronts, receivers };
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
    storage.write(sceneStorageKey(scene.mode), scene);
    state.preferences.mode = scene.mode;
    savePreferences();
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

$('details-close').addEventListener('click', () => $('details').close());
$('details').addEventListener('close', () => { state.detailsId = null; });

document.querySelectorAll('.modes [data-mode]').forEach(button => button.addEventListener('click', () => {
  const mode = button.dataset.mode;
  if (mode === state.scene.mode) return;
  state.scene = restoredScene(mode);
  state.selection = { type: 'emitter', id: state.scene.emitters[0].id };
  state.preferences.mode = mode;
  savePreferences();
  invalidateResults();
  refreshPanel();
  startRender();
}));

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
$('add-receiver').addEventListener('click', () => commit(scene => {
  const receiver = defaultReceiver(uniqueId('receiver', scene.receivers), `Mic ${scene.receivers.length + 1}`);
  receiver.positionMetres = { ...receiver.positionMetres, x: receiver.positionMetres.x + 1000 * scene.receivers.length };
  scene.receivers.push(receiver);
  state.selection = { type: 'receiver', id: receiver.id };
}));


window.addEventListener('resize', () => drawResults());

refreshPanel();
startRender();
