// Renders a scene file without the browser, for scripts and agents: one WAV per microphone, the filled scene, and a JSON summary on stdout.
// node tools/render.mjs <scene.json> <folder> [--ambix]
// The scene may be one saved from the app or a partial one; missing fields take their defaults and values are brought into range.
// Files are 32-bit float at the app's export gain. Without --ambix each file is the omni pressure; with it, every AmbiX channel.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readScene, serializeScene } from '../src/domain/scene.js';
import { prepareScene } from '../src/domain/render.js';
import { renderSceneFiles } from '../src/shared/domain/offline-render.js';

const [file, folder, ...flags] = process.argv.slice(2);
if (!file || !folder) {
  console.error('node tools/render.mjs <scene.json> <folder> [--ambix]');
  process.exit(2);
}
const scene = readScene(JSON.parse(readFileSync(file, 'utf8')));
const { files, summary } = renderSceneFiles(scene, { prepareScene, serializeScene }, { ambix: flags.includes('--ambix') });
mkdirSync(folder, { recursive: true });
for (const { name, data } of files) writeFileSync(join(folder, name), data);
console.log(JSON.stringify(summary, null, 2));
