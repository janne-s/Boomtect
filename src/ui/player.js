import Omnitone from '../../assets/vendor/omnitone/omnitone.min.esm.js';
import { channelCount, orientationRotation, rotationTerms } from '../domain/ambisonics.js';
import { RENDER } from '../domain/constants.js';

/** iOS mutes Web Audio with the silent switch unless the session is playback (Safari 16.4+); older iOS needs a looping silent audio element. */
const AUDIO_SESSION = typeof navigator !== 'undefined' && 'audioSession' in navigator;
let silence = null;

function declarePlayback() {
  if (AUDIO_SESSION) {
    try { navigator.audioSession.type = 'playback'; } catch {}
    return;
  }
  silence ??= silentLoop();
  silence.play().catch(() => {});
}

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

async function connectComposition(context, composition, gain, destination, { live, input = destination, fieldInput = null }) {
  const { kind, sampleRate, order } = composition;
  const sources = [];
  const rotations = new Map();
  const nodes = [];
  if (kind === 'binaural' || kind === 'mix') {
    const renderer = await binauralRenderer(context, order);
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

export function createPlayer() {
  let context = null;
  let current = null;
  let clock = null;
  let request = 0;

  function disconnect({ sources, nodes, faders }) {
    sources.forEach(source => source.disconnect());
    nodes.forEach(node => node.disconnect());
    faders.forEach(fader => fader.disconnect());
  }

  function release(at = context?.currentTime) {
    if (current) {
      const playback = current;
      for (const fader of playback.faders) {
        fader.gain.cancelScheduledValues(at);
        fader.gain.setValueAtTime(1, at);
        fader.gain.linearRampToValueAtTime(0, at + RENDER.fadeSeconds);
      }
      for (const source of playback.sources) {
        source.onended = null;
        try { source.stop(at + RENDER.fadeSeconds); } catch {}
      }
      setTimeout(() => disconnect(playback), (at - context.currentTime + RENDER.fadeSeconds * 2) * 1000);
    }
    current = null;
    clock = null;
  }

  function stop() {
    request += 1;
    release();
    silence?.pause();
  }

  /** Call it first thing in a user gesture: audio may start only shortly after one. */
  function unlock(sampleRate) {
    declarePlayback();
    context ??= new AudioContext({ sampleRate });
    return context.resume();
  }

  // iOS suspends the context during a call or in the background ("interrupted") and does not resume it by itself.
  const wake = () => {
    if (document.visibilityState === 'visible' && current && context && context.state !== 'running') context.resume().catch(() => {});
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);

  async function play(composition, gain, { realDelay, onEnded, atSceneSeconds = null, skippedSeconds = null, continuing = false }) {
    const ticket = request += 1;
    await unlock(composition.sampleRate);
    if (!continuing) release();
    const fader = context.createGain();
    fader.connect(context.destination);
    const fieldFader = context.createGain();
    fieldFader.channelCount = channelCount(composition.order || 1);
    fieldFader.channelCountMode = 'explicit';
    fieldFader.channelInterpretation = 'discrete';
    const connected = { ...await connectComposition(context, composition, gain, context.destination, { live: true, input: fader, fieldInput: fieldFader }), faders: [fader, fieldFader] };
    if (ticket !== request) {
      disconnect(connected);
      return false;
    }
    const at = context.currentTime + RENDER.scheduleLeadSeconds;
    const previous = continuing ? clock : null;
    const skipped = previous?.skippedSeconds ?? skippedSeconds ?? (realDelay ? 0 : Math.max(0, composition.firstSoundSeconds - RENDER.shortenedLeadSeconds));
    const origin = previous?.origin ?? at - (atSceneSeconds ?? skipped);
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
    clock = { skippedSeconds: skipped, origin, sceneSeconds: () => context.currentTime - origin };
    return true;
  }

  return {
    unlock,
    play,
    stop,
    clock: () => clock,
    playing: () => current !== null,
    setOrientation(receiverId, headingDegrees, pitchDegrees) { current?.rotations.get(receiverId)?.setOrientation(headingDegrees, pitchDegrees); }
  };
}
