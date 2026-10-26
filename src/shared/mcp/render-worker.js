import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { importFrom } from './tects.js';

const { app, raw, others, ambix, folder } = workerData;
const [{ readScene, serializeScene }, { prepareScene }, { renderSceneFiles }, { readSceneWithTerrain }] = await Promise.all([
  importFrom(app, 'src/domain/scene.js'),
  importFrom(app, 'src/domain/render.js'),
  importFrom(app, 'src/shared/domain/offline-render.js'),
  importFrom(app, 'src/shared/ui/terrain-loader.js')
]);
const scene = await readSceneWithTerrain(raw, { readScene, prepareScene }, { others, onProgress: share => parentPort.postMessage({ stage: `loading terrain ${Math.round(share * 100)}%` }) });
parentPort.postMessage({ stage: 'rendering' });
const { files, summary } = renderSceneFiles(scene, { prepareScene, serializeScene }, { ambix });
mkdirSync(folder, { recursive: true });
for (const { name, data } of files) writeFileSync(join(folder, name), data);
parentPort.postMessage({ summary });
