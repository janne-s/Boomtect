import { MAXIMUM_EMITTERS, MAXIMUM_RECEIVERS, MODEL_VERSION } from './domain/constants.js';
import { GROUND_LABELS, GROUND_TYPES } from './domain/ground.js';
import { newSeed } from './domain/random.js';
import { PATH_SHADOW, soundSpeedProfile, travelSeconds, wavefront } from './domain/refraction.js';
import { arrivalTable, combineSegments, MISSING_PHENOMENA, partitionSeconds, prepareScene } from './domain/render.js';
import {
  defaultBlast, defaultCloudFlash, defaultLightning, defaultReceiver, defaultScene, defaultStorm, MODES, PARAMETERS, parseScene, serializeScene
} from './domain/scene.js';
import { applyEar } from './domain/ear.js';
import { encodeFloat32Wav } from './domain/wav.js';
import { formatMetres, formatSeconds, microphoneColor } from './ui/canvas.js';
import { checkboxField, numberField, pointFields, seedField, selectField, textField } from './ui/fields.js';
import { createCubeView, DEFAULT_CUBE_VIEW, FLASH_TRAVERSE_SECONDS } from './ui/cube-view.js';
import { cachedFlashes } from './ui/geometry-cache.js';
import { macrosFor } from './ui/macros.js';
import { composeListening, LISTENING_LABELS, listeningKind } from './ui/listening.js';
import { createOrientationBall } from './ui/orientation-ball.js';
import { createPlayer, renderComposition } from './ui/player.js';
import { drawArrivals, drawWaveform } from './ui/plots.js';
import { attachSplitters } from './ui/splitters.js';

const sceneStorageKey = mode => `boomtect.scene.${mode}`;
const PREFERENCES_STORAGE_KEY = 'boomtect.preferences';
const RENDER_DEBOUNCE_MILLISECONDS = 200;
/** Peak normalization leaves 3 dB of headroom for resampling and inter-sample peaks. */
const PEAK_TARGET = 10 ** (-3 / 20);
/** Binaural decoding can raise the peak above the pressure's; it gets 3 dB more room. */
const BINAURAL_HEADROOM = 10 ** (-3 / 20);
const AMBISONIC_CONVENTION = 'AmbiX (ACN, SN3D); front = north, left = west, up = up';
/** Source points whose wavefronts are drawn on the box's faces, at most. */
const WAVEFRONT_SPHERES = 360;
/** How long a stroke stays on screen after it has run its route. */
const FLASH_VISIBLE_SECONDS = 1.2;
const ENVELOPE_SECONDS = .01;
/** Level range of the microphone rings in the scene, below the loudest microphone's peak. */
const ENVELOPE_RANGE_DB = 40;
const WORKER_COUNT = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 2) - 1));
/**
 * Every worker holds the whole scene, so very large scenes use fewer of them to bound memory: a
 * worker was measured at about 1.8 kB per point source (230 MB for 130 912 sources), and the
 * budget keeps all workers together near 800 MB.
 */
const SOURCE_COPIES_BUDGET = 450000;
/** A render whose workers have sent nothing for this long has failed, for example out of memory. */
const RENDER_STALL_SECONDS = 60;

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
  realDelay: true, wavefront: false, mode: 'thunder', cubeView: { ...DEFAULT_CUBE_VIEW },
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
  watchdog: null,
  detailsId: null,
  /** The microphone the plots and scene facts follow; null follows the first listening one. */
  soloId: null,
  preferences
};
state.selection = { type: 'emitter', id: state.scene.emitters[0].id };

const player = createPlayer();
const liveFields = { receiver: null, orientation: null };

const orientationBall = createOrientationBall($('cube-orientation-ball'), {
  getView: () => views[0].getView(),
  onChange: (heading, pitch) => { const target = orientationTarget(); if (target) orient(target.id, heading, pitch); },
  onCommit: () => storeScene()
});

