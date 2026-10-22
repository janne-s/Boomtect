import Omnitone from '../vendor/omnitone/omnitone.min.esm.js';
import { channelCount, orientationRotation, rotationTerms } from '../domain/ambisonics.js';
import { RENDER } from '../domain/constants.js';

function silentLoop() {
  const rate = 8000;
  const samples = rate / 2;
  const bytes = new Uint8Array(44 + samples);
  const view = new DataView(bytes.buffer);
  const text = (at, value) => [...value].forEach((char, index) => { bytes[at + index] = char.charCodeAt(0); });
  text(0, 'RIFF'); view.setUint32(4, 36 + samples, true); text(8, 'WAVEfmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, rate, true); view.setUint32(28, rate, true); view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  text(36, 'data'); view.setUint32(40, samples, true);
  bytes.fill(128, 44);
  const audio = new Audio(`data:audio/wav;base64,${btoa(String.fromCharCode(...bytes))}`);
  audio.loop = true;
  audio.setAttribute('playsinline', '');
  return audio;
}

/** Omnitone's higher-order decoder mirrors left and right against AmbiX, so its m < 0 components flip sign after the rotation. */
function omnitoneSign(acn, order) {
  if (order < 2) return 1;
  const degree = Math.floor(Math.sqrt(acn));
  return acn - degree * degree - degree < 0 ? -1 : 1;
}

function rotationNetwork(context, order) {
  const count = channelCount(order);
  const splitter = context.createChannelSplitter(count);
  const merger = context.createChannelMerger(count);
  const gains = new Map();
  for (const { from, to } of rotationTerms(order)) {
    const node = context.createGain();
    node.gain.value = 0;
    splitter.connect(node, from);
    node.connect(merger, 0, to);
    gains.set(`${from}:${to}`, node);
  }
  return {
    input: splitter,
    output: merger,
    setOrientation(headingDegrees, pitchDegrees) {
      for (const node of gains.values()) node.gain.value = 0;
      for (const { from, to, gain } of orientationRotation(headingDegrees, pitchDegrees, order)) {
        gains.get(`${from}:${to}`).gain.value = gain * omnitoneSign(to, order);
      }
    }
  };
}

const binauralRenderers = new WeakMap();

/** Shared by playbacks, so each fades its heads before the decoder, never after. */
async function binauralRenderer(context, order) {
  let renderers = binauralRenderers.get(context);
  if (!renderers) binauralRenderers.set(context, renderers = new Map());
  if (!renderers.has(order)) {
    const renderer = order === 1 ? Omnitone.createFOARenderer(context) : Omnitone.createHOARenderer(context, { ambisonicOrder: order });
    renderers.set(order, renderer.initialize().then(() => {
      renderer.output.connect(context.destination);
      return renderer;
    }));
  }
  return renderers.get(order);
}

function bufferSource(context, channels, gain, sampleRate) {
  const buffer = context.createBuffer(channels.length, channels[0].length, sampleRate);
  channels.forEach((samples, index) => {
    const data = buffer.getChannelData(index);
    for (let frame = 0; frame < data.length; frame += 1) data[frame] = samples[frame] * gain;
  });
  const source = context.createBufferSource();
  source.buffer = buffer;
  return source;
}

async function connectComposition(context, composition, gain, destination, { live, input = destination, fieldInput = null, signal = null }) {
  const { kind, sampleRate, order } = composition;
  const sources = [];
  const rotations = new Map();
  const nodes = [];
  if (kind === 'binaural' || kind === 'mix') {
    const renderer = await binauralRenderer(context, order);
    signal?.throwIfAborted();
    if (fieldInput) fieldInput.connect(renderer.input);
    for (const head of composition.heads) {
      const source = bufferSource(context, head.channels, gain, sampleRate);
      const rotation = rotationNetwork(context, order);
      rotation.setOrientation(head.headingDegrees, head.pitchDegrees);
      source.connect(rotation.input);
      rotation.output.connect(fieldInput ?? renderer.input);
      rotations.set(head.receiverId, rotation);
      sources.push(source);
      nodes.push(rotation.output);
    }
    for (const omni of composition.omnis) {
      const source = bufferSource(context, [omni.channel], gain, sampleRate);
      source.connect(input);
      sources.push(source);
    }
    return { sources, rotations, nodes };
  }
  const channels = composition.omnis.map(omni => omni.channel);
  const source = bufferSource(context, channels, gain, sampleRate);
  sources.push(source);
  if (kind === 'surround' && !(live && destination.maxChannelCount >= channels.length)) {
    const splitter = context.createChannelSplitter(channels.length);
    source.connect(splitter);
    composition.omnis.forEach((omni, index) => {
      const panner = context.createStereoPanner();
      panner.pan.value = Math.sin(omni.bearing);
      splitter.connect(panner, index);
      panner.connect(input);
      nodes.push(panner);
    });
    return { sources, rotations, nodes };
  }
  if (live) {
    destination.channelCount = Math.min(destination.maxChannelCount, Math.max(2, channels.length));
    destination.channelInterpretation = kind === 'surround' ? 'discrete' : 'speakers';
  }
  source.connect(input);
  return { sources, rotations, nodes };
}

export async function renderComposition(composition, gain) {
  const context = new OfflineAudioContext(2, composition.length, composition.sampleRate);
  const { sources } = await connectComposition(context, composition, gain, context.destination, { live: false });
  sources.forEach(source => source.start(0));
  const rendered = await context.startRendering();
  return [0, 1].map(index => new Float32Array(rendered.getChannelData(index)));
}

function waitForAudio(promise, signal, timeoutSeconds = null) {
  return new Promise((resolve, reject) => {
    let remaining = timeoutSeconds === null ? null : timeoutSeconds * 1000;
    let since = null;
    let timer = null;
    const finish = (settle, value) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      document.removeEventListener('visibilitychange', visibility);
      settle(value);
    };
    const abort = () => finish(reject, signal.reason);
    const visibility = () => {
      clearTimeout(timer);
      if (since !== null) remaining -= performance.now() - since;
      since = null;
      if (remaining !== null && document.visibilityState === 'visible') {
        since = performance.now();
        timer = setTimeout(() => finish(reject, new Error('Audio did not start. Press Play to retry.')), Math.max(0, remaining));
      }
    };
    Promise.resolve(promise).then(value => finish(resolve, value), error => finish(reject, error));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    if (remaining !== null) {
      document.addEventListener('visibilitychange', visibility);
      visibility();
    }
  });
}

