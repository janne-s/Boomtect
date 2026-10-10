import { arrivalTable, prepareScene, renderReceiverRange } from './domain/render.js';
import { parseScene } from './domain/scene.js';

/**
 * `arrivals`: the arrival tables of the given receivers. `render`: the given receivers for the
 * paths that arrive in [fromSeconds, toSeconds).
 */
self.addEventListener('message', ({ data }) => {
  const { revision, type, scene: value } = data;
  try {
    const scene = parseScene(value);
    const prepared = prepareScene(scene);
    if (type === 'arrivals') {
      const tables = data.receivers.map(index => arrivalTable(prepared, scene.receivers[index], scene));
      self.postMessage({ revision, type: 'result', tables }, tables.flatMap(table => [table.seconds.buffer, table.heights.buffer, table.levels.buffer, table.kinds.buffer]));
      return;
    }
    const segments = data.receivers.map((receiverIndex, index) => {
      const receiver = scene.receivers[receiverIndex];
      const segment = renderReceiverRange(prepared, receiver, scene, {
        fromSeconds: data.fromSeconds,
        toSeconds: data.toSeconds,
        onProgress: (done, total) => self.postMessage({ revision, type: 'progress', fraction: (index + done / total) / data.receivers.length })
      });
      return { receiverId: receiver.id, ...segment };
    });
    self.postMessage({ revision, type: 'result', segments }, segments.flatMap(segment => segment.channels.map(channel => channel.buffer)));
  } catch (error) {
    self.postMessage({ revision, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
