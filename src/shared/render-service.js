import { diffuseTails } from './domain/forest.js';
import { renderReceiverRange, tailResponses, tracePart } from './domain/render.js';

export function serveRenders({ parseScene, prepareScene }) {
  self.addEventListener('message', ({ data }) => {
    const { revision, type, scene: value } = data;
    try {
      if (type === 'tails') {
        const tails = diffuseTails(data.pressure, data.responses, data.channels);
        self.postMessage({ revision, type: 'result', tails }, tails.map(channel => channel.buffer));
        return;
      }
      const scene = parseScene(value);
      if (type === 'responses') {
        const responses = data.receivers.map(index => tailResponses(scene.receivers[index], scene, data.channels));
        const buffers = new Set(responses.flatMap(item => [...(item.forest ?? []), ...(item.surroundings ?? [])]).map(channel => channel.buffer));
        self.postMessage({ revision, type: 'result', responses }, [...buffers]);
        return;
      }
      const prepared = prepareScene(scene);
      if (type === 'trace') {
        const parts = data.jobs.map(({ receiver, part, parts: count }, index) => tracePart(prepared, scene.receivers[receiver], scene, {
          part,
          parts: count,
          onProgress: share => self.postMessage({ revision, type: 'progress', fraction: (index + share) / data.jobs.length })
        }));
        const tables = parts.flatMap(result => [result.direct, ...result.specular].filter(Boolean));
        self.postMessage({ revision, type: 'result', parts }, tables.flatMap(table => Object.values(table).filter(ArrayBuffer.isView).map(array => array.buffer)));
        return;
      }
      const segments = data.receivers.map((receiverIndex, index) => {
        const receiver = scene.receivers[receiverIndex];
        const segment = renderReceiverRange(prepared, receiver, scene, {
          fromSeconds: data.fromSeconds,
          toSeconds: data.toSeconds,
          paths: data.paths[index],
          extents: data.extents[index],
          earliestSeconds: data.earliest?.[index] ?? null,
          onProgress: share => self.postMessage({ revision, type: 'progress', fraction: (index + share) / data.receivers.length })
        });
        return { receiverId: receiver.id, ...segment };
      });
      self.postMessage({ revision, type: 'result', segments }, segments.flatMap(segment => segment.channels.map(channel => channel.buffer)));
    } catch (error) {
      self.postMessage({ revision, type: 'error', message: error instanceof Error ? error.message : String(error) });
    }
  });
}