export function createPlayer({ onChange = () => {}, onInterrupted = () => {} } = {}) {
  let context = null;
  let current = null;
  let clock = null;
  let pending = null;
  let silence = null;
  let detachContext = null;

  function disconnect({ sources, nodes, faders }) {
    sources.forEach(source => source.disconnect());
    nodes.forEach(node => node.disconnect());
    faders.forEach(fader => fader.disconnect());
  }

  function release(at = context?.currentTime) {
    if (current) {
      const playback = current;
      const playingContext = playback.context;
      for (const fader of playback.faders) {
        fader.gain.cancelScheduledValues(at);
        fader.gain.setValueAtTime(1, at);
        fader.gain.linearRampToValueAtTime(0, at + RENDER.fadeSeconds);
      }
      for (const source of playback.sources) {
        source.onended = null;
        try { source.stop(at + RENDER.fadeSeconds); } catch {}
      }
      setTimeout(() => disconnect(playback), Math.max(0, at - playingContext.currentTime + RENDER.fadeSeconds * 2) * 1000);
    }
    current = null;
    clock = null;
  }

  function stop() {
    const abandoned = pending;
    pending = null;
    abandoned?.abort();
    release();
    silence?.pause();
    const retired = context;
    detachContext?.();
    detachContext = null;
    context = null;
    if (retired) setTimeout(() => retired.close().catch(() => {}), RENDER.fadeSeconds * 2000 + 50);
    onChange();
  }

  function interrupt(message = 'Audio interrupted') {
    if (!current) return;
    const position = { seconds: clock.sceneSeconds(), skippedSeconds: clock.skippedSeconds };
    stop();
    onInterrupted(position, message);
  }

  function observeContext(ownedContext) {
    const changed = () => {
      if (context === ownedContext && ownedContext.state !== 'running') interrupt();
    };
    ownedContext.addEventListener('statechange', changed);
    detachContext = () => ownedContext.removeEventListener('statechange', changed);
  }

  const wake = () => {
    if (document.visibilityState === 'visible' && current && context?.state !== 'running') interrupt();
  };
  const sessionChanged = () => { if (navigator.audioSession?.state === 'interrupted') interrupt(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  navigator.audioSession?.addEventListener('statechange', sessionChanged);

  /** Keep session activation and resume synchronous with the Play gesture. */
  function unlock(sampleRate, { continuing = false } = {}) {
    if (!continuing) stop();
    pending?.abort();
    const controller = new AbortController();
    const attempt = {
      abort: () => controller.abort(),
      current: () => pending === attempt && !controller.signal.aborted,
      wait: (promise, timeoutSeconds = null) => waitForAudio(promise, controller.signal, timeoutSeconds),
      cancel: () => { if (attempt.current()) stop(); },
      signal: controller.signal,
      context: null,
      ready: null
    };
    pending = attempt;
    try {
      let sessionReady;
      if (!continuing) {
        if (navigator.audioSession) navigator.audioSession.type = 'playback';
        else {
          silence ??= silentLoop();
          sessionReady = silence.play();
        }
        // Recreate on explicit starts: Safari can report running while its output is silent after sleep.
        context = new AudioContext({ sampleRate });
        observeContext(context);
      }
      attempt.context = context;
      const resumed = context.resume();
      attempt.ready = waitForAudio(Promise.all([resumed, sessionReady]), controller.signal, RENDER.audioResumeSeconds);
    } catch (error) {
      attempt.ready = Promise.reject(error);
    }
    attempt.ready.catch(() => {});
    onChange();
    return attempt;
  }

  async function play(composition, gain, { start, realDelay, onEnded, atSceneSeconds = null, skippedSeconds = null, continuing = false }) {
    await start.ready;
    if (!start.current()) return false;
    const ownedContext = start.context;
    if (ownedContext !== context || ownedContext.state !== 'running') throw new Error('Audio is interrupted. Press Play to retry.');
    const fader = ownedContext.createGain();
    fader.connect(ownedContext.destination);
    const fieldFader = ownedContext.createGain();
    fieldFader.channelCount = channelCount(composition.order || 1);
    fieldFader.channelCountMode = 'explicit';
    fieldFader.channelInterpretation = 'discrete';
    let connected;
    try {
      const connecting = connectComposition(ownedContext, composition, gain, ownedContext.destination, { live: true, input: fader, fieldInput: fieldFader, signal: start.signal }).then(graph => {
        const playback = { ...graph, context: ownedContext, faders: [fader, fieldFader] };
        if (!start.current()) disconnect(playback);
        return playback;
      });
      connected = await start.wait(connecting, RENDER.audioResumeSeconds);
    } catch (error) {
      fader.disconnect();
      fieldFader.disconnect();
      throw error;
    }
    if (!start.current()) { disconnect(connected); return false; }
    const at = ownedContext.currentTime + RENDER.scheduleLeadSeconds;
    const previous = continuing ? clock : null;
    // Shortened playback begins with the first wavefront; sound can arrive before the scene's zero (a long grain straddles a source's start).
    const early = composition.firstSoundSeconds < 0;
    const leadIn = early ? composition.firstSoundSeconds : Math.max(0, composition.firstSoundSeconds);
    const skipped = previous?.skippedSeconds ?? skippedSeconds ?? (realDelay ? 0 : leadIn);
    const origin = previous?.origin ?? at - (atSceneSeconds ?? (realDelay && early ? leadIn : skipped));
    release(at);
    current = connected;
    for (const node of connected.faders) {
      node.gain.setValueAtTime(0, at);
      node.gain.linearRampToValueAtTime(1, at + RENDER.fadeSeconds);
    }
    const when = origin + composition.startSeconds;
    for (const source of connected.sources) {
      if (when >= at) source.start(when); else source.start(at, at - when);
    }
    connected.sources[0].onended = () => {
      if (current !== connected) return;
      stop();
      onEnded?.();
    };
    clock = { skippedSeconds: skipped, origin, sceneSeconds: () => ownedContext.currentTime - origin };
    pending = null;
    start.abort();
    onChange();
    return true;
  }

  return {
    unlock,
    play,
    stop,
    busy: () => pending !== null,
    dispose() {
      stop();
      document.removeEventListener('visibilitychange', wake);
      window.removeEventListener('pageshow', wake);
      navigator.audioSession?.removeEventListener('statechange', sessionChanged);
    },
    clock: () => clock,
    playing: () => current !== null,
    setOrientation(receiverId, headingDegrees, pitchDegrees) { current?.rotations.get(receiverId)?.setOrientation(headingDegrees, pitchDegrees); }
  };
}