const views = [createCubeView($('cube'), {
  onView: next => { state.preferences.cubeView = next; savePreferences(); },
  onViewChange: () => orientationBall?.draw(),
  onSelect: selection => { select(selection); refreshPanel(); },
  onMove: (handle, point) => {
    const item = findItem(handle.type, handle.id);
    if (handle.field === 'headingDegrees') {
      orient(item.id, Math.round((Math.atan2(point.x - item.positionMetres.x, point.y - item.positionMetres.y) * 180 / Math.PI + 360) % 360), item.pitchDegrees);
      return;
    }
    if (handle.field === 'radiusMetres') {
      item.radiusMetres = Math.round(Math.min(PARAMETERS.radiusMetres.maximum, Math.hypot(point.x - item.centreMetres.x, point.y - item.centreMetres.y)));
    } else item[handle.field] = point;
    liveFields[handle.type]?.[handle.field]?.set(point);
    invalidateResults();
    redrawViews();
    drawInfo();
  },
  onCommit: handle => (handle.field === 'headingDegrees' ? storeScene() : commit(() => {})),
  focus: () => focusReceiver()
})];
views[0].setView(state.preferences.cubeView);
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
  if (state.selection.type && !findItem(state.selection.type, state.selection.id)) state.selection = { type: null, id: null };
  if (state.soloId && !findItem('receiver', state.soloId)) state.soloId = null;
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
  clearInterval(state.watchdog);
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
  let workerCount = WORKER_COUNT;
  try {
    prepared = prepareScene(scene);
    const total = prepared.reduce((sum, item) => sum + item.sources.length, 0);
    workerCount = Math.max(1, Math.min(WORKER_COUNT, Math.floor(SOURCE_COPIES_BUDGET / Math.max(1, total))));
    boundaries = partitionSeconds(prepared, scene, workerCount);
  } catch (error) {
    setStatus(error.message, true);
    drawResults();
    return;
  }
  const sources = prepared.reduce((sum, item) => sum + item.sources.length, 0);
  const started = performance.now();
  const progress = new Array(workerCount).fill(0);
  const parts = new Array(workerCount);
  let remaining = workerCount;
  let heard = performance.now();
  setStatus('Rendering…');
  // A worker the browser stops, as when it runs out of memory, may never report; this ends the wait.
  state.watchdog = setInterval(() => {
    if (revision !== state.revision || performance.now() - heard < RENDER_STALL_SECONDS * 1000) return;
    stopWorkers();
    setStatus(`The render stopped responding with ${sources.toLocaleString('en')} point sources, likely out of memory`, true);
    drawResults();
  }, 5000);
  for (let index = 0; index < workerCount; index += 1) {
    const worker = new Worker(new URL('./render-worker.js', import.meta.url), { type: 'module' });
    state.workers.push(worker);
    worker.addEventListener('message', ({ data }) => {
      if (data.revision !== state.revision) return;
      heard = performance.now();
      if (data.type === 'progress') {
        progress[index] = data.fraction;
        setStatus(`Rendering ${Math.round(progress.reduce((a, b) => a + b, 0) / workerCount * 100)} %`);
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
      if (remaining === 0) finishRender(scene, prepared, parts, { sources, workers: workerCount, milliseconds: performance.now() - started });
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
  clearInterval(state.watchdog);
  const speedOfSound = soundSpeedProfile(scene.air).groundSpeed;
  try {
    state.results = new Map(scene.receivers.map(receiver => {
      const segments = parts.map(list => list.find(segment => segment.receiverId === receiver.id));
      const combined = combineSegments(segments, scene.render.sampleRate);
      return [receiver.id, {
        receiverId: receiver.id,
        sampleRate: scene.render.sampleRate,
        ...combined,
        samples: combined.channels[0],
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
  state.envelopes = envelopes([...state.results.values()]);
  earCache.clear();
  setStatus(`Rendered ${info.sources.toLocaleString('en')} point sources in ${(info.milliseconds / 1000).toFixed(1)} s on ${info.workers} threads`);
  $('play').disabled = false;
  $('export').disabled = false;
  drawResults();
  drawInfo();
}

/**
 * RMS envelopes in ENVELOPE_SECONDS windows for every microphone, on one decibel scale from the
 * loudest window of any microphone (1) down ENVELOPE_RANGE_DB (0), so their rings compare.
 */
function envelopes(results) {
  const raw = results.map(result => {
    const window = Math.max(1, Math.round(result.sampleRate * ENVELOPE_SECONDS));
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
      values[block] = maximum > 0 && values[block] > 0 ? Math.max(0, 1 + 20 * Math.log10(values[block] / maximum) / ENVELOPE_RANGE_DB) : 0;
    }
  }
  return new Map(raw.map(({ result, values }) => [result.receiverId, { window: ENVELOPE_SECONDS, startSeconds: result.startSeconds, values }]));
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
  return peakPa > 0 ? PEAK_TARGET / peakPa : 1;
}

const earCache = new Map();

/**
 * The composition as the optional ear model hears it: each listener's channels processed by the
 * reflex and loudness model, driven by its own pressure. Cached per render and setting.
 */
function earApplied(composition) {
  const { earReflex: reflex, earLoudness: loudness } = state.scene.render;
  if (!composition || (!reflex && !loudness)) return composition;
  const key = part => `${part.receiverId}:${reflex}:${loudness}:${composition.startSeconds}:${composition.length}`;
  const processed = (part, channels) => {
    const cached = earCache.get(key(part));
    if (cached?.results === state.results) return cached.channels;
    const result = applyEar(channels, composition.sampleRate, { reflex, loudness });
    earCache.set(key(part), { results: state.results, channels: result });
    return result;
  };
  const heads = composition.heads.map(head => ({ ...head, channels: processed(head, head.channels) }));
  const omnis = composition.omnis.map(omni => ({ ...omni, channel: processed(omni, [omni.channel])[0] }));
  let peakPa = 0;
  for (const channel of [...heads.map(head => head.channels[0]), ...omnis.map(omni => omni.channel)]) {
    for (const value of channel) peakPa = Math.max(peakPa, Math.abs(value));
  }
  return { ...composition, heads, omnis, peakPa };
}

/**
 * What Play and Export use: the composition of the listening microphones and its gain. Binaural
 * decoding gets 3 dB more room; a mix of several parts is scaled by 1/sqrt of their number.
 */
function listening() {
  const composition = earApplied(composeListening(state.scene, state.results));
  if (!composition) return null;
  let gain = outputGainForPeak(composition.peakPa);
  if (composition.heads.length) gain *= BINAURAL_HEADROOM;
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
/** Half the slider thumb's width: the filled track runs between thumb centres. */
const THUMB_HALF_PIXELS = 6;

/** Sets a slider's filled track from `from` to `to`, positions in [0, 1] of its range. */
function paintTrack(element, from, to) {
  const at = t => `calc(${THUMB_HALF_PIXELS}px + (100% - ${2 * THUMB_HALF_PIXELS}px) * ${t})`;
  element.style.setProperty('--from', from === 0 ? '0%' : at(from));
  element.style.setProperty('--to', at(to));
}

function macroRow(container, emitter, macro) {
  const id = `macro-${emitter.id}-${macro.label}`;
  const label = element('label', '', macro.label);
  label.htmlFor = id;
  const steps = macro.steps ?? MACRO_STEPS;
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
      input.addEventListener('input', () => { paint(); apply(read); });
      input.addEventListener('change', () => commit(() => {}));
    }
    holder.append(lower, upper);
    container.append(label, holder, value);
    return;
  }
  const input = slider(macro.read(emitter));
  input.id = id;
  paintTrack(input, 0, Number(input.value) / steps);
  input.addEventListener('input', () => { paintTrack(input, 0, Number(input.value) / steps); apply(() => [Number(input.value) / steps]); });
  input.addEventListener('change', () => commit(() => {}));
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
  resumePlayback();
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
      onCommit: value => commitListening(next => { next.receivers.find(item => item.id === receiver.id).type = value; })
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
        pointFields(container, { label: ground ? 'Ground point' : 'Start', point: emitter.baseMetres, axes: ground ? ['x', 'y'] : ['x', 'y', 'z'], onCommit: set('baseMetres') });
        pointFields(container, { label: ground ? 'Cloud end' : 'End', point: emitter.topMetres, onCommit: set('topMetres') });
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
  if ($('details').open) return;
  $('details').showModal();
  // The dialog itself takes focus, so its first button is not ringed when it opens; Tab enters it.
  $('details').focus();
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
  const limits = element('section', 'details-section details-limits');
  limits.append(element('h3', '', 'Not modelled'), element('p', '', missingPhenomena().join(' · ')));
  body.append(limits);
  body.scrollTop = scroll;
}

function missingPhenomena() {
  const missing = [...MISSING_PHENOMENA];
  if (state.scene.air.refraction) missing.push('Several ground reflections in an inversion', 'Temperature profile other than linear');
  else missing.unshift('Temperature stratification and refraction');
  if (!state.scene.air.absorption) missing.unshift('Air absorption');
  if (!state.scene.ground.enabled) missing.unshift('Ground reflection');
  return missing;
}

function refreshPanel() {
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
  if (scene.air.refraction) airField('shadowFloorDecibels');
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
  const full = scene.emitters.length >= MAXIMUM_EMITTERS;
  document.querySelectorAll('.add-row [data-mode]').forEach(item => { item.hidden = item.dataset.mode !== scene.mode; item.disabled = full; });
  document.querySelectorAll('.modes [data-mode]').forEach(item => item.setAttribute('aria-checked', String(item.dataset.mode === scene.mode)));
  $('add-receiver').disabled = scene.receivers.length >= MAXIMUM_RECEIVERS;
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
  if (emitter.kind === 'storm') return emitter.centreMetres;
  return emitter.baseMetres;
}

/** Short facts around the scene box: the selection, the listening position, and warnings. */
function drawInfo() {
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
    const anchorName = selected.kind === 'lightning' ? (selected.flashType === 'cloud-to-ground' ? 'ground point' : 'start') : selected.kind === 'storm' ? 'centre' : 'blast';
    selectedInfo.append(element('span', '', metres < 1 ? `${receiver.name} is at its ${anchorName}` : `Its ${anchorName} is ${formatMetres(metres)} ${direction} of ${receiver.name}`));
    if (selected.startSeconds) selectedInfo.append(element('span', '', `Onset ${formatSeconds(selected.startSeconds)}`));
  } else if (selected) {
    selectedInfo.append(element('strong', '', selected.name), element('span', '', `${formatMetres(selected.positionMetres.z)} above ground`));
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
      if (result.arrivals.kinds[index] !== 1) sources += 1;
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
function drawResults(playheadSeconds = null) {
  const { receivers } = state.scene;
  const soloId = receivers.length > 1 && state.soloId && findItem('receiver', state.soloId) ? state.soloId : null;
  const traces = receivers.map((receiver, index) => ({ id: receiver.id, index, listening: receiver.listen, result: state.results?.get(receiver.id) ?? null }));
  const key = `${state.results ? state.revision : 'none'}|${soloId}|${traces.map(trace => `${trace.id}:${trace.listening}`).join(',')}`;
  drawWaveform($('waveform'), { key, traces, soloId }, playheadSeconds);
  drawArrivals($('arrivals'), { key, traces, soloId }, playheadSeconds);
  if (playheadSeconds === null) drawPlotTabs(soloId);
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

/** Travel time of a blast's first sound to the receiver the view follows. */
function arrivalDelay(emitter) {
  if (emitter.kind !== 'blast' || !state.results) return 0;
  return travelSeconds(soundSpeedProfile(state.scene.air), emitter.positionMetres, focusReceiver().positionMetres);
}

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
  const strokes = new Map();
  const fronts = new Map();
  const result = state.results?.get(focusReceiver().id);
  const profile = soundSpeedProfile(state.scene.air);
  const realDelay = !clock.skippedSeconds && state.preferences.realDelay;
  for (const emitter of state.scene.emitters) {
    if (!emitter.enabled) continue;
    const timeline = strokeTimeline(emitter);
    if (realDelay || emitter.kind === 'blast') {
      strokes.set(emitter.id, timeline
        .map(stroke => ({ ...stroke, elapsed: realDelay ? now - stroke.time : now - stroke.time - arrivalDelay(emitter) }))
        .filter(stroke => stroke.elapsed >= 0 && stroke.elapsed < FLASH_TRAVERSE_SECONDS + FLASH_VISIBLE_SECONDS));
    }
    if (emitter.kind === 'blast' && result && now >= emitter.startSeconds && realDelay) {
      fronts.set(emitter.id, wavefront(profile, emitter.positionMetres, now - emitter.startSeconds));
    }
  }
  const receiver = focusReceiver().positionMetres;
  const sound = !realDelay && result ? { seconds: now, travelSeconds: point => travelSeconds(profile, point, receiver) } : null;
  const receivers = new Map();
  for (const [id, envelopeData] of state.envelopes) {
    receivers.set(id, envelopeData.values[Math.floor((now - envelopeData.startSeconds) / envelopeData.window)] ?? 0);
  }
  const wavefronts = state.preferences.wavefront ? { profile, spheres: wavefrontSpheres(now, profile) } : null;
  return { strokes, fronts, receivers, sound, wavefronts };
}

const wavefrontSources = new WeakMap();

/**
 * Every enabled emitter's sampled source points with their emission times: a blast's point, and
 * the channel points of each flash's first stroke, which lead the later strokes' nested fronts.
 */
function wavefrontCandidates(scene) {
  if (wavefrontSources.has(scene)) return wavefrontSources.get(scene);
  const candidates = [];
  for (const emitter of scene.emitters) {
    if (!emitter.enabled) continue;
    if (emitter.kind === 'blast') { candidates.push({ point: emitter.positionMetres, emitted: emitter.startSeconds }); continue; }
    for (const flash of cachedFlashes(emitter)) {
      const [stroke] = flash.strokes;
      const start = flash.startSeconds + stroke.offsetSeconds;
      for (const step of stroke.route) {
        const channel = flash.channels[step.channel];
        channel.points.forEach((point, index) => {
          const arc = channel.arcs[index];
          if (arc >= step.fromArc) candidates.push({ point, emitted: start + (step.offsetMetres + arc - step.fromArc) / flash.channelSpeedMetresPerSecond });
        });
      }
    }
  }
  const stride = Math.max(1, Math.ceil(candidates.length / WAVEFRONT_SPHERES));
  const sampled = candidates.filter((_, index) => index % stride === 0);
  wavefrontSources.set(scene, sampled);
  return sampled;
}

function wavefrontSpheres(now, profile) {
  return wavefrontCandidates(state.scene)
    .filter(candidate => now > candidate.emitted)
    .map(({ point, emitted }) => ({ source: point, ...wavefront(profile, point, now - emitted) }));
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
  drawResults(clock ? clock.sceneSeconds() : null);
  if (player.playing()) requestAnimationFrame(animate);
  else { animating = false; redrawViews(); drawResults(); }
}

function showStopped() {
  $('play').textContent = 'Play';
  $('play').setAttribute('aria-pressed', 'false');
}

function showPlaying() {
  $('play').textContent = 'Stop';
  $('play').setAttribute('aria-pressed', 'true');
  startAnimation();
}

let resuming = null;

/**
 * After a listening change during playback, plays the new composition on from the same moment.
 * A change made while the previous one is still connecting is applied once that one has started.
 */
async function resumePlayback() {
  if (resuming) { resuming.again = true; return; }
  const clock = player.clock();
  if (!player.playing() || !clock) return;
  const current = listening();
  if (!current) { player.stop(); showStopped(); return; }
  resuming = { again: false };
  let started = false;
  try {
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

$('play').addEventListener('click', async () => {
  if (player.playing()) {
    player.stop();
    showStopped();
    return;
  }
  const unlocked = player.unlock(state.scene.render.sampleRate);
  try {
    const current = listening();
    if (!current) return;
    await unlocked;
    if (await player.play(current.composition, current.gain, { realDelay: state.preferences.realDelay, onEnded: showStopped })) showPlaying();
  } catch (error) {
    player.stop();
    showStopped();
    setStatus(`Playback failed: ${error.message}`, true);
  }
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

$('export').addEventListener('click', async () => {
  const current = listening();
  if (!current) return;
  const { composition, gain } = current;
  const base = `boomtect-${slug(composition.kind)}`;
  const files = [];
  const wav = (suffix, channels, description) => {
    const file = `${base}${suffix}.wav`;
    download(file, new Blob([encodeFloat32Wav(channels, composition.sampleRate)], { type: 'audio/wav' }));
    files.push({ file, channels: channels.length, description });
  };
  const scaled = channel => channel.map(value => value * gain);
  try {
    if (composition.heads.length) {
      wav('', await renderComposition(composition, gain), composition.kind === 'mix' ? 'Binaural mix, left and right' : 'Binaural, left and right');
      for (const head of composition.heads) {
        wav(`-${slug(head.name)}-ambix`, head.channels.map(scaled), `${head.name}: ${AMBISONIC_CONVENTION}, order ${composition.order}`);
      }
    } else {
      wav('', composition.omnis.map(omni => scaled(omni.channel)), `One channel per microphone: ${composition.omnis.map(omni => omni.name).join(', ')}`);
    }
  } catch (error) {
    setStatus(`Export failed: ${error.message}`, true);
    return;
  }
  const exportDocument = {
    ...parseScene(state.scene),
    export: {
      listening: composition.kind,
      heads: composition.heads.map(head => ({ receiverId: head.receiverId, headingDegrees: head.headingDegrees, pitchDegrees: head.pitchDegrees })),
      omnis: composition.omnis.map(omni => omni.receiverId),
      files,
      sampleRate: composition.sampleRate,
      sampleFormat: 'ieee-float32',
      startSeconds: composition.startSeconds,
      fullScalePa: 1 / gain,
      peakPa: composition.peakPa,
      speedOfSoundMetresPerSecond: soundSpeedProfile(state.scene.air).groundSpeed,
      soundSpeedGradientPerSecond: soundSpeedProfile(state.scene.air).gradient,
      modelVersion: MODEL_VERSION,
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

$('wavefront').checked = state.preferences.wavefront;
$('wavefront').addEventListener('change', () => { state.preferences.wavefront = $('wavefront').checked; savePreferences(); redrawViews(); });
$('real-delay').checked = state.preferences.realDelay;
$('real-delay').addEventListener('change', () => { state.preferences.realDelay = $('real-delay').checked; savePreferences(); });
const nextName = (scene, base) => `${base} ${scene.emitters.length + 1}`;
$('add-lightning').addEventListener('click', () => addEmitter(scene => defaultLightning(uniqueId('lightning', scene.emitters), nextName(scene, 'Ground flash'), newSeed())));
$('add-cloud').addEventListener('click', () => addEmitter(scene => defaultCloudFlash(uniqueId('cloud', scene.emitters), nextName(scene, 'Cloud flash'), newSeed())));
$('add-storm').addEventListener('click', () => addEmitter(scene => defaultStorm(uniqueId('storm', scene.emitters), nextName(scene, 'Storm'), newSeed())));
$('add-blast').addEventListener('click', () => addEmitter(scene => defaultBlast(uniqueId('blast', scene.emitters), nextName(scene, 'Blast'), newSeed())));
$('add-receiver').addEventListener('click', () => commit(scene => {
  const receiver = defaultReceiver(uniqueId('receiver', scene.receivers), `Mic ${scene.receivers.length + 1}`);
  receiver.positionMetres = { ...receiver.positionMetres, x: receiver.positionMetres.x + 1000 * scene.receivers.length };
  scene.receivers.push(receiver);
  select({ type: 'receiver', id: receiver.id });
}));


window.addEventListener('resize', () => drawResults());

refreshPanel();
startRender();
