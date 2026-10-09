import { prepareScene, renderReceiverRange } from './domain/render.js';
import { parseScene } from './domain/scene.js';

/** Renders every receiver for the paths that arrive in [fromSeconds, toSeconds). */
self.addEventListener('message', ({ data }) => {
  const { revision, scene: value, fromSeconds, toSeconds } = data;
  try {
    const scene = parseScene(value);
    const prepared = prepareScene(scene);
    const segments = scene.receivers.map((receiver, index) => {
      const segment = renderReceiverRange(prepared, receiver, scene, {
        fromSeconds, toSeconds,
        onProgress: (done, total) => self.postMessage({ revision, type: 'progress', fraction: (index + done / total) / scene.receivers.length })
      });
      return { receiverId: receiver.id, ...segment };
    });
    self.postMessage({ revision, type: 'result', segments }, segments.flatMap(segment => segment.channels.map(channel => channel.buffer)));
  } catch (error) {
    self.postMessage({ revision, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
