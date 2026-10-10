/** How AmbiX files are laid out, as written into the scene document. */
export const AMBISONIC_CONVENTION = 'AmbiX (ACN, SN3D); front = north, left = west, up = up';
import { wavByteLength, encodeFloat32Wav } from '../domain/wav.js';
import { zipStore } from '../domain/zip.js';
import { composeListening } from './listening.js';
import { renderComposition } from './player.js';

/**
 * The export package, after Echotect's: a chosen set of files, one as it is or several in a ZIP.
 * - scene: the parameter document with what was exported and how;
 * - stereo: what plays, rendered offline into two channels as playback sounds;
 * - microphones: one file per microphone, an omni's pressure in mono and a binaural one's head in
 *   stereo;
 * - ambix: one AmbiX file per microphone, when the render is spatial.
 * Every file shares one full scale, the playback gain, so their levels compare; with per-microphone
 * files all start at one time, so they line up.
 */
export const EXPORT_ITEMS = Object.freeze(['scene', 'stereo', 'microphones', 'ambix']);

const slug = text => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'boomtect';
export const fileStem = slug;

/**
 * What can be exported for the scene's results: the listening composition, and every microphone on
 * one timeline as a head of the sound field (its omni channel first). Null without results.
 */
export function exportPlan(scene, results, gain) {
  const listening = composeListening(scene, results);
  if (!listening) return null;
  const everyone = composeListening({ ...scene, receivers: scene.receivers.map(receiver => ({ ...receiver, type: 'binaural', listen: true })) }, results);
  if (!everyone) return null;
  const types = new Map(scene.receivers.map(receiver => [receiver.id, receiver.type]));
  const order = scene.render.ambisonicOrder;
  // Every microphone in the scene's order with its channels on the shared timeline: the whole field
  // when the render is spatial, otherwise its pressure alone.
  const fields = new Map([...everyone.heads.map(head => [head.receiverId, head]), ...everyone.omnis.map(omni => [omni.receiverId, { ...omni, channels: [omni.channel] }])]);
  const microphones = scene.receivers.map(receiver => fields.get(receiver.id)).filter(Boolean);
  return { scene, listening, everyone, microphones, types, gain, order };
}

/** Which items the plan can give, and their sizes in bytes for a selection (their timeline depends on it). */
export function exportSizes(plan, selected) {
  const aligned = selected.has('microphones') || selected.has('ambix');
  const length = aligned ? plan.everyone.length : plan.listening.length;
  return {
    scene: 4096,
    stereo: wavByteLength(length, 2),
    microphones: plan.microphones.reduce((sum, microphone) => sum + wavByteLength(plan.everyone.length, isHead(plan, microphone) ? 2 : 1), 0),
    ambix: plan.order > 0 ? plan.microphones.reduce((sum, microphone) => sum + wavByteLength(plan.everyone.length, microphone.channels.length), 0) : 0
  };
}

/** A binaural microphone whose head the spatial render can decode. */
const isHead = (plan, microphone) => plan.order > 0 && plan.types.get(microphone.receiverId) === 'binaural';

export const availableItems = plan => EXPORT_ITEMS.filter(item => item !== 'ambix' || plan.order > 0);

/** Channels placed at a sample offset in a longer silence. */
function placed(channels, offset, length) {
  return channels.map(channel => {
    const out = new Float32Array(length);
    out.set(channel.subarray(0, Math.max(0, Math.min(channel.length, length - offset))), Math.max(0, offset));
    return out;
  });
}

/**
 * The files of a selection: [{ name, data }]. `describe` gets the export block for the scene document
 * once the audio files are known.
 */
export async function exportFiles(plan, selected, stem, describe) {
  const { listening, everyone, microphones, gain, order } = plan;
  const aligned = selected.has('microphones') || selected.has('ambix');
  const timeline = aligned ? everyone : listening;
  const files = [];
  const manifest = [];
  const add = (suffix, channels, description) => {
    const name = `${stem}${suffix}.wav`;
    files.push({ name, data: new Uint8Array(encodeFloat32Wav(channels, timeline.sampleRate)) });
    manifest.push({ file: name, channels: channels.length, description });
  };
  const scaled = channel => channel.map(value => value * gain);
  if (selected.has('stereo')) {
    const stereo = await renderComposition(listening, gain);
    const offset = Math.round((listening.startSeconds - timeline.startSeconds) * timeline.sampleRate);
    add('-stereo', aligned ? placed(stereo, offset, timeline.length) : stereo, `Stereo: ${listening.label}`);
  }
  if (selected.has('microphones')) {
    for (const microphone of microphones) {
      if (isHead(plan, microphone)) {
        const single = { ...everyone, kind: 'binaural', heads: [microphone], omnis: [], parts: 1 };
        add(`-${slug(microphone.name)}`, await renderComposition(single, gain), `${microphone.name}: binaural, left and right`);
      } else {
        add(`-${slug(microphone.name)}`, [scaled(microphone.channels[0])], `${microphone.name}: pressure`);
      }
    }
  }
  if (selected.has('ambix') && order > 0) {
    for (const microphone of microphones) add(`-${slug(microphone.name)}-ambix`, microphone.channels.map(scaled), `${microphone.name}: ${AMBISONIC_CONVENTION}, order ${order}`);
  }
  if (selected.has('scene')) {
    const document = describe({ files: manifest, startSeconds: timeline.startSeconds, sampleRate: timeline.sampleRate });
    files.unshift({ name: `${stem}.json`, data: new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`) });
  }
  return files;
}

/** One file as it is, several in a stored ZIP: { name, blob }. */
export function exportDownload(files, stem) {
  if (files.length === 1) {
    const [file] = files;
    return { name: file.name, blob: new Blob([file.data], { type: file.name.endsWith('.json') ? 'application/json' : 'audio/wav' }) };
  }
  return { name: `${stem}.zip`, blob: new Blob([zipStore(files)], { type: 'application/zip' }) };
}
