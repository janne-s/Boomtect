import { GROUND, RENDER, RENDER_COST, VIEW } from '../domain/constants.js';
import { GROUND_LABELS, GROUND_TYPES } from '../domain/ground.js';
import { newSeed } from '../domain/random.js';
import { frontProfile, PATH_DIRECT, PATH_SCATTER, PATH_SHADOW, pathProfile, soundSpeedProfile, travelSeconds, wavefront } from '../domain/refraction.js';
import { addTails, arrivalTable, assemblePaths, earliestArrival, echoesActive, finishSum, frameExtents, pathRange, hasTails, joinResponses, partitionSeconds, previewScene, echoFreeShare, receiverResult, resultDifference, sumSegments, tailSamples, tailStretches } from '../domain/render.js';
import { defaultReceiver, headingToward, placeLabel, TERRAIN_DEFAULTS } from '../domain/scene.js';
import { AMBISONIC_CONVENTION, availableItems, exportDownload, exportFiles, exportPlan, exportSizes, fileStem, itemFiles } from './export-package.js';
import { soundHandoff } from '../domain/sound-handoff.js';
import { handoffMessage } from '../domain/handoff.js';
import { ECHOTECT_URL, openTect } from './tect-link.js';
import { createPartnerLink, linkedSession } from './partner-link.js';
import { savedPath } from '../domain/follower.js';
import { balancedGains, mixedResults, resultsForPartner, separateResults, sharedKey, sharedPart, withoutEchoes, withShared } from '../domain/partner-mix.js';
import { formatMetres, formatSeconds, microphoneColor } from './canvas.js';
import { capturePatches, fetchPlaceNames, searchPlace } from './terrain-loader.js';
import { patchCount, patchRange, rangeBounds, rangePatches, terrainRange, terrainSurface } from '../domain/terrain.js';
import { createPlaceMap } from './place-map.js';
import { createCubeView } from './cube-view.js';
import { createMapLayer } from './map-layer.js';
import { createLatestTask } from './latest-task.js';
import { currentSurface, useTerrain } from './geometry-cache.js';
import { entryText, parseEntry, resetMacro } from './macros.js';
import { composeListening, firstArrivalSeconds, LISTENING_LABELS, listeningKind } from './listening.js';
import { createOrientationBall } from './orientation-ball.js';
import { createMobileLayout } from './mobile.js';
import { createSettings } from './settings.js';
import { createPlayer, renderComposition } from './player.js';
import { drawArrivals, drawWaveform, plotSeconds } from './plots.js';
import { attachSplitters } from './splitters.js';
import { attachTimelineSeek } from './timeline.js';
import { createRenderMarker, unfinishedRenderText } from './render-marker.js';
import { createFrontStyle } from './front-style.js';
import { outerSpheres, sampleEnvelopeSources } from './wavefront-envelope.js';
import { formatMicrophoneLevels } from './levels.js';

