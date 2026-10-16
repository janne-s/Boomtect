export const AMBISONIC_CONVENTION = 'AmbiX (ACN, SN3D); front = north, left = west, up = up';
import { wavByteLength, encodeFloat32Wav } from '../shared/domain/wav.js';
import { serializeHandoff } from '../shared/domain/handoff.js';
import { zipStore } from '../shared/domain/zip.js';
import { composeListening } from './listening.js';
import { renderComposition } from './player.js';

const EXPORT_ITEMS = Object.freeze(['scene', 'stereo', 'microphones', 'ambix']);
const HANDOFF_BYTES = 2048;

const slug = text => text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'boomtect';
export const fileStem = slug;

export function exportPlan(scene, results, gain) {
  const listening = composeListening(scene, results);
  if (!listening) return null;
  const everyone = composeListening({ ...scene, receivers: scene.receivers.map(receiver => ({ ...receiver, type: 'binaural', listen: true })) }, results);
  if (!everyone) return null;
  const types = new Map(scene.receivers.map(receiver => [receiver.id, receiver.type]));
  const order = scene.render.ambisonicOrder;
  const fields = new Map([...everyone.heads.map(head => [head.receiverId, head]), ...everyone.omnis.map(omni => [omni.receiverId, { ...omni, channels: [omni.channel] }])]);
  const microphones = scene.receivers.map(receiver => fields.get(receiver.id)).filter(Boolean);
  return { scene, listening, everyone, microphones, types, gain, order };
}

export const itemFiles = (plan, item) => (item === 'microphones' || item === 'ambix' ? plan.microphones.length : item === 'echotect' ? 2 : 1);

export function exportSizes(plan, selected, { echoFree = 1, withoutEchoes = false } = {}) {
  const aligned = selected.has('microphones') || selected.has('ambix');
  const share = withoutEchoes ? echoFree : 1;
  const everyone = Math.ceil(plan.everyone.length * share);
  const length = Math.ceil((aligned ? plan.everyone.length : plan.listening.length) * share);
  return {
    scene: 4096,
    stereo: wavByteLength(length, 2),
    microphones: plan.microphones.reduce((sum, microphone) => sum + wavByteLength(everyone, isHead(plan, microphone) ? 2 : 1), 0),
    ambix: plan.order > 0 ? plan.microphones.reduce((sum, microphone) => sum + wavByteLength(everyone, microphone.channels.length), 0) : 0,
    echotect: wavByteLength(Math.ceil(plan.everyone.length * echoFree), 1) + HANDOFF_BYTES
  };
}

const isHead = (plan, microphone) => plan.order > 0 && plan.types.get(microphone.receiverId) === 'binaural';

export const availableItems = plan => EXPORT_ITEMS.filter(item => item !== 'ambix' || plan.order > 0);

function placed(channels, offset, length) {
  return channels.map(channel => {
    const out = new Float32Array(length);
    out.set(channel.subarray(0, Math.max(0, Math.min(channel.length, length - offset))), Math.max(0, offset));
    return out;
  });
}

export async function exportFiles(plan, selected, stem, describe, echotect) {
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
  if (selected.has('echotect')) {
    const { everyone } = echotect.plan;
    for (const microphone of echotect.plan.microphones.filter(item => item.receiverId === echotect.receiverId)) {
      const name = `${stem}-${slug(microphone.name)}-echotect`;
      files.push({ name: `${name}.wav`, data: new Uint8Array(encodeFloat32Wav([scaled(microphone.channels[0])], everyone.sampleRate)) });
      const handoff = echotect.handoff(microphone, { file: `${name}.wav` });
      files.push({ name: `${name}.json`, data: new TextEncoder().encode(serializeHandoff(handoff)) });
      manifest.push({ file: `${name}.wav`, channels: 1, description: `${microphone.name}: pressure without terrain echoes, with its handoff for Echotect` });
    }
  }
  if (selected.has('scene')) {
    const document = describe({ files: manifest, startSeconds: timeline.startSeconds, sampleRate: timeline.sampleRate });
    files.unshift({ name: `${stem}.json`, data: new TextEncoder().encode(`${JSON.stringify(document, null, 2)}\n`) });
  }
  return files;
}

export function exportDownload(files, stem) {
  if (files.length === 1) {
    const [file] = files;
    return { name: file.name, blob: new Blob([file.data], { type: file.name.endsWith('.json') ? 'application/json' : 'audio/wav' }) };
  }
  return { name: `${stem}.zip`, blob: new Blob([zipStore(files)], { type: 'application/zip' }) };
}
