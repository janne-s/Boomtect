import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { mixRenders } from '../domain/offline-render.js';
import { tectNamed } from './tects.js';

const slug = text => String(text).toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'render';
const readJson = file => JSON.parse(readFileSync(file, 'utf8'));

function freeFolder(root, stem) {
  let folder = join(root, stem);
  for (let count = 2; existsSync(folder); count += 1) folder = join(root, `${stem}-${count}`);
  return folder;
}

function renderIn(workerData, onStage) {
  return new Promise((done, fail) => {
    const worker = new Worker(new URL('./render-worker.js', import.meta.url), { workerData });
    worker.on('message', message => (message.summary ? done(message.summary) : onStage(message.stage)));
    worker.on('error', fail);
    worker.on('exit', code => code !== 0 && fail(new Error(`The render stopped with code ${code}.`)));
  });
}

function sceneItems(tects, scenes) {
  if (!Array.isArray(scenes) || !scenes.length) throw new Error('scenes must hold at least one { tect, scene }.');
  return scenes.map(({ tect, scene } = {}) => {
    const raw = typeof scene === 'string' ? JSON.parse(scene) : scene;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`The scene for ${tect} must be a scene object.`);
    return { tect: tectNamed(tects, tect), scene: raw };
  });
}

export function createRenderer({ tects, renders, link: linkFor, waitSeconds = 50, progressSeconds = 5 }) {
  const jobs = new Map();
  const link = (tect, sceneFile) => linkFor(tect, sceneFile).catch(error => `Not available: ${error.message}`);

  async function run(job, items, ambix) {
    const onStage = name => stage => { job.stage = `${name}: ${stage}`; };
    if (items.length === 1) {
      const [{ tect, scene }] = items;
      const summary = await renderIn({ app: tect.app, raw: scene, others: [], ambix, folder: job.folder }, onStage(tect.name));
      return { folder: job.folder, summary, open: { [tect.name]: await link(tect, join(job.folder, 'scene.json')) } };
    }
    const names = new Set();
    const folders = items.map(({ tect }) => {
      let name = slug(tect.name);
      for (let count = 2; names.has(name); count += 1) name = `${slug(tect.name)}-${count}`;
      names.add(name);
      return join(job.folder, name);
    });
    const [first, ...rest] = items;
    const firstSummary = await renderIn({ app: first.tect.app, raw: first.scene, others: rest.map(item => item.scene), ambix, folder: folders[0] }, onStage(first.tect.name));
    const { place, terrain } = readJson(join(folders[0], 'scene.json'));
    const restSummaries = await Promise.all(rest.map((item, index) => renderIn({ app: item.tect.app, raw: { ...item.scene, place, terrain }, others: [], ambix, folder: folders[index + 1] }, onStage(item.tect.name))));
    job.stage = 'mixing';
    const summaries = [firstSummary, ...restSummaries];
    const { files, summary } = mixRenders(folders.map((folder, index) => ({ summary: summaries[index], scene: readJson(join(folder, 'scene.json')), read: file => readFileSync(join(folder, file)) })));
    for (const { name, data } of files) writeFileSync(join(job.folder, name), data);
    const parts = Object.fromEntries(items.map(({ tect }, index) => [tect.name, { folder: folders[index], summary: summaries[index] }]));
    const open = Object.fromEntries(await Promise.all(items.map(async ({ tect }, index) => [tect.name, await link(tect, join(folders[index], 'scene.json'))])));
    return { folder: job.folder, summary, parts, open };
  }

  async function wait(job, progress) {
    let timeout;
    const ticker = setInterval(() => progress(Math.round((Date.now() - job.started) / 1000), job.stage), progressSeconds * 1000);
    const pending = new Promise(done => {
      timeout = setTimeout(() => done({ status: 'rendering', folder: job.folder, stage: job.stage, next: 'The render goes on. Call render_result with this folder to wait for it.' }), waitSeconds * 1000);
    });
    try {
      return await Promise.race([job.done, pending]);
    } finally {
      clearInterval(ticker);
      clearTimeout(timeout);
    }
  }

  function render({ scenes, name, ambix = false } = {}, { progress = () => {} } = {}) {
    const items = sceneItems(tects, scenes);
    const folder = freeFolder(renders, slug(name ?? items.map(({ tect }) => tect.name).join(' ')));
    const job = { folder, started: Date.now(), stage: 'starting' };
    job.done = run(job, items, Boolean(ambix));
    job.done.catch(() => {});
    jobs.set(folder, job);
    return wait(job, progress);
  }

  function renderResult({ folder } = {}, { progress = () => {} } = {}) {
    const job = jobs.get(resolve(String(folder)));
    if (job) return wait(job, progress);
    const summary = join(String(folder), 'summary.json');
    if (existsSync(summary)) return { folder, summary: readJson(summary) };
    throw new Error(`No render is known in ${folder}.`);
  }

  return { render, renderResult };
}