export function startFrame(tect) {
  const {
    storage: prefix, appVersion: APP_VERSION, modelVersion: MODEL_VERSION, worker: workerUrl, kinds, views: kindViews, add: ADD_EMITTERS, modes: MODE_SETTINGS, anchor: emitterAnchor,
    onsetName, preferences: tectPreferences = {}, toggles: tectToggles = {}, prepareScene, linkModes = {}, follower = null
  } = tect;
  const { MODES, PARAMETERS, defaultScene, parseScene, readScene, sceneInMode, serializeScene } = tect.scene;
  const { actionField, checkboxField, numberField, pointFields, selectField, textField } = tect.fields;
  const frontStyle = createFrontStyle(tect.propagationStyle);

  for (const [mode, { label, button: icon }] of Object.entries(MODE_SETTINGS)) {
    document.querySelector('.modes').insertAdjacentHTML('beforeend', `<button type="button" role="radio" data-mode="${mode}" aria-checked="${mode === MODES[0]}" aria-label="${label}" title="${label}"><i class="fa-solid ${icon}" aria-hidden="true"></i><span>${label}</span></button>`);
  }
  for (const [id, { mode, label }] of Object.entries(ADD_EMITTERS)) {
    document.querySelector('.add-row').insertAdjacentHTML('beforeend', `<button type="button" id="add-${id}" data-mode="${mode}">+ ${label}</button>`);
  }
  const appName = prefix[0].toUpperCase() + prefix.slice(1);
  document.getElementById('open').insertAdjacentHTML('beforebegin', `<span class="link-buttons" id="link-buttons"></span>`);
  document.getElementById('wavefront').insertAdjacentHTML('afterend', Object.entries(tectToggles).map(([id, { label, icon }]) => `<button type="button" class="icon-toggle" id="${id}" aria-pressed="false" aria-label="${label}" title="${label}" hidden>${icon}</button>`).join(''));

  const sceneStorageKey = mode => `${prefix}.scene.${mode}`;
  const linkedStorageKey = mode => `${prefix}.linked.scene.${mode}`;
  const FRESH_LINK_KEY = 'tect.link.fresh';
  /** A window the link opened starts with no emitters of its own, and its saved scenes stay as they were. */
  const freshLink = () => { try { return sessionStorage.getItem(FRESH_LINK_KEY) === '1'; } catch { return false; } };
  const setFreshLink = on => { try { if (on) sessionStorage.setItem(FRESH_LINK_KEY, '1'); else sessionStorage.removeItem(FRESH_LINK_KEY); } catch {} };
  const loadedAt = performance.now();
  const linkedAtLoad = Boolean(linkedSession());
  const PREFERENCES_STORAGE_KEY = `${prefix}.preferences`;
  let resetting = false;
  window.addEventListener('app-reset', () => { resetting = true; });
  const WORKER_COUNT = Math.max(1, Math.min(RENDER.maximumWorkers, (navigator.hardwareConcurrency || 2) - 1));
  const workerLimit = () => Math.max(1, Math.min(WORKER_COUNT, state.preferences.threads || WORKER_COUNT));


  const $ = id => document.getElementById(id);

  const RENDER_MARKER_STORAGE_KEY = `${prefix}.renderUnfinished`;
  const renderMarker = createRenderMarker({
    getItem: key => localStorage.getItem(key),
    setItem: (key, value) => { if (!resetting) localStorage.setItem(key, value); },
    removeItem: key => localStorage.removeItem(key)
  }, RENDER_MARKER_STORAGE_KEY);
  // Read before anything renders, which would replace it.
  const unfinishedRender = renderMarker.take();

  const storage = {
    read(key) {
      try { return JSON.parse(localStorage.getItem(key)); } catch { return null; }
    },
    write(key, value) {
      if (resetting) return;
      try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
    }
  };

  function savedScene(key, mode) {
    try {
      const scene = readScene(storage.read(key));
      if (scene.mode === mode) return scene;
    } catch {}
    return null;
  }

  function restoredScene(mode) {
    if (linkedSession()) {
      const linkedScene = savedScene(linkedStorageKey(mode), mode);
      if (linkedScene) return linkedScene;
      if (freshLink()) return { ...defaultScene(mode), emitters: [] };
    }
    return savedScene(sceneStorageKey(mode), mode) ?? defaultScene(mode);
  }

  const preferences = {
    realDelay: true, wavefronts: Object.fromEntries(MODES.map(mode => [mode, true])), contours: true, names: false, map: false, ...tectPreferences, autoRender: true, preview: false, mode: MODES[0],
    terrainDraft: { cellMetres: 30 }, cubeViews: {},
    panelWidth: 340, resultsHeight: 220,
    ...(storage.read(PREFERENCES_STORAGE_KEY) ?? {})
  };
  if (!MODES.includes(preferences.mode)) preferences.mode = MODES[0];

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
    ownResults: null,
    ownKey: null,
    preferences
  };
  if (!['real', 'balanced'].includes(state.preferences.partner?.balance)) state.preferences.partner = { balance: 'balanced' };
  state.selection = { type: 'emitter', id: state.scene.emitters[0]?.id ?? null };

  const player = createPlayer({
    onChange: () => syncPlayButton(),
    onInterrupted(position, message) {
      state.pause = position;
      drawStill();
      setStatus(message, true);
    }
  });
  window.addEventListener('app-reset', () => player.dispose());
  const MODE_ICONS = Object.fromEntries(MODES.map(mode => [mode, MODE_SETTINGS[mode].icon]));
  const mobile = createMobileLayout({ onResults: () => drawResults(), icons: MODE_ICONS });
  createSettings({
    read: () => ({
      quality: state.scene.render.quality,
      preview: state.preferences.preview,
      threads: workerLimit(),
      maximumThreads: WORKER_COUNT,
      echoCellMetres: echoesActive(state.scene) ? state.scene.terrain.echoCellMetres : null,
      flashes: state.scene.emitters.some(emitter => kinds[emitter.kind].mergesSources),
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
  const liveFields = { receiver: null, orientation: null, warnings: null, summary: null };

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

  document.addEventListener('keydown', event => { if (event.key === 'Tab') document.documentElement.dataset.keyboard = ''; }, true);
  document.addEventListener('pointerdown', () => { delete document.documentElement.dataset.keyboard; }, true);

  const mapLayer = createMapLayer(() => redrawViews());

  const sceneKeys = new WeakMap();
  function sceneKey(scene) {
    if (!sceneKeys.has(scene)) sceneKeys.set(scene, sharedKey(sharedPart(scene)));
    return sceneKeys.get(scene);
  }

  const linked = { emitters: [], mix: null, held: null, updating: false, muted: null, sentKey: null, serving: Promise.resolve(), created: new Set(), error: null, resentAt: 0 };

  const link = createPartnerLink({
    app: appName,
    handlers: {
      onStatus: () => drawLink(),
      onLinked: () => { linked.sentKey = sceneKey(state.scene); sendEmitters(); sendMix(); drawLink(); },
      onUnlinked: () => {
        Object.assign(linked, { emitters: [], mix: null, held: null, updating: false, muted: null });
        if (!linkedSession()) { setFreshLink(false); storeScene(); }
        $('link-dialog')?.close();
        showResults();
        redrawViews();
        drawLink();
      },
      onShared: shared => applyShared(shared),
      onWant: () => resendScene(),
      onOffer: (shared, mode) => {
        if (window.opener && !linkedAtLoad && !freshLink() && performance.now() - loadedAt < VIEW.freshLinkSeconds * 1000) {
          setFreshLink(true);
          if (MODES.includes(mode) && mode !== state.scene.mode) switchMode(mode);
          else { state.scene = { ...state.scene, emitters: [] }; state.selection = { type: null, id: null }; storeScene(); invalidateResults(); refreshPanel(); }
        } else if (MODES.includes(mode)) switchMode(mode);
        applyShared(shared);
      },
      onEmitters: emitters => { linked.emitters = Array.isArray(emitters) ? emitters : []; redrawViews(); syncFollowers(); scheduleTerrainCoverage(); },
      onMix: message => receiveMix(message),
      onRequest: (variant, key) => { const answer = linked.serving.then(() => serveRequest(variant, key)); linked.serving = answer.catch(() => {}); return answer; },
      onSelect: id => { if (findItem('emitter', id)) { select({ type: 'emitter', id }); refreshPanel(); redrawViews(); } },
      onError: message => setStatus(message, true)
    }
  });
  drawLink();

  const views = [createCubeView($('cube'), {
    kinds: kindViews,
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
      if (!(handle.type === 'emitter' && kinds[item.kind].move(handle, item, point))) {
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
    map: () => state.preferences.map,
    mapTiles: area => mapLayer.tiles(state.scene.place, area),
    ghosts: () => (link.partner() ? linked.emitters : []),
    onGhost: ghost => link.send('select', { id: ghost.id }),
    clouds: () => state.preferences.clouds
  })];

  function groundAnchored(handle, item) {
    return handle.type === 'emitter' ? kinds[item.kind].groundAnchored(handle.field, item) : handle.field === 'positionMetres';
  }

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


  const plotted = result => {
    if (!result) return null;
    let peakPa = result.peakPa ?? 0;
    if (!(peakPa > 0)) for (const value of result.channels[0]) peakPa = Math.max(peakPa, Math.abs(value));
    return { ...result, samples: result.channels[0], peakPa };
  };
  /** Real keeps both tects' pressures as they are; Balanced lifts the quieter one to the louder one's loudest A-weighted level. */
  function linkGains(partner = partnerResults()) {
    if (state.preferences.partner.balance !== 'balanced' || !partner?.length || !state.ownResults) return { own: 1, partner: 1 };
    return balancedGains([...state.ownResults.values()], partner);
  }
  const gainText = gain => { const decibels = Math.round(20 * Math.log10(gain)); return decibels === 0 ? '0 dB' : `${decibels > 0 ? '+' : '−'}${Math.abs(decibels)} dB`; };
  const partnerResults = () => (linked.mix && linked.mix.key === sceneKey(state.scene) ? linked.mix.results : null);
  const ownSilent = () => !state.scene.emitters.some(emitter => emitter.enabled);

  /** The own render and the linked tect's at the same microphones, summed; everything heard, plotted, and exported comes from this. */
  function showResults() {
    const partner = link.partner() ? partnerResults() : null;
    const ownReady = state.ownResults || (ownSilent() && state.ownKey === sceneKey(state.scene));
    const gains = linkGains(partner);
    state.realResults = ownReady && (state.ownResults || partner) ? mixedResults(state.scene, state.ownResults, partner, 1) : null;
    const balanced = state.realResults && (gains.own !== 1 || gains.partner !== 1) ? mixedResults(state.scene, state.ownResults, partner, gains.partner, gains.own) : state.realResults;
    const muted = balanced && partner && linked.muted;
    state.results = muted ? mixedResults(state.scene, muted === 'own' ? null : state.ownResults, muted === 'partner' ? null : partner, gains.partner, gains.own) ?? balanced : balanced;
    $('export').disabled = !state.results;
    if (state.results) {
      state.envelopes = envelopes([...balanced.values()]);
      earCache.clear();
    }
    syncPlayButton();
    drawResults();
    drawInfo();
    if (!state.results) return;
    prepareListening();
    if (player.playing()) resumePlayback();
  }

  function sendMix() {
    if (!link.partner() || state.ownKey !== sceneKey(state.scene)) return;
    const results = state.ownResults ? resultsForPartner(state.ownResults) : [];
    link.send('mix', { state: 'ready', key: state.ownKey, results }, results.flatMap(result => result.channels.map(samples => samples.buffer)));
  }

  /** The leading window sends its shared part again, at most every few seconds, when the two have drifted apart. */
  function resendScene() {
    if (!link.partner() || !link.leads() || performance.now() - linked.resentAt < VIEW.linkResendMilliseconds) return;
    linked.resentAt = performance.now();
    linked.sentKey = sceneKey(state.scene);
    link.send('scene', { shared: sharedPart(state.scene) });
  }

  function receiveMix(message) {
    if (message.state === 'updating') { linked.updating = true; drawLink(); drawResults(); return; }
    if (message.key && message.key !== sceneKey(state.scene)) {
      if (link.leads()) resendScene(); else link.send('want', {});
    }
    linked.updating = false;
    const mix = { key: message.key, results: Array.isArray(message.results) ? message.results : [] };
    if (!state.preferences.autoRender && linked.mix) linked.held = mix;
    else { linked.mix = mix; linked.held = null; showResults(); }
    drawLink();
  }

  function adoptHeld() {
    if (!linked.held) return;
    linked.mix = linked.held;
    linked.held = null;
    showResults();
    drawLink();
  }

  function shareScene() {
    if (!link.partner()) return;
    const key = sceneKey(state.scene);
    if (key !== linked.sentKey) {
      linked.sentKey = key;
      clearTimeout(shareScene.timer);
      shareScene.timer = setTimeout(() => link.send('scene', { shared: sharedPart(state.scene) }), VIEW.linkDelayMilliseconds);
    }
    clearTimeout(sendEmitters.timer);
    sendEmitters.timer = setTimeout(sendEmitters, VIEW.linkDelayMilliseconds);
  }

  const thinned = (count, limit) => Math.max(1, Math.ceil(count / limit));

  /** What the linked tect draws of each enabled emitter here: its paths or points, thinned, and where its name goes. */
  function emitterGhosts() {
    return state.scene.emitters.filter(emitter => emitter.enabled && !(emitter.follows && emitter.follows.app === link.partner())).map(emitter => {
      const kind = kinds[emitter.kind];
      const paths = kind.tracks?.(emitter, state.scene) ?? null;
      const follow = paths && kind.followAs?.(emitter, state.scene);
      const tracks = (paths ?? []).map(path => {
        const stride = thinned(path.x.length, VIEW.linkTrackPoints);
        const points = [];
        for (let index = 0; index < path.x.length; index += stride) points.push({ x: path.x[index], y: path.y[index], z: path.z[index] });
        return { points, startSeconds: path.seconds[0], stepSeconds: path.step * stride };
      });
      const all = [];
      if (!paths) kind.measure(emitter, state.scene, point => all.push({ x: point.x, y: point.y, z: point.z ?? 0 }));
      const stride = thinned(all.length, VIEW.linkPoints);
      const dots = all.filter((_, index) => index % stride === 0);
      const anchor = emitterAnchor(emitter);
      return {
        id: emitter.id, name: emitter.name, label: kind.label(emitter), tracks, dots, anchor: { x: anchor.x, y: anchor.y, z: anchor.z ?? 0 },
        follow: follow ? { ...follow, paths: paths.map(savedPath) } : null
      };
    });
  }

  /** Keeps one follower here for every emitter of the linked tect this tect can give a sound to; one removed here stays removed. */
  function syncFollowers() {
    const partner = link.partner();
    if (!partner || !follower) return;
    const followed = new Map(linked.emitters.filter(ghost => ghost.follow).map(ghost => [ghost.id, ghost]));
    const emitters = state.scene.emitters.filter(emitter => !(emitter.follows?.app === partner && !followed.has(emitter.follows.id)));
    let changed = emitters.length !== state.scene.emitters.length;
    for (const ghost of followed.values()) {
      const index = emitters.findIndex(emitter => emitter.follows?.app === partner && emitter.follows.id === ghost.id);
      if (index < 0 && linked.created.has(`${partner}:${ghost.id}`)) continue;
      const made = follower(ghost, index < 0 ? null : emitters[index], { partner, uniqueId: base => uniqueId(base, emitters), scene: state.scene });
      if (!made) continue;
      if (index < 0) { emitters.push(made); linked.created.add(`${partner}:${ghost.id}`); changed = true; }
      else if (JSON.stringify(made) !== JSON.stringify(emitters[index])) { emitters[index] = made; changed = true; }
    }
    if (!changed) return;
    try { parseScene({ ...state.scene, emitters }); } catch { return; }
    commit(scene => { scene.emitters = emitters; });
  }

  function sendEmitters() {
    if (!link.partner()) return;
    try { link.send('emitters', { emitters: emitterGhosts() }); } catch (error) { setStatus(`Linking failed: ${error.message}`, true); }
  }

  function applyShared(shared) {
    if (!shared || typeof shared !== 'object') return;
    let next;
    try {
      next = parseScene(withShared(state.scene, shared));
    } catch (error) {
      linked.error = `${link.partner()}'s scene was not taken here: ${error.message}`;
      setStatus(linked.error, true);
      drawLink();
      return;
    }
    if (linked.error) { linked.error = null; drawLink(); }
    const key = sceneKey(next);
    if (key === sceneKey(state.scene)) return;
    linked.sentKey = key;
    state.scene = next;
    storeScene();
    scheduleTerrainCoverage();
    if (state.selection.type && !findItem(state.selection.type, state.selection.id)) state.selection = { type: null, id: null };
    if (state.soloId && !findItem('receiver', state.soloId)) state.soloId = null;
    invalidateResults();
    refreshPanel();
    requestRender();
  }

  /** A linked tect asks for this tect's sound in full, or without terrain echoes, for its export. */
  async function serveRequest(variant, key) {
    if (key !== sceneKey(state.scene)) {
      if (link.leads()) resendScene(); else link.send('want', {});
      throw new Error('the two windows hold different scenes; they are being matched, try again in a moment');
    }
    if (ownSilent()) return [];
    if (variant === 'dry' && echoesActive(state.scene)) {
      const own = await renderFull(withoutEchoes(state.scene));
      if (!state.ownResults && !operations.has('render')) requestRender();
      return resultsForPartner(own);
    }
    if (!state.ownResults || state.resultsPreview || state.ownKey !== key) await renderFull();
    return resultsForPartner(state.ownResults);
  }

  /** Own and linked sound at full quality, for an export or Echotect. */
  async function fullResults() {
    const partnerFull = link.partner() ? link.request('full', sceneKey(state.scene)) : null;
    if (state.resultsPreview || (!state.ownResults && !ownSilent())) await renderFull();
    if (!partnerFull) return;
    linked.mix = { key: sceneKey(state.scene), results: (await partnerFull) ?? [] };
    linked.held = null;
    showResults();
  }

  function drawLink() {
    const holder = $('link-buttons');
    const partner = link.partner();
    holder.replaceChildren(...link.others.map(name => {
      const item = element('button', partner === name ? 'link-button linked' : 'link-button');
      item.type = 'button';
      const waiting = link.offering() === name;
      item.textContent = partner === name ? (linked.error ? `${name} · not matched` : name) : waiting ? `Linking ${name}…` : link.present(name) ? `Link ${name}` : `Open ${name}`;
      if (partner === name) {
        item.prepend(element('span', linked.error ? 'link-dot error' : linked.updating ? 'link-dot updating' : 'link-dot'));
        item.title = linked.error ?? (linked.updating ? `${name} is updating its sound` : `Linked with ${name}`);
        item.setAttribute('aria-haspopup', 'dialog');
      }
      item.disabled = waiting;
      item.addEventListener('click', () => {
        if (partner === name) { openLinkDialog(); return; }
        try { link.open(name, sharedPart(state.scene), linkModes[name]?.[state.scene.mode] ?? null); } catch (error) { setStatus(error.message, true); }
      });
      return item;
    }));
    if (partner && linked.held) {
      const update = element('button', 'icon-toggle');
      update.type = 'button';
      update.title = `Take ${partner}'s new sound`;
      update.setAttribute('aria-label', update.title);
      update.innerHTML = '<i class="fa-solid fa-rotate" aria-hidden="true"></i>';
      update.addEventListener('click', adoptHeld);
      holder.append(update);
    }
  }

  function openLinkDialog() {
    const partner = link.partner();
    if (!partner) return;
    const dialog = $('link-dialog') ?? document.body.appendChild(Object.assign(document.createElement('dialog'), { id: 'link-dialog', className: 'settings-dialog', tabIndex: -1 }));
    const header = element('header', 'details-header');
    header.append(element('h2', '', partner));
    const footer = element('footer', 'export-actions');
    footer.append(
      button('Unlink', () => { dialog.close(); link.unlink(); }),
      button(`Show ${partner}`, () => link.open(partner)),
      button('Done', () => dialog.close())
    );
    footer.lastChild.classList.add('primary');
    dialog.replaceChildren(header, footer);
    if (dialog.open) return;
    dialog.showModal();
    dialog.focus();
  }

  function invalidateResults() {
    clearTimeout(state.renderTimer);
    stopWorkers();
    player.stop();
    state.pause = null;
    state.results = null;
    state.realResults = null;
    state.ownResults = null;
    $('export').disabled = true;
    syncPlayButton();
  }

  const operations = new Map();
  let operationsTimer = null;

  function operation(key, text, { share = null, limitSeconds = null } = {}) {
    if (text === null) operations.delete(key);
    else operations.set(key, { text, share, limitSeconds, since: operations.get(key)?.since ?? performance.now() });
    drawOperations();
    if (key === 'render') {
      renderMarker.phase(text);
      syncPlayButton();
    }
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

  function syncPlayButton() {
    const button = $('play');
    const playing = player.playing();
    const starting = player.busy();
    const rendering = operations.has('render');
    const busy = !playing && !starting && rendering;
    button.textContent = playing || starting ? 'Stop' : busy ? '' : state.results ? 'Play' : 'Render';
    button.setAttribute('aria-label', busy ? 'Rendering' : button.textContent);
    if (busy || starting) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
    button.disabled = !playing && !starting && (rendering || (!state.results && !state.scene.emitters.some(emitter => emitter.enabled)));
    button.setAttribute('aria-pressed', playing ? 'true' : 'false');
    const pause = $('plot-play');
    pause.disabled = !state.results;
    pause.setAttribute('aria-label', playing || starting ? 'Pause' : 'Play');
    pause.classList.toggle('playing', playing || starting);
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
    state.revision += 1;
    state.workers.forEach(worker => worker.terminate());
    state.workers = [];
    clearInterval(state.watchdog);
    operation('render', null);
    state.fullRender?.reject(new Error('The full render did not finish.'));
    state.fullRender = null;
  }

  function renderFull(variant = null) {
    return new Promise((resolve, reject) => {
      startRender({ full: true, variant });
      if (!operations.has('render')) { reject(new Error('Nothing to render.')); return; }
      state.fullRender = { resolve, reject };
    });
  }

  function spawnWorker(revision, message, { onProgress, onResult }, transfer = []) {
    const worker = new Worker(workerUrl, { type: 'module' });
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

  function startRender({ full = false, variant = null } = {}) {
    stopWorkers();
    const revision = state.revision;
    setStatus('');
    const scene = variant ?? (state.preferences.preview && !full ? previewScene(state.scene) : state.scene);
    if (!variant) state.renderKey = sceneKey(state.scene);
    if (!scene.emitters.some(emitter => emitter.enabled)) {
      if (variant) return;
      state.ownResults = null;
      state.ownKey = state.renderKey;
      sendMix();
      if (scene.emitters.length && !link.partner()) setStatus('No emitter is enabled.');
      showResults();
      return;
    }
    if (!variant) {
      link.send('mix', { state: 'updating' });
      if (linked.held) { linked.mix = linked.held; linked.held = null; drawLink(); }
    }
    let sources;
    let prepared;
    let workerCount = workerLimit();
    renderMarker.phase('Preparing sources', { preview: Boolean(scene.render.preview) });
    try {
      prepared = prepareScene(scene);
      sources = prepared.reduce((sum, item) => sum + item.sources.length, 0);
      workerCount = Math.max(1, Math.min(workerLimit(), Math.floor(RENDER.sourceCopiesBudget / Math.max(1, sources))));
    } catch (error) {
      renderMarker.phase(null);
      setStatus(error.message, true);
      drawResults();
      return;
    }
    const started = performance.now();
    state.heard = performance.now();
    renderMarker.phase('Tracing paths', { sources });
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
            // The parts are in the assembled paths now; holding them would keep both through the render.
            traced.fill(null);
            arrivals = scene.receivers.map((receiver, receiverIndex) => arrivalTable(prepared, receiver, scene, { paths: tracedPaths[receiverIndex] }));
          } catch (error) {
            failRender(error.message);
            return;
          }
          renderRanges(revision, scene, prepared, arrivals, tracedPaths, responses, { sources, workerCount, started, variant: Boolean(variant) });
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
      return Array.from({ length: shares[index] }, (_, part) => ({ receivers: [index], fromSeconds: boundaries[part], toSeconds: boundaries[part + 1] }))
        .filter(job => job.fromSeconds < job.toSeconds);
    });
  }

  function renderRanges(revision, scene, prepared, arrivals, tracedPaths, responses, info) {
    const jobs = renderJobs(scene, arrivals, info.workerCount);
    const progress = new Array(jobs.length).fill(0);
    const parts = new Array(jobs.length);
    let remaining = jobs.length;
    operation('render', 'Rendering', { share: 0 });
    const extents = tracedPaths.map(paths => frameExtents(prepared, paths));
    jobs.forEach((job, index) => {
      const whole = !Number.isFinite(job.fromSeconds) && !Number.isFinite(job.toSeconds);
      const paths = job.receivers.map(receiver => (whole ? tracedPaths[receiver] : pathRange(tracedPaths[receiver], job.fromSeconds, job.toSeconds)));
      const transfer = paths.flatMap(table => Object.values(table).filter(ArrayBuffer.isView).map(array => array.buffer));
      spawnWorker(revision, { type: 'render', scene, ...job, paths, extents: job.receivers.map(receiver => extents[receiver]), earliest: job.receivers.map(receiver => earliestArrival(tracedPaths[receiver])) }, {
        onProgress: fraction => {
          progress[index] = fraction;
          operation('render', 'Rendering', { share: progress.reduce((a, b) => a + b, 0) / jobs.length });
        },
        onResult: data => {
          parts[index] = data.segments;
          remaining -= 1;
          if (remaining === 0) responses.then(list => { if (revision === state.revision) addRenderTails(revision, scene, arrivals, parts, list, info); });
        }
      }, [...new Set(transfer)]);
    });
    // The workers' handlers would otherwise keep the whole table alive through the render.
    tracedPaths.fill(null);
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
      failRender(error.message);
      return;
    }
    if (info.variant) {
      operation('render', null);
      state.fullRender?.resolve(results);
      state.fullRender = null;
      return;
    }
    state.ownResults = results;
    state.ownKey = state.renderKey;
    state.resultsPreview = Boolean(scene.render.preview);
    state.lastRender = { milliseconds: info.milliseconds, workers: info.workers, quality: scene.render.quality };
    setStatus(`${state.resultsPreview ? 'Preview: rendered' : 'Rendered'} ${info.sources.toLocaleString('en')} point sources in ${(info.milliseconds / 1000).toFixed(1)} s on ${info.workers} threads`);
    operation('render', null);
    sendMix();
    showResults();
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
      const worker = new Worker(new URL('../ear-worker.js', import.meta.url), { type: 'module' });
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
        for (const stored of earCache.keys()) if (stored.startsWith(`${part.receiverId}:`)) earCache.delete(stored);
        const entry = { results, channels: batch.then(all => all[index]) };
        earCache.set(key(part), entry);
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

  /** Composes what Play will hear as soon as there is a result, so Play neither waits for it nor starts beside it. */
  function prepareListening() {
    if (!state.results) return;
    listening().catch(error => setStatus(`Preparing playback failed: ${error.message}`, true));
  }

  const decodedPeaks = new WeakMap();

  /** The binaural decoder changes both peak and level with the content and the order, so the heard peak is measured after it. */
  function decodedPeak(composition) {
    if (!decodedPeaks.has(state.results)) decodedPeaks.set(state.results, new Map());
    const peaks = decodedPeaks.get(state.results);
    const key = [composition.kind, composition.order, composition.peakPa, composition.startSeconds, composition.length,
      ...composition.heads.map(head => `${head.receiverId}:${head.headingDegrees}:${head.pitchDegrees}`), ...composition.omnis.map(omni => omni.receiverId)].join('|');
    if (!peaks.has(key)) {
      const peak = renderComposition(composition, 1).then(channels => {
        let value = 0;
        for (const channel of channels) for (const sample of channel) value = Math.max(value, Math.abs(sample));
        return value;
      });
      peak.catch(() => { if (peaks.get(key) === peak) peaks.delete(key); });
      peaks.set(key, peak);
    }
    return peaks.get(key);
  }

  async function listening() {
    const composition = await earApplied(composeListening(state.scene, state.results));
    if (!composition) return null;
    let gain = outputGainForPeak(composition.peakPa);
    if (composition.heads.length) gain *= RENDER.binauralHeadroom;
    if (composition.kind === 'mix') gain /= Math.sqrt(composition.parts);
    let playbackGain = gain;
    if (composition.heads.length) {
      const peak = await decodedPeak(composition);
      if (peak > 0) playbackGain = outputGainForPeak(composition.peakPa) * composition.peakPa / peak;
    }
    return { composition, gain, playbackGain };
  }

  function savePreferences() {
    storage.write(PREFERENCES_STORAGE_KEY, state.preferences);
  }

  const emitterKindLabel = emitter => kinds[emitter.kind].label(emitter);
  const emitterSummary = emitter => kinds[emitter.kind].summary(emitter, state.scene);
  const emitterWarnings = emitter => kinds[emitter.kind].warnings?.(emitter, state.scene) ?? [];

  const updateEmitter = (id, change) => commit(scene => change(scene.emitters.find(emitter => emitter.id === id)));
  const updateReceiver = (id, change) => commit(scene => change(scene.receivers.find(receiver => receiver.id === id)));

  function preview(change) {
    change(state.scene);
    liveFields.warnings?.();
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

  const macroRows = new WeakMap();

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
    const showValue = item => {
      value.textContent = macro.show(item);
      if (macro.entry) value.setAttribute('aria-label', `${macro.label} ${value.textContent}`);
    };
    const siblings = macroRows.get(container) ?? [];
    macroRows.set(container, siblings);
    const reset = () => {
      const create = ADD_EMITTERS[emitter.kind]?.create;
      if (create) commit(scene => resetMacro(macro, scene.emitters.find(item => item.id === emitter.id), create()));
    };
    const apply = read => preview(scene => {
      const item = scene.emitters.find(candidate => candidate.id === emitter.id);
      macro.write(item, ...read());
      showValue(item);
      for (const row of siblings) if (row.macro !== macro) row.sync(item);
      liveFields.summary?.(item);
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
      siblings.push({ macro, sync: item => { const [a, b] = macro.read(item); lower.value = String(Math.round(a * steps)); upper.value = String(Math.round(b * steps)); paint(); showValue(item); } });
      for (const input of [lower, upper]) {
        input.addEventListener('input', () => { holdViews(true); paint(); apply(read); });
        input.addEventListener('change', () => { holdViews(false); commit(() => {}); });
        input.addEventListener('dblclick', reset);
      }
      holder.append(lower, upper);
      container.append(label, holder, value);
      return;
    }
    const input = slider(macro.read(emitter));
    input.id = id;
    paintTrack(input, 0, Number(input.value) / steps);
    siblings.push({ macro, sync: item => { input.value = String(Math.round(macro.read(item) * steps)); paintTrack(input, 0, Number(input.value) / steps); showValue(item); } });
    input.addEventListener('input', () => { holdViews(true); paintTrack(input, 0, Number(input.value) / steps); apply(() => [Number(input.value) / steps]); });
    input.addEventListener('change', () => { holdViews(false); commit(() => {}); });
    input.addEventListener('dblclick', reset);
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
      const summary = element('p', 'card-summary', emitterSummary(emitter));
      liveFields.summary = item => { summary.textContent = emitterSummary(item); };
      card.append(summary);
      if (kinds[emitter.kind].warnings) {
        const warnings = element('div', 'card-warnings');
        const fillWarnings = () => warnings.replaceChildren(...emitterWarnings(state.scene.emitters.find(item => item.id === emitter.id) ?? emitter).map(text => element('p', 'card-warning', text)));
        fillWarnings();
        liveFields.warnings = fillWarnings;
        card.append(warnings);
      }
      const macros = element('div', 'macros');
      kinds[emitter.kind].macros(emitter, { onset: scene.emitters.length > 1 || emitter.startSeconds > 0 }).forEach(macro => macroRow(macros, emitter, macro));
      card.append(macros);
      const actions = element('div', 'card-actions');
      actions.append(button('Details…', () => openDetails(emitter.id)));
      const seeded = kinds[emitter.kind].seeded(emitter);
      if (seeded) {
        actions.append(button(kinds[emitter.kind].reseedLabel?.(emitter) ?? 'New seed', () => updateEmitter(emitter.id, item => { item.seed = newSeed(); }), { title: 'Same parameters, new seed' }));
      }
      actions.append(button('Variant', () => addEmitter(next => {
        const source = next.emitters.find(item => item.id === emitter.id);
        source.enabled = false;
        return { ...structuredClone(source), id: uniqueId(source.kind, next.emitters), name: `${source.name} variant`.slice(0, 64), ...(seeded ? { seed: newSeed() } : {}), enabled: true };
      }), { disabled: scene.emitters.length >= RENDER.maximumEmitters, title: seeded ? 'Copy with a new seed; the original is switched off' : 'Copy to change; the original is switched off' }));
      card.append(actions);
    }
    container.append(card);
  }

  function commitListening(change) {
    if (!applyScene(change)) return;
    if (player.busy() && !player.playing()) { player.stop(); setStatus(''); }
    refreshPanel();
    drawInfo();
    if (player.playing()) resumePlayback();
    else prepareListening();
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
    if (linkedSession()) storage.write(linkedStorageKey(state.scene.mode), state.scene);
    if (!freshLink()) storage.write(sceneStorageKey(state.scene.mode), state.scene);
    shareScene();
  }

  const RECEIVER_TYPE_LABELS = Object.freeze({ omni: 'Omni', binaural: 'Binaural' });

  function receiverCard(container, receiver, selected) {
    const remove = element('button', 'icon-button');
    remove.type = 'button';
    remove.title = 'Remove';
    remove.disabled = state.scene.receivers.length <= 1;
    remove.style.visibility = remove.disabled ? 'hidden' : '';
    remove.setAttribute('aria-label', `Remove ${receiver.name}`);
    remove.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
    remove.addEventListener('click', event => {
      event.stopPropagation();
      commit(next => { next.receivers = next.receivers.filter(item => item.id !== receiver.id); });
    });
    remove.addEventListener('keydown', event => event.stopPropagation());
    const card = cardNode(selected, {
      checked: receiver.listen, title: 'Listen',
      onCheck: on => commitListening(next => { next.receivers.find(item => item.id === receiver.id).listen = on; }),
      onToggle: () => { select(selected ? { type: null, id: null } : { type: 'receiver', id: receiver.id }); refreshPanel(); }
    }, element('span', 'name', receiver.name), element('span', 'kind', `${RECEIVER_TYPE_LABELS[receiver.type]} · ${formatMetres(receiver.positionMetres.z)}`), remove);
    if (selected) {
      const fields = element('div', 'fields');
      textField(fields, { label: 'Name', value: receiver.name, onCommit: value => updateReceiver(receiver.id, item => { item.name = value; }) });
      selectField(fields, {
        label: 'Type', value: receiver.type, options: Object.entries(RECEIVER_TYPE_LABELS),
        onCommit: value => {
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
    }
    container.append(card);
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
    body.replaceChildren(...kinds[emitter.kind].details(emitter, { updateEmitter, scene: state.scene }).map(({ title, build }) => {
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
  const terrainLoadTask = createLatestTask();
  const terrainCoverageTask = createLatestTask();
  const placeNamesTask = createLatestTask();
  const placeSearchTask = createLatestTask();

  function cancelGeographicTasks() {
    clearTimeout(terrainCoverageTimer);
    terrainLoadTask.cancel();
    terrainCoverageTask.cancel();
    placeNamesTask.cancel();
    placeSearchTask.cancel();
    for (const key of ['terrain', 'names', 'place']) operation(key, null);
  }

  function sceneBounds(scene) {
    const bounds = { west: Infinity, east: -Infinity, south: Infinity, north: -Infinity };
    const include = point => {
      bounds.west = Math.min(bounds.west, point.x); bounds.east = Math.max(bounds.east, point.x);
      bounds.south = Math.min(bounds.south, point.y); bounds.north = Math.max(bounds.north, point.y);
    };
    for (const emitter of scene.emitters) kinds[emitter.kind].bounds(emitter, scene, include);
    scene.receivers.forEach(receiver => include(receiver.positionMetres));
    if (link.partner()) {
      for (const ghost of linked.emitters) {
        include(ghost.anchor);
        ghost.tracks.forEach(track => track.points.forEach(include));
        ghost.dots.forEach(include);
      }
    }
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

  async function coveredTerrain(terrain, anchor, needed, label, task) {
    const { cellMetres, range } = needed;
    const keep = terrain && terrain.cellMetres === cellMetres && terrain.latitude === anchor.latitude && terrain.longitude === anchor.longitude
      ? terrain.patches.filter(patch => patch.column >= range.column0 && patch.column <= range.column1 && patch.row >= range.row0 && patch.row <= range.row1) : [];
    const have = new Set(keep.map(patch => `${patch.column},${patch.row}`));
    const missing = rangePatches(range).filter(({ column, row }) => !have.has(`${column},${row}`));
    const fetched = missing.length ? await capturePatches(anchor, cellMetres, missing, {
      signal: task.signal,
      onProgress: share => { if (task.current()) operation('terrain', label, { share }); }
    }) : [];
    const bounds = rangeBounds(range, cellMetres);
    const names = (terrain?.names ?? []).filter(item => item.x >= bounds.west && item.x <= bounds.east && item.y >= bounds.south && item.y <= bounds.north);
    return { latitude: anchor.latitude, longitude: anchor.longitude, cellMetres, patches: [...keep, ...fetched], names };
  }

  function scheduleTerrainCoverage() {
    clearTimeout(terrainCoverageTimer);
    terrainCoverageTask.cancel();
    if (terrainLoadTask.busy) return;
    operation('terrain', null);
    terrainCoverageTimer = setTimeout(async () => {
      const { terrain } = state.scene;
      if (link.partner() && !link.leads()) return;
      if (!terrain?.enabled || !(state.scene.emitters.length || (link.partner() && linked.emitters.length))) return;
      const needed = neededPatches(state.scene, state.preferences.terrainDraft.cellMetres);
      if (needed.cellMetres === terrain.cellMetres && sameRange(needed.range, terrainRange(terrain))) return;
      const task = terrainCoverageTask.start(GROUND.terrain.loadLimitSeconds * 1000);
      operation('terrain', 'Loading terrain', { share: 0 });
      try {
        const next = await coveredTerrain(terrain, terrain, needed, 'Loading terrain', task);
        if (!task.current()) return;
        const covered = terrainCoverageKey(next) !== terrainCoverageKey(state.scene.terrain);
        terrainCoverageTask.finish(task);
        operation('terrain', null);
        commit(scene => { if (scene.terrain) Object.assign(scene.terrain, next); });
        if (covered && state.preferences.names) loadPlaceNames(state.scene.terrain);
      } catch (error) {
        if (task.current()) setStatus(`The terrain could not be loaded: ${error.message}`, true);
      } finally {
        if (terrainCoverageTask.finish(task)) operation('terrain', null);
      }
    }, GROUND.terrain.coverageDelayMilliseconds);
  }

  async function loadPlaceNames(terrain) {
    if (!terrain || !state.preferences.names) return;
    const task = placeNamesTask.start(GROUND.terrain.placeNamesLimitSeconds * 1000);
    const key = terrainCoverageKey(terrain);
    operation('names', 'Place names', { limitSeconds: GROUND.terrain.placeNamesLimitSeconds });
    try {
      const names = await fetchPlaceNames(terrain, task.signal);
      if (!task.current() || !state.preferences.names || terrainCoverageKey(state.scene.terrain) !== key) return;
      if (names === null) { setStatus('Place names could not be loaded. Switch Names off and on to retry.', true); return; }
      state.scene.terrain.names = names;
      storeScene();
      redrawViews();
    } catch (error) {
      if (task.current()) setStatus(`Place names could not be loaded: ${error.message}`, true);
    } finally {
      if (placeNamesTask.finish(task)) operation('names', null);
    }
  }

  async function loadTerrain(trigger, place = state.scene.place) {
    clearTimeout(terrainCoverageTimer);
    terrainCoverageTask.cancel();
    placeNamesTask.cancel();
    operation('names', null);
    const task = terrainLoadTask.start(GROUND.terrain.loadLimitSeconds * 1000);
    if (trigger) trigger.disabled = true;
    operation('terrain', 'Loading terrain', { share: 0 });
    try {
      const covered = await coveredTerrain(null, place, neededPatches(state.scene, state.preferences.terrainDraft.cellMetres), 'Loading terrain', task);
      if (!task.current()) return;
      const datumMetres = terrainSurface({ ...covered, enabled: true, datumMetres: 0 }).heightAt(0, 0);
      const settings = state.scene.terrain ? Object.fromEntries(Object.keys(TERRAIN_DEFAULTS).map(key => [key, state.scene.terrain[key]])) : TERRAIN_DEFAULTS;
      terrainLoadTask.finish(task);
      operation('terrain', null);
      commit(next => { next.place = place; next.terrain = { ...settings, ...covered, datumMetres }; });
      if (state.preferences.names) loadPlaceNames(state.scene.terrain);
    } catch (error) {
      if (task.current()) setStatus(`The terrain could not be loaded: ${error.message}`, true);
    } finally {
      if (trigger) trigger.disabled = false;
      if (terrainLoadTask.finish(task)) operation('terrain', null);
    }
  }

  async function setPlace(change, trigger) {
    const place = { ...state.scene.place, ...change };
    if (state.scene.terrain) await loadTerrain(trigger, place);
    else { cancelGeographicTasks(); commit(next => { next.place = place; }); }
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
    if (scene.terrain) actions.append(button('Remove', () => { cancelGeographicTasks(); commit(next => { next.terrain = null; }); }));
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
    const needed = neededPatches(state.scene, state.preferences.terrainDraft.cellMetres);
    const bounds = rangeBounds(needed.range, needed.cellMetres);
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
    const task = placeSearchTask.start(GROUND.terrain.placeSearchLimitSeconds * 1000);
    operation('place', `Finding ${text}`, { limitSeconds: GROUND.terrain.placeSearchLimitSeconds });
    try {
      const found = await searchPlace(text, { signal: task.signal });
      if (!task.current()) return null;
      if (!found) setStatus(`No place found for ${text}`, true);
      return found;
    } catch (error) {
      if (task.current()) setStatus(`The place search failed: ${error.message}`, true);
      return null;
    } finally {
      if (placeSearchTask.finish(task)) operation('place', null);
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
  $('place-cancel').addEventListener('click', () => { placeSearchTask.cancel(); operation('place', null); $('place-dialog').close(); });
  $('place-dialog').addEventListener('close', () => { placeSearchTask.cancel(); operation('place', null); });
  $('place-done').addEventListener('click', async () => {
    const text = $('place-query').value.trim();
    if (text && text !== placeShown && !(await showFoundPlace(text))) return;
    const { latitude, longitude } = placeMap.centre();
    $('place-dialog').close();
    await loadTerrain($('place-done'), { name: $('place-query').value.trim(), latitude: +latitude.toFixed(5), longitude: +longitude.toFixed(5) });
  });

  function keepingFocus(root, rebuild) {
    const focused = document.activeElement;
    const fields = () => [...root.querySelectorAll('input, select')];
    const index = root.contains(focused) ? fields().indexOf(focused) : -1;
    rebuild();
    if (index < 0) return;
    const again = fields()[index];
    if (again && again.dataset.key === focused.dataset.key && again.type === focused.type) again.focus({ preventScroll: true });
  }

  /** Waits for a focused number field to blur: replacing it ends its steps, in Safari even with the focus put back. */
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
    liveFields.warnings = null;
    liveFields.summary = null;
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
      if (MODE_SETTINGS[scene.mode].upperWind) ['upperWindMetresPerSecond', 'upperWindFromDegrees'].forEach(airField);
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
    $('cube-attribution').hidden = !scene.terrain && !state.preferences.map;
    $('names').hidden = !scene.terrain;
    $('map').hidden = false;
    syncZoomButtons();
    for (const [id, { hidden }] of Object.entries(tectToggles)) $(id).hidden = hidden(scene);
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
    numberField(output, { key: 'distanceLossPercent', value: scene.render.distanceLossPercent, onCommit: value => commit(next => { next.render.distanceLossPercent = value; }) });
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
      for (const text of emitterWarnings(selected)) selectedInfo.append(element('span', 'warning', text));
      const { metres, direction } = bearing(receiver.positionMetres, emitterAnchor(selected));
      const anchorName = kinds[selected.kind].anchorName(selected);
      selectedInfo.append(element('span', '', metres < 1 ? `${receiver.name} is at its ${anchorName}` : `Its ${anchorName} is ${formatMetres(metres)} ${direction} of ${receiver.name}`));
      for (const line of kinds[selected.kind].info(selected, scene)) selectedInfo.append(element('span', '', line));
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
      kinds[item.kind].measure(item, scene, measure);
    }
    if (Number.isFinite(nearest)) listenInfo.append(element('span', '', `Nearest source ${formatMetres(nearest)}`));
    const result = (state.realResults ?? state.results)?.get(receiver.id);
    if (result?.arrivals.count) {
      let first = Infinity;
      let last = -Infinity;
      for (let index = 0; index < result.arrivals.count; index += 1) {
        first = Math.min(first, result.arrivals.seconds[index]);
        last = Math.max(last, result.arrivals.seconds[index]);
      }
      listenInfo.append(element('span', '', last > first ? `Sound ${formatSeconds(first)}–${formatSeconds(last)} after ${onsetName}` : `Sound ${formatSeconds(first)} after ${onsetName}`));
      listenInfo.append(element('span', '', formatMicrophoneLevels(result)));
      listenInfo.append(element('span', '', `c ${result.speedOfSound.toFixed(1)} m/s`));
      let shadowed = 0;
      let sources = 0;
      for (let index = 0; index < result.arrivals.count; index += 1) {
        if (result.arrivals.kinds[index] === PATH_SHADOW) shadowed += 1;
        if (result.arrivals.kinds[index] === PATH_DIRECT || result.arrivals.kinds[index] === PATH_SHADOW) sources += 1;
      }
      const share = shadowed / sources * 100;
      if (shadowed) listenInfo.append(element('span', '', shadowed === sources ? 'All sources in the refraction shadow' : `${share < 1 ? '<1' : Math.round(share)} % of sources in the refraction shadow`));
      if (result.nonlinearPaths) listenInfo.append(element('span', 'warning', `${result.nonlinearPaths} paths start in the nonlinear zone`));
      if (result.truncated) listenInfo.append(element('span', 'warning', `Sound after ${RENDER.maximumSeconds} s is left out`));
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
    const partner = link.partner() && state.results ? partnerResults() : null;
    const gains = partner ? linkGains(partner) : { own: 1, partner: 1 };
    const laneLabel = (name, gain) => (gain === 1 ? name : `${name} · ${gainText(gain)}`);
    const muting = Boolean(partner?.length && state.ownResults && !linked.updating);
    const muteSpace = muting ? VIEW.plots.mutePixels : 0;
    const lanes = link.partner() && state.results && (partner || linked.updating) ? [
      { label: laneLabel(appName, gains.own), labelIndentPixels: muteSpace, muted: muting && linked.muted === 'own', traces: receivers.map((receiver, index) => ({ id: receiver.id, index, listening: receiver.listen, result: state.ownResults?.get(receiver.id) ?? null })) },
      { label: linked.updating ? `${link.partner()} · rendering…` : laneLabel(link.partner(), gains.partner), labelIndentPixels: muteSpace, muted: muting && linked.muted === 'partner', dimmed: linked.updating, reserveRightPixels: VIEW.plots.unlinkPixels, traces: receivers.map((receiver, index) => ({ id: receiver.id, index, listening: receiver.listen, result: plotted(partner?.find(result => result.receiverId === receiver.id)) })) }
    ] : null;
    drawWaveform($('waveform'), { key: `${key}|${lanes ? `lanes:${linked.mix?.key}:${gains?.own}:${gains?.partner}:${state.ownKey}:${linked.updating}:${muting && linked.muted}` : ''}`, traces, soloId, lanes }, playheadSeconds);
    if (!frame) drawBalance(Boolean(partner));
    if (!frame) placeMutes(muting);
    const byDirection = Boolean(MODE_SETTINGS[state.scene.mode].arrivalsByDirection);
    drawArrivals($('arrivals'), { key: `${key}|${byDirection}`, traces, soloId, byDirection }, playheadSeconds);
    if (!frame) {
      drawPlotTabs(soloId);
      $('arrivals-caption').textContent = byDirection ? 'Arrival · direction' : 'Arrival · height';
      $('arrivals').setAttribute('aria-label', byDirection ? 'Arrival time by direction' : 'Arrival time by source height');
    }
  }

  const BALANCES = Object.freeze({ real: 'Real', balanced: 'Balanced' });

  function drawBalance(shown) {
    let holder = $('plot-balance');
    if (!holder) {
      $('plot-tabs').insertAdjacentHTML('afterend', '<span class="plot-tabs plot-balance" id="plot-balance" role="group" aria-label="Level of the linked sound"></span>');
      holder = $('plot-balance');
    }
    placeUnlink(shown);
    if (!shown) { holder.replaceChildren(); return; }
    holder.replaceChildren(...Object.entries(BALANCES).map(([value, label]) => {
      const choice = button(label, () => {
        if (state.preferences.partner.balance === value) return;
        state.preferences.partner.balance = value;
        savePreferences();
        showResults();
      }, { title: value === 'real' ? `Both tects at their real pressures` : `${link.partner()} at this tect's loudest level` });
      choice.setAttribute('aria-pressed', String(state.preferences.partner.balance === value));
      return choice;
    }));
  }

  /** A cross at the right of the linked tect's half of the pressure plot, after its peak, that unlinks it. */
  function placeUnlink(shown) {
    let cross = $('plot-unlink');
    if (!cross) {
      cross = button('', () => link.unlink());
      cross.id = 'plot-unlink';
      cross.className = 'plot-unlink';
      cross.innerHTML = '<i class="fa-solid fa-xmark" aria-hidden="true"></i>';
      $('waveform').after(cross);
    }
    cross.hidden = !shown;
    if (!shown) return;
    const partner = link.partner();
    cross.title = `Unlink ${partner}`;
    cross.setAttribute('aria-label', cross.title);
    const height = $('waveform').clientHeight;
    const band = (height - VIEW.plots.bottomPixels - VIEW.plots.topPixels) / 2;
    cross.style.top = `${VIEW.plots.topPixels + band}px`;
    cross.style.right = `${VIEW.plots.rightPixels - 4}px`;
  }

  /** An M before each lane's name that takes that tect out of what is played and exported; one lane at a time. */
  function placeMutes(shown) {
    const lanes = { own: appName, partner: link.partner() };
    const band = ($('waveform').clientHeight - VIEW.plots.bottomPixels - VIEW.plots.topPixels) / 2;
    Object.entries(lanes).forEach(([lane, name], position) => {
      let mute = $(`plot-mute-${lane}`);
      if (!mute) {
        mute = button('M', () => {
          linked.muted = linked.muted === lane ? null : lane;
          showResults();
        });
        mute.id = `plot-mute-${lane}`;
        mute.className = 'plot-mute';
        $('waveform').after(mute);
      }
      mute.hidden = !shown;
      if (!shown) return;
      mute.title = `Mute ${name}`;
      mute.setAttribute('aria-label', mute.title);
      mute.setAttribute('aria-pressed', String(linked.muted === lane));
      mute.style.top = `${VIEW.plots.topPixels + band * position}px`;
      mute.style.left = `${VIEW.plots.leftPixels}px`;
    });
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
      const kind = kinds[emitter.kind];
      const timeline = kind.timeline(emitter, state.scene, placedPoint);
      if (realDelay || kind.alwaysTimed(emitter)) {
        strokes.set(emitter.id, timeline
          .map(stroke => ({ ...stroke, elapsed: realDelay ? now - stroke.time : now - stroke.time - arrivalDelay(stroke.from) }))
          .filter(stroke => stroke.elapsed >= 0 && stroke.elapsed < kind.eventSeconds));
      }
    }
    const receiver = placedPoint(focusReceiver().positionMetres);
    const sound = !realDelay && result ? { seconds: now, key: `${receiver.x},${receiver.y},${receiver.z}|${JSON.stringify(state.scene.air)}`, travelSeconds: point => travelSeconds(profile, point, receiver) } : null;
    const receivers = new Map();
    for (const [id, envelopeData] of state.envelopes) {
      receivers.set(id, envelopeData.values[Math.floor((now - envelopeData.startSeconds) / envelopeData.window)] ?? 0);
    }
    const spheres = wavefrontsShown() || (!frontStyle.levelDependent && state.preferences.cone) ? wavefrontSpheres(now, profile) : [];
    const wavefronts = wavefrontsShown() ? { profile, spheres, total: frontStyle.levelDependent ? wavefrontCandidates(state.scene).length : spheres.length, shadowShare: frontStyle.shadowShare } : null;
    const envelopes = state.preferences.cone ? coneOccluders(now, profile, spheres) : new Map();
    const flights = new Map();
    let cones = [];
    for (const emitter of state.scene.emitters) {
      if (!emitter.enabled) continue;
      const paths = kinds[emitter.kind].tracks(emitter, state.scene);
      if (!paths) continue;
      flights.set(emitter.id, paths.flatMap(path => {
        const position = (now - path.seconds[0]) / path.step;
        if (!(position >= 0) || position > path.seconds.length - 1) return [];
        const index = Math.min(path.seconds.length - 2, Math.floor(position));
        const share = position - index;
        const between = values => values[index] + ((values[index + 1] ?? values[index]) - values[index]) * share;
        return [{ x: between(path.x), y: between(path.y), z: between(path.z) }];
      }));
      if (!state.preferences.cone) continue;
      const amplitudes = coneAmplitudes(emitter);
      paths.forEach((path, member) => {
        const cone = kinds[emitter.kind].cone(path, now, profile, emitter, state.scene, member);
        if (!cone) return;
        const { amplitude, frequencyHz } = amplitudes.get(`${emitter.id}:${member}`) ?? { amplitude: 0, frequencyHz: 1000 };
        const strengths = cone.radii.map(radius => frontStyle.strength(amplitude, radius, frequencyHz, state.scene.air));
        const strength = Math.max(...strengths);
        if (strength > 0) cones.push({ ...cone, strengths, strength, occluders: envelopes.get(`${emitter.id}:${member}`) });
      });
    }
    cones = cones.sort((a, b) => b.strength - a.strength).slice(0, VIEW.cone.bodies);
    return { seconds: now, strokes, receivers, sound, wavefronts, flights, cones };
  }

  const coneCache = new WeakMap();

  function coneAmplitudes(emitter) {
    if (!frontStyle.levelDependent) return new Map();
    const key = JSON.stringify([emitter, state.scene.air]);
    const cached = coneCache.get(emitter);
    if (cached?.key === key) return cached.amplitudes;
    const amplitudes = kinds[emitter.kind].amplitudes(emitter, state.scene, currentSurface());
    coneCache.set(emitter, { key, amplitudes });
    return amplitudes;
  }

  function wavefrontsShown() {
    return Boolean(state.preferences.wavefronts?.[state.scene.mode]);
  }

  const wavefrontSources = new WeakMap();

  function wavefrontCandidates(scene) {
    if (wavefrontSources.has(scene)) return wavefrontSources.get(scene);
    const candidates = [];
    const amplitudes = new Map();
    for (const emitter of scene.emitters) {
      if (!emitter.enabled) continue;
      if (frontStyle.levelDependent) for (const [group, amplitude] of kinds[emitter.kind].amplitudes(emitter, scene, currentSurface())) amplitudes.set(group, amplitude);
      const first = candidates.length;
      kinds[emitter.kind].wavefrontSources(emitter, scene, placedPoint, candidates);
      if (kinds[emitter.kind].tracks?.(emitter, scene)) for (let index = first; index < candidates.length; index += 1) candidates[index].moving = true;
    }
    const stride = frontStyle.levelDependent ? Math.max(1, Math.ceil(candidates.length / VIEW.wavefront.spheres)) : 1;
    const sampled = candidates.filter((_, index) => index % stride === 0).map((candidate, order) => ({ ...candidate, order, ...(amplitudes.get(candidate.group) ?? { amplitude: 0, frequencyHz: 1000 }) }));
    sampled.moving = sampled.filter(candidate => candidate.moving);
    sampled.still = sampled.filter(candidate => !candidate.moving);
    wavefrontSources.set(scene, sampled);
    return sampled;
  }

  const placedPoint = point => ({ ...point, z: currentSurface().heightAt(point.x, point.y) + point.z });

  function spheresOf(sources, now, profile) {
    return sources
      .filter(candidate => now > candidate.emitted)
      .map(({ point, emitted, group, order, amplitude, frequencyHz, spacingSeconds = 0, moving = false }) => {
        const front = { moving, ...wavefront(frontProfile(profile, point.z), point, now - emitted) };
        const reach = front.radiusMetres * Math.max(1, spacingSeconds / (now - emitted));
        front.strength = frontStyle.strength(amplitude, reach, frequencyHz, state.scene.air);
        if (!profile.wind) return { source: point, group, order, spacingSeconds, ...front };
        // Drawn only, class C.
        const seconds = now - emitted;
        const drift = axis => (profile.wind[axis] + profile.shear[axis] * point.z) * seconds;
        return { source: point, group, order, spacingSeconds, ...front, centre: { ...front.centre, x: front.centre.x + drift('x'), y: front.centre.y + drift('y') } };
      });
  }

  function wavefrontSpheres(now, profile) {
    const candidates = wavefrontCandidates(state.scene);
    if (frontStyle.levelDependent) return spheresOf(candidates, now, profile);
    return outerSpheres(spheresOf(sampleEnvelopeSources(candidates, now), now, profile)).map((sphere, order) => ({ ...sphere, order }));
  }

  /** The outer fronts of every moving source, sampled the same way in every tect: they bound its Mach cone and hide the cone inside them. */
  function coneOccluders(now, profile, drawn) {
    const spheres = frontStyle.levelDependent ? outerSpheres(spheresOf(sampleEnvelopeSources(wavefrontCandidates(state.scene).moving, now), now, profile)) : drawn;
    const groups = new Map();
    for (const sphere of spheres) {
      if (!groups.has(sphere.group)) groups.set(sphere.group, []);
      groups.get(sphere.group).push(sphere);
    }
    return groups;
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
    $('cube-timeline-time').textContent = `${Math.max(0, seconds).toFixed(2)} s`;
    $('cube-timeline-arrival').style.left = share(firstArrivalSeconds(result));
    $('cube-timeline-progress').style.width = share(seconds);
    const seek = $('cube-timeline-seek');
    seek.max = String(end);
    seek.value = String(Math.max(0, Math.min(end, seconds)));
    seek.setAttribute('aria-valuetext', `${Math.max(0, seconds).toFixed(2)} seconds`);
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
    const start = player.unlock(state.scene.render.sampleRate, { continuing: true });
    let started = false;
    try {
      const [current] = await start.wait(Promise.all([listening(), start.ready]));
      const clock = player.clock();
      if (!start.current() || !player.playing() || !clock) return;
      if (!current) { player.stop(); syncPlayButton(); return; }
      started = await player.play(current.composition, current.playbackGain, {
        start, realDelay: state.preferences.realDelay, onEnded: syncPlayButton, atSceneSeconds: clock.sceneSeconds(), skippedSeconds: clock.skippedSeconds, continuing: true
      });
    } catch (error) {
      if (start.current()) {
        const clock = player.clock();
        if (clock) state.pause = { seconds: clock.sceneSeconds(), skippedSeconds: clock.skippedSeconds };
        player.stop();
        drawStill();
        setStatus(`Playback failed: ${error.message}`, true);
      }
    } finally {
      start.cancel();
      const { again } = resuming;
      resuming = null;
      if (started) showPlaying();
      if (started && again) resumePlayback();
    }
  }

  /** Call it first thing in a user gesture, which the audio context needs. */
  async function startPlayback() {
    const { results } = state;
    const start = player.unlock(state.scene.render.sampleRate);
    setStatus('Starting audio…');
    try {
      let current;
      let scene;
      do {
        scene = state.scene;
        [current] = await start.wait(Promise.all([listening(), start.ready]));
        if (!start.current() || results !== state.results) return;
      } while (scene !== state.scene);
      if (!current) { setStatus('No sound reaches the listening microphones'); return; }
      const from = state.pause;
      const options = { start, realDelay: state.preferences.realDelay, onEnded: syncPlayButton };
      if (from) Object.assign(options, { atSceneSeconds: from.seconds, skippedSeconds: from.skippedSeconds });
      if (await player.play(current.composition, current.playbackGain, options)) {
        state.pause = null;
        setStatus('');
        showPlaying();
      }
    } catch (error) {
      if (start.current()) {
        player.stop();
        setStatus(`Playback failed: ${error.message}`, true);
      }
    } finally {
      start.cancel();
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
    if (player.busy() || player.playing()) {
      state.pause = null;
      player.stop();
      setStatus('');
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

  document.addEventListener('keydown', event => {
    if (event.code !== 'Space' || event.defaultPrevented || event.isComposing || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const target = event.target;
    if (document.querySelector('dialog[open]') || target.isContentEditable || target.closest('input, textarea, select, button, a[href], [role="button"]')) return;
    event.preventDefault();
    if (!event.repeat) $('play').click();
  });

  $('plot-play').addEventListener('click', () => {
    if (player.busy()) { pausePlayback(); player.stop(); setStatus(''); }
    else if (player.playing()) pausePlayback();
    else if (state.results) startPlayback();
  });

  attachTimelineSeek($('cube-timeline-seek'), {
    seek(seconds) {
      if (!state.results) return;
      const skippedSeconds = player.clock()?.skippedSeconds ?? state.pause?.skippedSeconds ?? null;
      player.stop();
      state.pause = { seconds, skippedSeconds };
      syncPlayButton();
      drawStill();
    },
    play() { if (state.pause && state.results) startPlayback(); }
  });

  for (const canvas of [$('waveform'), $('arrivals')]) {
    canvas.addEventListener('pointerdown', event => {
      if (!state.results || event.button !== 0) return;
      const seconds = plotSeconds(canvas, event.clientX);
      if (seconds === null) return;
      const clock = player.clock();
      const skippedSeconds = clock ? clock.skippedSeconds : state.pause?.skippedSeconds ?? null;
      if (player.busy() || player.playing()) { player.stop(); syncPlayButton(); }
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
    download(`${prefix}-scene.json`, new Blob([serializeScene(state.scene)], { type: 'application/json' }));
  });

  $('open').addEventListener('click', () => $('open-file').click());
  $('open-file').addEventListener('change', async () => {
    const file = $('open-file').files[0];
    $('open-file').value = '';
    if (!file) return;
    try {
      const scene = readScene(JSON.parse(await file.text()));
      cancelGeographicTasks();
      state.scene = scene;
      state.selection = { type: 'emitter', id: scene.emitters[0]?.id ?? null };
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

  /** Each tect's sound in its own files at its real level, on one full scale and one time axis per microphone, with one scene file for both. */
  async function separateFiles(choice, dry, gain, selected, stem, describe) {
    const withEchoes = { scene: state.scene, own: state.ownResults, partner: partnerResults() };
    const difference = (a, b) => (a && b ? new Map([...a].map(([id, result]) => [id, b.get(id) ? resultDifference(result, b.get(id)) : result])) : a);
    let parts;
    if (choice === 'with') parts = separateResults(state.scene, withEchoes.own, withEchoes.partner);
    else {
      const wet = separateResults(state.scene, withEchoes.own, withEchoes.partner);
      const dryParts = separateResults(dry.scene, dry.own, dry.partner);
      parts = choice === 'without' ? dryParts : { own: difference(wet.own, dryParts.own), partner: difference(wet.partner, dryParts.partner) };
    }
    const audio = new Set([...selected].filter(item => item !== 'scene'));
    const files = [];
    let timeline = null;
    for (const [name, results] of [[appName, parts.own], [link.partner(), parts.partner]]) {
      const plan = results && exportPlan(state.scene, results, gain);
      if (!plan) continue;
      timeline ??= plan.everyone;
      files.push(...await exportFiles(plan, audio, `${stem}-${fileStem(name)}`, null));
    }
    if (!files.length) throw new Error('Nothing is heard to export.');
    if (selected.has('scene')) {
      const document = describe({ files: files.map(file => ({ file: file.name })), startSeconds: timeline.startSeconds, sampleRate: timeline.sampleRate });
      files.unshift({ name: `${stem}.json`, data: new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`) });
    }
    return files;
  }

  /** The surroundings' rumble stays off too, so that the render with echoes less this one is the echoes alone. */
  async function withoutTerrainEchoes(gain) {
    if (!echoesActive(state.scene)) return { plan: exportPlan(state.scene, state.results, gain), results: state.results, scene: state.scene, own: state.ownResults, partner: partnerResults() };
    const scene = withoutEchoes(state.scene);
    const partnerDry = link.partner() ? link.request('dry', sceneKey(state.scene)) : null;
    const own = scene.emitters.some(emitter => emitter.enabled) ? await renderFull(scene) : null;
    const partner = partnerDry ? await partnerDry : null;
    const gains = linkGains();
    const results = partner ? mixedResults(scene, own, partner, gains.partner, gains.own) : own;
    const plan = results && exportPlan(scene, results, gain);
    if (!plan) throw new Error('Nothing is heard without the terrain echoes.');
    return { plan, results, scene, own, partner };
  }

  const PLACEMENT_LABELS = Object.freeze({ 'listener-and-source': 'Place', source: 'Direction', none: 'Sound only' });
  const echotectPlacement = () => (PLACEMENT_LABELS[state.preferences.echotectPlacement] ? state.preferences.echotectPlacement : 'listener-and-source');

  function placementSelect() {
    const select = document.createElement('select');
    for (const [value, label] of Object.entries(PLACEMENT_LABELS)) select.add(new Option(label, value, false, value === echotectPlacement()));
    return select;
  }

  const microphoneHandoff = (plan, results, microphone, file) => soundHandoff({
    placement: echotectPlacement(),
    scene: plan.scene, receiver: plan.scene.receivers.find(receiver => receiver.id === microphone.receiverId),
    channels: microphone.channels, arrivals: results.get(microphone.receiverId).arrivals, fullScalePa: 1 / plan.gain,
    startSeconds: plan.everyone.startSeconds, file, terrainEchoes: false, appVersion: APP_VERSION, id: crypto.randomUUID(), createdAt: new Date().toISOString()
  });

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
      await fullResults();
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
    $('export-contract').textContent = `${timeline.sampleRate / 1000} kHz · 32-bit float · full scale ${Number((1 / plan.gain).toPrecision(3)).toLocaleString('en')} Pa · from ${formatSeconds(timeline.startSeconds)} after ${onsetName}`;
    $('export-submit').disabled = selected.size === 0;
    $('echotect-summary').textContent = `Mono · ${echoesActive(state.scene) ? 'without terrain echoes · ' : ''}≈ ${formatBytes(sizes.echotect)}`;
  }

  $('export').addEventListener('click', async () => {
    let current;
    {
      try {
        await fullResults();
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
    if (link.partner() && partnerResults()) {
      const row = element('label');
      const select = document.createElement('select');
      select.id = 'export-tects';
      for (const [value, label] of [['together', 'Together'], ['separately', 'Separately']]) select.add(new Option(label, value, false, value === (state.preferences.exportTects ?? 'together')));
      const text = element('span');
      text.append(element('strong', '', 'Tects'));
      row.append(element('span'), text, select);
      options.push(row);
    }
    $('export-options').replaceChildren(...options);
    const echotectOptions = [];
    if (state.scene.receivers.length > 1) {
      const row = element('label');
      const select = document.createElement('select');
      select.id = 'export-echotect-microphone';
      const chosen = state.selection?.type === 'receiver' ? state.selection.id : (state.scene.receivers.find(item => item.listen) ?? state.scene.receivers[0]).id;
      for (const receiver of state.scene.receivers) select.add(new Option(receiver.name, receiver.id, false, receiver.id === chosen));
      const text = element('span');
      text.append(element('strong', '', 'Microphone'));
      row.append(element('span'), text, select);
      echotectOptions.push(row);
    }
    {
      const row = element('label');
      const select = placementSelect();
      select.id = 'export-placement';
      const text = element('span');
      text.append(element('strong', '', 'With'));
      row.append(element('span'), text, select);
      echotectOptions.push(row);
    }
    $('echotect-options').replaceChildren(...echotectOptions);
    $('echotect-error').hidden = true;
    $('export-name').value = state.preferences.exportName ?? `${prefix}-${state.scene.mode}`;
    $('export-error').hidden = true;
    updateExportSummary();
    $('export-dialog').showModal();
    // Focus the dialog itself, so its first control is not ringed when it opens.
    $('export-dialog').focus();
  });

  const echotectMicrophone = () => $('export-echotect-microphone')?.value ?? state.scene.receivers[0].id;

  $('echotect-save').addEventListener('click', async event => {
    const name = $('export-name').value.trim();
    if (!name) { $('export-name').reportValidity(); return; }
    const trigger = event.currentTarget;
    state.preferences.exportName = name;
    state.preferences.echotectPlacement = $('export-placement').value;
    savePreferences();
    trigger.disabled = true;
    $('echotect-error').hidden = true;
    operation('export', 'Exporting');
    try {
      const dry = await withoutTerrainEchoes(exportState.plan.gain);
      const stem = fileStem(name);
      const files = await exportFiles(dry.plan, new Set(['echotect']), stem, null, {
        plan: dry.plan, receiverId: echotectMicrophone(), handoff: (microphone, { file }) => microphoneHandoff(dry.plan, dry.results, microphone, file)
      });
      if (!files.length) throw new Error('The microphone has no sound.');
      const { name: fileName, blob } = exportDownload(files, `${stem}-echotect`);
      download(fileName, blob);
      $('export-dialog').close();
    } catch (error) {
      $('echotect-error').textContent = error instanceof Error ? error.message : String(error);
      $('echotect-error').hidden = false;
    } finally {
      trigger.disabled = false;
      operation('export', null);
    }
  });

  $('export-send').addEventListener('click', () => {
    state.preferences.echotectPlacement = $('export-placement').value;
    savePreferences();
    const receiverId = echotectMicrophone();
    $('export-dialog').close();
    sendToEchotect(receiverId, $('export'));
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
    savePreferences();
    const submit = $('export-submit');
    submit.disabled = true;
    $('export-error').hidden = true;
    operation('export', 'Exporting');
    try {
      const { plan: full, composition } = exportState;
      const stem = fileStem(name);
      const choice = echoes ? echoes.value : 'with';
      const dry = choice !== 'with' ? await withoutTerrainEchoes(full.gain) : null;
      const plan = choice === 'with' ? full : choice === 'without' ? dry.plan : exportPlan(state.scene, new Map(
        [...state.results].map(([id, result]) => [id, resultDifference(result, dry.results.get(id))])
      ), full.gain);
      if (!plan) throw new Error('Nothing is heard in the terrain echoes alone.');
      const together = !($('export-tects')?.value === 'separately' && link.partner() && partnerResults());
      const describe = ({ files: written, startSeconds, sampleRate }) => ({
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
          linkedSound: link.partner() && partnerResults() ? {
            app: link.partner(), tects: together ? 'together' : 'separately', level: together ? state.preferences.partner.balance : 'real',
            ownGainDecibels: together ? +(20 * Math.log10(linkGains().own)).toFixed(1) : 0, linkedGainDecibels: together ? +(20 * Math.log10(linkGains().partner)).toFixed(1) : 0
          } : null,
          speedOfSoundMetresPerSecond: soundSpeedProfile(state.scene.air).groundSpeed,
          soundSpeedGradientPerSecond: soundSpeedProfile(state.scene.air).gradient,
          modelVersion: MODEL_VERSION,
          exportedAt: new Date().toISOString()
        }
      });
      const files = together ? await exportFiles(plan, selected, stem, describe) : await separateFiles(choice, dry, full.gain, selected, stem, describe);
      state.preferences.exportTects = together ? 'together' : 'separately';
      savePreferences();
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

  document.querySelectorAll('.modes [data-mode]').forEach(button => button.addEventListener('click', () => switchMode(button.dataset.mode)));

  function switchMode(mode) {
    if (mode === state.scene.mode) return;
    cancelGeographicTasks();
    const shared = sharedPart(state.scene);
    state.scene = sceneInMode(state.scene, restoredScene(mode));
    if (link.partner()) {
      try { state.scene = parseScene(withShared(state.scene, shared)); } catch {}
    }
    storeScene();
    state.selection = { type: 'emitter', id: state.scene.emitters[0]?.id ?? null };
    state.preferences.mode = mode;
    savePreferences();
    views[0].setView(state.preferences.cubeViews?.[mode] ?? VIEW.box.defaultView);
    invalidateResults();
    refreshPanel();
    scheduleTerrainCoverage();
    if (state.preferences.autoRender) startRender();
  }

  const TOGGLES = Object.freeze({
    'auto-render': {
      read: () => state.preferences.autoRender,
      write: on => { state.preferences.autoRender = on; },
      after: () => {
        if (state.preferences.autoRender) adoptHeld();
        if (state.preferences.autoRender && !state.results && !operations.has('render')) startRender();
      }
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
    ...Object.fromEntries(Object.keys(tectToggles).map(id => [id, { read: () => state.preferences[id], write: on => { state.preferences[id] = on; }, after: () => redrawViews() }])),
    names: {
      read: () => state.preferences.names,
      write: on => { state.preferences.names = on; },
      after: () => {
        if (!state.preferences.names) { placeNamesTask.cancel(); operation('names', null); }
        if (state.preferences.names && state.scene.terrain && !state.scene.terrain.names.length) loadPlaceNames(state.scene.terrain);
        redrawViews();
      }
    },
    map: {
      read: () => state.preferences.map,
      write: on => { state.preferences.map = on; },
      after: () => {
        if (!state.preferences.map) mapLayer.clear();
        $('cube-attribution').hidden = !state.scene.terrain && !state.preferences.map;
        syncZoomButtons(); redrawViews();
      }
    }
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

  const ZOOM_STEP = 1.5;
  function syncZoomButtons() {
    const shown = Boolean(state.preferences.map);
    $('zoom-in').hidden = !shown;
    $('zoom-out').hidden = !shown;
  }
  $('zoom-in').addEventListener('click', () => views[0].zoomBy(ZOOM_STEP));
  $('zoom-out').addEventListener('click', () => views[0].zoomBy(1 / ZOOM_STEP));
  syncZoomButtons();
  $('attribution-button').addEventListener('click', () => {
    const open = $('attribution-text').hidden;
    $('attribution-text').hidden = !open;
    $('attribution-button').setAttribute('aria-expanded', String(open));
  });
  for (const [idPrefix, { create, label }] of Object.entries(ADD_EMITTERS)) {
    $(`add-${idPrefix}`).addEventListener('click', () => addEmitter(scene => create(uniqueId(idPrefix, scene.emitters), `${label} ${scene.emitters.length + 1}`, newSeed())));
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

  window.addEventListener('pagehide', () => renderMarker.suspend());
  window.addEventListener('pageshow', event => { if (event.persisted && operations.has('render')) renderMarker.restore(); });

  refreshPanel();
  // Not rendered again by itself: that would stop the page again.
  if (unfinishedRender) {
    setStatus(unfinishedRenderText(unfinishedRender), true);
    syncPlayButton();
  } else if (state.preferences.autoRender) startRender();
  else syncPlayButton();
}
