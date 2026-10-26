import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const TECT_FILES = ['tect.json', 'src/domain/scene.js', 'src/domain/render.js', 'src/shared/domain/offline-render.js', 'src/shared/ui/terrain-loader.js'];
const AGENT_SECTION = '## Rendering from a script or an agent';

const isTect = app => TECT_FILES.every(file => existsSync(join(app, file)));

export function findTects(folders) {
  const apps = [].concat(folders).filter(folder => existsSync(folder)).flatMap(folder => readdirSync(folder, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => [join(folder, entry.name, 'App'), join(folder, entry.name)].find(isTect))
    .filter(Boolean));
  const byName = new Map();
  for (const app of apps) {
    const page = JSON.parse(readFileSync(join(app, 'tect.json'), 'utf8'));
    if (!byName.has(page.name)) byName.set(page.name, { name: page.name, description: page.description, app });
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

export function tectNamed(tects, name) {
  const tect = tects.find(item => item.name.toLowerCase() === String(name).toLowerCase());
  if (!tect) throw new Error(`There is no tect ${name}. The tects are ${tects.map(item => item.name).join(', ')}.`);
  return tect;
}

export const importFrom = (app, file) => import(pathToFileURL(join(app, file)).href);

function agentSection(app) {
  const readme = readFileSync(join(app, 'README.md'), 'utf8');
  const start = readme.indexOf(AGENT_SECTION);
  if (start < 0) return '';
  const end = readme.indexOf('\n## ', start + AGENT_SECTION.length);
  return readme.slice(start, end < 0 ? undefined : end).trim();
}

export function examplesOf(app) {
  const folder = join(app, 'examples');
  if (!existsSync(folder)) return {};
  return Object.fromEntries(readdirSync(folder).filter(file => file.endsWith('.json')).sort().map(file => [basename(file, '.json'), JSON.parse(readFileSync(join(folder, file), 'utf8'))]));
}

export async function describeTect(tect) {
  const { MODES, PARAMETERS, defaultScene } = await importFrom(tect.app, 'src/domain/scene.js');
  return {
    name: tect.name,
    description: tect.description,
    guide: agentSection(tect.app),
    examples: examplesOf(tect.app),
    defaultScenes: Object.fromEntries(MODES.map(mode => [mode, defaultScene(mode)])),
    parameters: PARAMETERS
  };
}
