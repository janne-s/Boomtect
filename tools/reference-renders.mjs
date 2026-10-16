import { mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { encodeFloat32Wav } from '../src/shared/domain/wav.js';
import { digest, REFERENCE_CASES, REFERENCE_FILE, renderCase } from '../test/reference-scenes.js';

const [wavFolder] = process.argv.slice(2);
const commit = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
const dirty = Boolean(execFileSync('git', ['status', '--porcelain', '--', 'src'], { encoding: 'utf8' }).trim());
if (wavFolder) mkdirSync(wavFolder, { recursive: true });
const cases = {};
for (const item of REFERENCE_CASES) {
  const results = renderCase(item);
  cases[item.name] = digest(results);
  if (wavFolder) {
    for (const result of results) writeFileSync(join(wavFolder, `${item.name}-${result.receiverId}.wav`), Buffer.from(encodeFloat32Wav([result.channels[0]], result.sampleRate)));
  }
  console.log(item.name, cases[item.name].slice(0, 12));
}
writeFileSync(REFERENCE_FILE, `${JSON.stringify({ commit: dirty ? `${commit}+` : commit, cases }, null, 2)}\n`);
