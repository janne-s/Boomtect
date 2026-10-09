import { prepareScene, renderReceiver } from './domain/render.js';
import { parseScene } from './domain/scene.js';

self.addEventListener('message', ({ data }) => {
  const { revision, scene: value } = data;
  try {
    const started = performance.now();
    const scene = parseScene(value);
    const prepared = prepareScene(scene);
    const results = scene.receivers.map((receiver, index) => renderReceiver(prepared, receiver, scene, {
      onProgress: (done, total) => self.postMessage({ revision, type: 'progress', fraction: (index + done / total) / scene.receivers.length })
    }));
    const sources = prepared.reduce((sum, item) => sum + item.sources.length, 0);
    self.postMessage(
      { revision, type: 'result', results, sources, milliseconds: performance.now() - started },
      results.map(result => result.samples.buffer)
    );
  } catch (error) {
    self.postMessage({ revision, type: 'error', message: error instanceof Error ? error.message : String(error) });
  }
});
