// node tools/mix.mjs <folder> <render folder> <render folder>...
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mixRenders } from '../src/shared/domain/offline-render.js';

const [folder, ...renderFolders] = process.argv.slice(2);
if (!folder || renderFolders.length < 2) {
  console.error('node tools/mix.mjs <folder> <render folder> <render folder>...');
  process.exit(2);
}
const renders = renderFolders.map(source => ({
  summary: JSON.parse(readFileSync(join(source, 'summary.json'), 'utf8')),
  scene: JSON.parse(readFileSync(join(source, 'scene.json'), 'utf8')),
  read: file => readFileSync(join(source, file))
}));
const { files, summary } = mixRenders(renders);
mkdirSync(folder, { recursive: true });
for (const { name, data } of files) writeFileSync(join(folder, name), data);
console.log(JSON.stringify(summary, null, 2));
