import { PREVIEW } from '../domain/constants.js';
import { previewQuality, relativeCost } from '../domain/render-cost.js';
import { DEFAULT_QUALITY, PARAMETERS, QUALITY_KEYS } from '../domain/scene.js';

/**
 * The Settings dialog, as Echotect's: one row per setting, built from the table below and the
 * scene's PARAMETERS, applied only by Save. The computation's settings belong to the scene
 * (`render.quality`), so that a scene renders alike everywhere; the preview and the threads belong
 * to the device. A bar shows what the computation costs against the full one (`render-cost.js`),
 * with the time that would take from the last render's.
 */

const plural = (value, one, many) => `${value} ${value === 1 ? one : many}`;

/** Each setting's slider step and how its value reads; `context` carries the terrain's echo cells. */
const SETTINGS = Object.freeze({
  cutoffDecibels: { step: 1, format: value => `−${Math.abs(Math.round(value))} dB` },
  highestFrequencyHz: { step: 500, format: value => `${+(value / 1000).toFixed(1)} kHz` },
  sourceMerge: { step: 1, format: value => (value === 1 ? 'every segment' : `1 per ${value} segments`) },
  echoCellScale: { step: .5, format: (value, context) => (context.echoCellMetres ? `${Math.round(context.echoCellMetres * value)} m cells` : `${value} ×`) },
  scatterArrivals: { step: 1, format: value => plural(value, 'arrival', 'arrivals') },
  threads: { step: 1, format: (value, context) => `${value} of ${context.maximumThreads}` }
});

const PREVIEW_SUMMARY = `${PREVIEW.sourceMerge} segments · ${PREVIEW.echoCellScale} × cells · ≤ ${PREVIEW.highestHz / 1000} kHz`;

const $ = id => document.getElementById(id);

/**
 * `read()` gives the scene's quality, whether the preview is on, the device's threads and the most
 * there are, the terrain's echo cells (or null), the scattered paths' share in the last render, and
 * the last render (`{ milliseconds, workers, quality }`, or null); `save({ quality, preview, threads })`
 * gets them back after Save.
 */
export function createSettings({ read, save }) {
  const dialog = $('settings-dialog');
  let rows = [];
  let context = null;

  function slider(grid, key, label, value, { minimum, maximum }) {
    const { step, format } = SETTINGS[key];
    const id = `setting-${key}`;
    const name = document.createElement('label');
    name.htmlFor = id;
    name.textContent = label;
    const input = Object.assign(document.createElement('input'), { type: 'range', id, min: minimum, max: maximum, step });
    input.value = String(value);
    const output = document.createElement('output');
    output.htmlFor = id;
    // A setting left alone keeps its stored value, which the slider's step may not reach.
    let touched = false;
    const current = () => (touched ? Number(input.value) : value);
    const fill = () => {
      input.style.setProperty('--to', `${(Number(input.value) - minimum) / (maximum - minimum) * 100}%`);
      output.textContent = format(current(), context);
    };
    input.addEventListener('input', () => { touched = true; fill(); updateCost(); });
    fill();
    grid.append(name, input, output);
    return { key, value: current };
  }

  function checkbox(grid, key, label, checked, summary) {
    const id = `setting-${key}`;
    const name = document.createElement('label');
    name.htmlFor = id;
    name.textContent = label;
    const input = Object.assign(document.createElement('input'), { type: 'checkbox', id, checked });
    input.addEventListener('change', updateCost);
    const output = document.createElement('output');
    output.htmlFor = id;
    output.className = 'settings-summary';
    output.textContent = summary;
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
    const quality = preview ? previewQuality(chosen) : chosen;
    const share = relativeCost(quality, context.scatterShare);
    const most = relativeCost({ ...DEFAULT_QUALITY, cutoffDecibels: PARAMETERS.cutoffDecibels.minimum, scatterArrivals: PARAMETERS.scatterArrivals.maximum }, context.scatterShare);
    $('cost-fill').style.width = `${Math.min(100, share / most * 100)}%`;
    $('cost-full').style.left = `${100 / most}%`;
    let text = `≈ ${Math.round(share * 100)} % of full`;
    const { last } = context;
    if (last) {
      // Time scales with the cost and, roughly, inversely with the threads.
      const seconds = last.milliseconds / 1000 * share / relativeCost(last.quality, context.scatterShare) * last.workers / threads;
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
      ...QUALITY_KEYS.map(key => slider($('settings-grid'), key, PARAMETERS[key].label, quality[key], PARAMETERS[key])),
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
