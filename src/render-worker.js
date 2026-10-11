import { prepareScene, renderReceiverRange, tracePart } from './domain/render.js';
import { parseScene } from './domain/scene.js';

/**
 * `trace`: parts of the tracing at receivers, `jobs` of { receiver, part, parts }, which the page
 * puts together. `render`: the given receivers for the paths that arrive in [fromSeconds,
 * toSeconds), from their traced `paths`.
 */
self.addEventListener('message', ({ data }) => {
  const { revision, type, scene: value } = data;
  try {
    const scene = parseScene(value);
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
        onProgress: share => self.postMessage({ revision, type: 'progress', fraction: (index + share) / data.receivers.length })
      });
      return { receiverId: receiver.id, ...segment };
    });
    self.postMessage({ revision, type: 'result', segments }, segments.flatMap(segment => segment.channels.map(channel => channel.buffer)));
  } catch (error) {
    self.postMessage({ revision, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
