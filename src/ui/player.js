import Omnitone from '../../assets/vendor/omnitone/omnitone.min.esm.js';
import { channelCount, orientationRotation, rotationTerms } from '../domain/ambisonics.js';

/** Seconds between pressing Play and the start of the timeline, so scheduling never lands in the past. */
const SCHEDULE_LEAD_SECONDS = .08;
/** Without the real delay, the first sound starts this long after playback begins. */
const SHORTENED_LEAD_SECONDS = .5;

/**
 * Omnitone's higher-order decoder mirrors left and right relative to AmbiX: measured with a source
 * in the east and the listener facing north, it puts the source on the left. Its sine components
 * (m < 0) therefore enter with the opposite sign, after the orientation rotation, because a mirror
 * and a rotation do not commute. The first-order decoder follows AmbiX.
 */
function omnitoneSign(acn, order) {
  if (order < 2) return 1;
  const degree = Math.floor(Math.sqrt(acn));
  return acn - degree * degree - degree < 0 ? -1 : 1;
}

/**
 * A listener's orientation as a rotation of the ambisonic field: a channel splitter, one gain per
 * possible term, and a channel merger. Changing the orientation only changes the gains.
 */
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

/** An initialized Omnitone decoder for an order, created once per audio context. */
async function binauralRenderer(context, order) {
  let renderers = binauralRenderers.get(context);
  if (!renderers) binauralRenderers.set(context, renderers = new Map());
  if (!renderers.has(order)) {
    const renderer = order === 1 ? Omnitone.createFOARenderer(context) : Omnitone.createHOARenderer(context, { ambisonicOrder: order });
    renderers.set(order, renderer.initialize().then(() => renderer));
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

/**
 * Connects a listening composition to a destination. Surround plays one channel per speaker when
 * the output has enough channels, and otherwise as a stereo preview panned by each microphone's
 * bearing from their centre. Returns the sources and the orientation controls per head.
 */
async function connectComposition(context, composition, gain, destination, { live }) {
  const { kind, sampleRate, order } = composition;
  const sources = [];
  const rotations = new Map();
  const nodes = [];
  if (kind === 'binaural' || kind === 'mix') {
    const renderer = await binauralRenderer(context, order);
    for (const head of composition.heads) {
      const source = bufferSource(context, head.channels, gain, sampleRate);
      const rotation = rotationNetwork(context, order);
      rotation.setOrientation(head.headingDegrees, head.pitchDegrees);
      source.connect(rotation.input);
      rotation.output.connect(renderer.input);
      rotations.set(head.receiverId, rotation);
      sources.push(source);
      nodes.push(rotation.output);
    }
    renderer.output.connect(destination);
    nodes.push(renderer.output);
    for (const omni of composition.omnis) {
      const source = bufferSource(context, [omni.channel], gain, sampleRate);
      source.connect(destination);
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
      panner.connect(destination);
      nodes.push(panner);
    });
    return { sources, rotations, nodes };
  }
  if (live) {
    destination.channelCount = Math.min(destination.maxChannelCount, Math.max(2, channels.length));
    destination.channelInterpretation = kind === 'surround' ? 'discrete' : 'speakers';
  }
  source.connect(destination);
  return { sources, rotations, nodes };
}

/** Renders a binaural or mixed composition offline into stereo, as playback would sound. */
export async function renderComposition(composition, gain) {
  const context = new OfflineAudioContext(2, composition.length, composition.sampleRate);
  const { sources } = await connectComposition(context, composition, gain, context.destination, { live: false });
  sources.forEach(source => source.start(0));
  const rendered = await context.startRendering();
  return [0, 1].map(index => new Float32Array(rendered.getChannelData(index)));
}

/**
 * Web Audio playback of a composition on the scene timeline (seconds since the emission origin).
 * With the real delay the timeline starts at zero; without it, the silent lead-in before the first
 * sound is skipped. The audio context is created on the first Play so it starts from a user
 * gesture.
 */
export function createPlayer() {
  let context = null;
  let current = null;
  let clock = null;

  function stop() {
    if (current) {
      for (const source of current.sources) {
        source.onended = null;
        try { source.stop(); } catch { /* Already stopped. */ }
        source.disconnect();
      }
      current.nodes.forEach(node => node.disconnect());
    }
    current = null;
    clock = null;
  }

  async function play(composition, gain, { realDelay, onEnded }) {
    context ??= new AudioContext({ sampleRate: composition.sampleRate });
    await context.resume();
    stop();
    const connected = await connectComposition(context, composition, gain, context.destination, { live: true });
    current = connected;
    const skipped = realDelay ? 0 : Math.max(0, composition.startSeconds - SHORTENED_LEAD_SECONDS);
    const origin = context.currentTime + SCHEDULE_LEAD_SECONDS - skipped;
    const when = origin + composition.startSeconds;
    const now = context.currentTime;
    for (const source of connected.sources) {
      if (when >= now) source.start(when); else source.start(now, now - when);
    }
    connected.sources[0].onended = () => {
      if (current !== connected) return;
      stop();
      onEnded?.();
    };
    clock = { skippedSeconds: skipped, sceneSeconds: () => context.currentTime - origin };
  }

  return {
    play,
    stop,
    clock: () => clock,
    playing: () => current !== null,
    setOrientation(receiverId, headingDegrees, pitchDegrees) { current?.rotations.get(receiverId)?.setOrientation(headingDegrees, pitchDegrees); }
  };
}
