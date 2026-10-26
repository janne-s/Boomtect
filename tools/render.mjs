// node tools/render.mjs <scene.json> <folder> [--ambix] [--cover <scene.json of another tect>]...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readScene, serializeScene } from '../src/domain/scene.js';
import { prepareScene } from '../src/domain/render.js';
import { renderSceneFiles } from '../src/shared/domain/offline-render.js';
import { readSceneWithTerrain } from '../src/shared/ui/terrain-loader.js';

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
const covers = [];
const positional = [];
for (let index = 0; index < args.length; index += 1) {
  if (args[index] === '--cover') covers.push(readJson(args[(index += 1)]));
  else if (args[index] !== '--ambix') positional.push(args[index]);
}
const [file, folder] = positional;
if (!file || !folder) {
  console.error('node tools/render.mjs <scene.json> <folder> [--ambix] [--cover <scene.json of another tect>]...');
  process.exit(2);
}
let shown = -1;
const onProgress = share => { const tenth = Math.floor(share * 10); if (tenth > shown) { shown = tenth; process.stderr.write(`terrain ${tenth * 10}%\n`); } };
const scene = await readSceneWithTerrain(readJson(file), { readScene, prepareScene }, { others: covers, onProgress });
const { files, summary } = renderSceneFiles(scene, { prepareScene, serializeScene }, { ambix: args.includes('--ambix') });
mkdirSync(folder, { recursive: true });
for (const { name, data } of files) writeFileSync(join(folder, name), data);
console.log(JSON.stringify(summary, null, 2));
