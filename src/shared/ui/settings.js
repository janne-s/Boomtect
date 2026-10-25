import { PREVIEW } from '../domain/constants.js';
import { previewQuality, relativeCost } from '../domain/render-cost.js';
import { DEFAULT_QUALITY, PARAMETERS, QUALITY_NUMBERS, QUALITY_SWITCHES } from '../domain/scene.js';

const SYNTHESIS_LEVELS = Object.freeze(['exact', 'fast', 'fastest']);

const plural = (value, one, many) => `${value} ${value === 1 ? one : many}`;

const SETTINGS = Object.freeze({
  cutoffDecibels: { step: 1, format: value => `−${Math.abs(Math.round(value))} dB` },
  highestFrequencyHz: { step: 500, format: value => `${+(value / 1000).toFixed(1)} kHz` },
  sourceMerge: { step: 1, format: value => (value === 1 ? 'every segment' : `1 per ${value} segments`), idle: context => (context.flashes ? null : 'no flashes') },
  echoCellScale: { step: .5, format: (value, context) => `${Math.round(context.echoCellMetres * value)} m cells`, idle: context => (context.echoCellMetres ? null : 'no terrain echoes') },
  scatterArrivals: { step: 1, format: value => plural(value, 'arrival', 'arrivals'), idle: context => (context.echoCellMetres ? null : 'no terrain echoes') },
  synthesis: { step: 1, format: value => SYNTHESIS_LEVELS[value], idle: context => (context.grains ? null : 'no grain sources') },
  threads: { step: 1, format: (value, context) => `${value} of ${context.maximumThreads}` }
});

const SWITCHES = Object.freeze({
  coarseForest: { label: 'Coarse forest', idle: context => (context.forest ? null : 'no forest') },
  sharedScatter: { label: 'Shared scatter', idle: context => (context.echoCellMetres ? null : 'no terrain echoes') },
  coarseEchoes: { label: 'Coarse echoes', idle: context => (!context.echoCellMetres ? 'no terrain echoes' : context.grains ? null : 'no grain sources') }
});

const PREVIEW_SUMMARY = `${PREVIEW.sourceMerge} segments · ${PREVIEW.echoCellScale} × cells · ≤ ${PREVIEW.highestHz / 1000} kHz`;

const $ = id => document.getElementById(id);

export function createSettings({ read, save }) {
  const dialog = $('settings-dialog');
  let rows = [];
  let context = null;

  function slider(grid, key, label, value, { minimum, maximum }) {
    const { step, format, idle } = SETTINGS[key];
    const idleText = idle?.(context) ?? null;
    const id = `setting-${key}`;
    const name = document.createElement('label');
    name.htmlFor = id;
    name.textContent = label;
    const input = Object.assign(document.createElement('input'), { type: 'range', id, min: minimum, max: maximum, step });
    input.value = String(value);
    const output = document.createElement('output');
    output.htmlFor = id;
    let touched = false;
    const current = () => (touched ? Number(input.value) : value);
    const fill = () => {
      input.style.setProperty('--to', `${(Number(input.value) - minimum) / (maximum - minimum) * 100}%`);
      output.textContent = idleText ?? format(current(), context);
    };
    if (idleText) {
      input.disabled = true;
      name.classList.add('idle');
      output.classList.add('idle');
    }
    input.addEventListener('input', () => { touched = true; fill(); updateCost(); });
    fill();
    grid.append(name, input, output);
    return { key, value: current };
  }

  function checkbox(grid, key, label, checked, summary, idleText = null) {
    const id = `setting-${key}`;
    const name = document.createElement('label');
    name.htmlFor = id;
    name.textContent = label;
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked });
    input.addEventListener('change', updateCost);
    const output = document.createElement('output');
    output.htmlFor = id;
    output.className = 'settings-summary';
    output.textContent = idleText ?? summary;
    if (idleText) {
      input.disabled = true;
      name.classList.add('idle');
      output.classList.add('idle');
    }
    const cell = document.createElement('div');
    cell.className = 'settings-check';
    cell.append(input, output);
    grid.append(name, cell);
    return { key, value: () => input.checked };
  }

  function values() {
    return Object.fromEntries(rows.map(item => [item.key, item.value()]));
  }

  function updateCost() {
    const { preview, threads, ...chosen } = values();
    const quality = { ...(preview ? previewQuality(chosen) : chosen), ...(context.flashes ? {} : { sourceMerge: 1 }), ...(context.grains ? {} : { synthesis: 0, coarseEchoes: false }) };
    const share = relativeCost(quality, context.scatterShare, context.forest);
    const most = relativeCost({ ...DEFAULT_QUALITY, cutoffDecibels: PARAMETERS.cutoffDecibels.minimum, scatterArrivals: PARAMETERS.scatterArrivals.maximum }, context.scatterShare, context.forest);
    $('cost-fill').style.width = `${Math.min(100, share / most * 100)}%`;
    $('cost-full').style.left = `${100 / most}%`;
    let text = `≈ ${Math.round(share * 100)} % of full`;
    const { last } = context;
    if (last) {
      const lastQuality = { ...last.quality, ...(context.flashes ? {} : { sourceMerge: 1 }), ...(context.grains ? {} : { synthesis: 0, coarseEchoes: false }) };
      const seconds = last.milliseconds / 1000 * share / relativeCost(lastQuality, context.scatterShare, context.forest) * last.workers / threads;
      text += ` · ≈ ${seconds < 10 ? seconds.toFixed(1) : Math.round(seconds)} s`;
    }
    $('cost-value').textContent = text;
  }

  function open() {
    const settings = read();
    const { quality, preview, threads } = settings;
    context = settings;
    $('settings-grid').replaceChildren();
    $('device-grid').replaceChildren();
    rows = [
      ...QUALITY_NUMBERS.map(key => slider($('settings-grid'), key, PARAMETERS[key].label, quality[key], PARAMETERS[key])),
      ...QUALITY_SWITCHES.map(key => checkbox($('settings-grid'), key, SWITCHES[key].label, quality[key], '', SWITCHES[key].idle(context))),
      checkbox($('settings-grid'), 'preview', 'Preview', preview, PREVIEW_SUMMARY),
      slider($('device-grid'), 'threads', 'Threads', threads, { minimum: 1, maximum: settings.maximumThreads })
    ];
    updateCost();
    dialog.returnValue = 'cancel';
    dialog.showModal();
    dialog.focus();
  }

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const { preview, threads, ...quality } = values();
    save({ quality, preview, threads });
  });

  $('settings').addEventListener('click', open);
}
