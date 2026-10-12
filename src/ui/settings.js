import { PARAMETERS, QUALITY_KEYS } from '../domain/scene.js';

/**
 * The Settings dialog, as Echotect's: one row per setting, built from the table below and the
 * scene's PARAMETERS, applied only by Save. The computation's settings belong to the scene
 * (`render.quality`), so that a scene renders alike everywhere; the threads belong to the device.
 */

const plural = (value, one, many) => `${value} ${value === 1 ? one : many}`;

/** Each setting's slider step and how its value reads. */
const SETTINGS = Object.freeze({
  cutoffDecibels: { step: 1, format: value => `−${Math.abs(Math.round(value))} dB` },
  highestFrequencyHz: { step: 500, format: value => `${+(value / 1000).toFixed(1)} kHz` },
  sourceMerge: { step: 1, format: value => plural(value, 'segment', 'segments') },
  echoCellScale: { step: .5, format: value => `${value} ×` },
  scatterArrivals: { step: 1, format: value => String(value) },
  threads: { step: 1, format: (value, maximum) => `${value} of ${maximum}` }
});

const $ = id => document.getElementById(id);

/**
 * `read()` gives the scene's quality, the device's threads, and the most threads there are;
 * `save({ quality, threads })` gets them back after Save.
 */
export function createSettings({ read, save }) {
  const dialog = $('settings-dialog');
  let rows = [];

  function row(key, label, value, { minimum, maximum }, maximumThreads) {
    const { step, format } = SETTINGS[key];
    const id = `setting-${key}`;
    const name = document.createElement('label');
    name.htmlFor = id;
    name.textContent = label;
    const input = Object.assign(document.createElement('input'), { type: 'range', id, min: minimum, max: maximum, step });
    input.value = String(value);
    const output = document.createElement('output');
    output.htmlFor = id;
    const fill = () => {
      const share = (Number(input.value) - minimum) / (maximum - minimum) * 100;
      input.style.setProperty('--to', `${share}%`);
      output.textContent = format(Number(input.value), maximumThreads);
    };
    // A setting left alone keeps its stored value, which the slider's step may not reach.
    let touched = false;
    input.addEventListener('input', () => { touched = true; fill(); });
    fill();
    $('settings-grid').append(name, input, output);
    return { key, value: () => (touched ? Number(input.value) : value) };
  }

  function open() {
    const { quality, threads, maximumThreads } = read();
    $('settings-grid').replaceChildren();
    rows = [
      ...QUALITY_KEYS.map(key => row(key, PARAMETERS[key].label, quality[key], PARAMETERS[key])),
      row('threads', 'Threads', threads, { minimum: 1, maximum: maximumThreads }, maximumThreads)
    ];
    dialog.returnValue = 'cancel';
    dialog.showModal();
    dialog.focus();
  }

  dialog.addEventListener('close', () => {
    if (dialog.returnValue !== 'save') return;
    const values = Object.fromEntries(rows.map(item => [item.key, item.value()]));
    const { threads, ...quality } = values;
    save({ quality, threads });
  });

  $('settings').addEventListener('click', open);
}
