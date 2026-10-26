// node src/mcp/server.mjs [--tects <folder of tects>] [--renders <folder for renders>]
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createLinks } from './links.js';
import { createMcpServer } from './protocol.js';
import { createRenderer } from './render.js';
import { describeTect, examplesOf, findTects, tectNamed } from './tects.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const option = name => { const value = process.argv[process.argv.indexOf(name) + 1]; return process.argv.includes(name) && value && !value.includes('${') ? value : null; };
let root = here;
while (!existsSync(join(root, 'package.json')) && dirname(root) !== root) root = dirname(root);
const sharedVersion = join(here, '..', 'shared-version.json');
const version = existsSync(sharedVersion) ? JSON.parse(readFileSync(sharedVersion, 'utf8')).commit : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const chosen = option('--tects');
const folders = chosen ? [resolve(chosen)] : existsSync(join(root, 'tects')) ? [join(root, 'tects')] : [dirname(root), dirname(dirname(root)), join(dirname(root), 'Projects')];
const renders = resolve(option('--renders') ?? join(homedir(), 'Documents', 'Tect renders'));
const tects = findTects(folders);
const links = createLinks({ renders });
const renderer = createRenderer({ tects, renders, link: links.link });

const instructions = `Tects render sounds from their physics: ${tects.map(tect => tect.name).join(', ')}. To make a sound from a request in words:
1. Call describe for the tect whose sources fit, and translate the request with its guide's table. Timbre words decide the source as much as its kind.
2. Start from the nearest example scene and change only what the request names; missing fields take their defaults, values out of range are brought into range.
3. Call render. Check each microphone's measurements against the request: dark or bright by spectralCentroidHz and the 2000 Hz and 4000 Hz octaves; long or short by withinFortyDecibelsSeconds; loud or near by loudestDecibelsAFast, not peakDecibelsSpl. If a word is missed, change one field and render again; stop after three renders.
4. Hand over the WAV paths and the open links, say in a few lines what you chose, and name the next field to change.
A real place takes its coordinates in place and "terrain": { "enabled": true }: use the coordinates you know for a named place and put the microphone where the description puts it; ask only when unsure, and never send an address to a search service unasked. A sound made by two tects, such as a supersonic jet's boom (Boomtect) and engine (Rumbletect), is one render call with both scenes sharing place, terrain, air, ground, and receivers, ids included. For a collection whose levels compare, render the loudest first and set "render": { "levelMode": "fixed", "fullScalePa": <its fullScalePa> } in the others; a new seed gives another take.
The open links serve the app from this computer while this server runs; the user starts nothing. For direction on headphones, make the microphone binaural with its heading toward the source and give the open link, where the app plays it binaurally; ask for ambix only when the user wants Ambisonics.\nRender only with the render tool. If it fails, tell the user what failed; the commands in a guide need the tect's repository, which the user may not have.`;

const tools = [
  {
    name: 'list_tects',
    description: 'The tects that can render here, with what they make and the names of their example scenes.',
    inputSchema: { type: 'object', properties: {} },
    call: () => tects.map(tect => ({ name: tect.name, description: tect.description, examples: Object.keys(examplesOf(tect.app)) }))
  },
  {
    name: 'describe',
    description: 'How to write a scene for one tect: a guide with a table of what each change does to the sound, example scenes, the default scene of each mode, and every parameter with its unit and range.',
    inputSchema: { type: 'object', properties: { tect: { type: 'string', description: 'A tect name from list_tects, such as Rumbletect.' } }, required: ['tect'] },
    call: ({ tect }) => describeTect(tectNamed(tects, tect))
  },
  {
    name: 'render',
    description: 'Renders scenes to WAV files on this computer, one per microphone, with the filled scene.json, measurements to check the sound by, and a link that opens the scene in its app. Several scenes of different tects are rendered at one place and mixed in the scene\'s time, with each part as its own file. A long render returns status "rendering"; then call render_result.',
    inputSchema: {
      type: 'object',
      properties: {
        scenes: {
          type: 'array',
          minItems: 1,
          description: 'One scene, or one per tect for a sound several tects make together.',
          items: { type: 'object', properties: { tect: { type: 'string' }, scene: { type: 'object', description: 'A scene as in describe: a partial one is filled with defaults.' } }, required: ['tect', 'scene'] }
        },
        name: { type: 'string', description: 'A few words naming the sound; the folder is named after them.' },
        ambix: { type: 'boolean', description: 'AmbiX channels of the scene\'s order instead of omni pressure. Only for spatial audio.' }
      },
      required: ['scenes']
    },
    call: (args, context) => {
      mkdirSync(renders, { recursive: true });
      return renderer.render(args, context);
    }
  },
  {
    name: 'render_result',
    description: 'Waits for a render that returned status "rendering" and gives its result.',
    inputSchema: { type: 'object', properties: { folder: { type: 'string', description: 'The folder the render returned.' } }, required: ['folder'] },
    call: (args, context) => renderer.renderResult(args, context)
  }
];

const handle = createMcpServer({ info: { name: 'tect', version }, instructions, tools });
const send = message => process.stdout.write(`${JSON.stringify(message)}\n`);
const input = createInterface({ input: process.stdin });
input.on('line', line => { if (line.trim()) handle(line, send); });
input.on('close', () => links.close().then(() => process.exit(0)));
