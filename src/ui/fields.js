import { PARAMETERS } from '../domain/scene.js';

/** How a stored SI value is shown in the panel; stored values never change unit. */
const DISPLAY = Object.freeze({
  energyJoulesPerMetre: { scale: 1e-3, unit: 'kJ/m' },
  acousticEfficiency: { scale: 100, unit: '%' },
  channelSpeedMetresPerSecond: { scale: 1e-3, unit: 'km/s' },
  branchLengthRatio: { scale: 100, unit: '% of channel' },
  branchEnergyRatio: { scale: 100, unit: '%' },
  groundFlashShare: { scale: 100, unit: '%' },
  newTerminationProbability: { scale: 100, unit: '% of strokes' },
  turbulenceStrength: { scale: 1e6, unit: '×10⁻⁶ ⟨μ²⟩' },
  lapseRateKelvinPerMetre: { scale: 1e3, unit: 'K/km' },
  radiusMetres: { scale: 1e-3, unit: 'km' },
  cloudBaseMetres: { scale: 1e-3, unit: 'km' },
  cloudTopMetres: { scale: 1e-3, unit: 'km' },
  strokeIntervalSeconds: { scale: 1e3, unit: 'ms' },
  subsequentStrokeEnergyRatio: { scale: 100, unit: '%' },
  durationSecondsPerCubeRootKilogram: { scale: 1e3, unit: 'ms/kg^⅓' },
  riseTimeSeconds: { scale: 1e3, unit: 'ms' }
});

const display = key => DISPLAY[key] ?? { scale: 1, unit: PARAMETERS[key]?.unit ?? '' };
const rounded = value => +value.toPrecision(5);

function append(container, ...elements) {
  elements.forEach(element => container.append(element));
}

function labelFor(text, unit, id) {
  const label = document.createElement('label');
  label.htmlFor = id;
  label.textContent = unit ? `${text} (${unit})` : text;
  label.title = label.textContent;
  return label;
}

function badge(reliability) {
  const element = document.createElement('span');
  element.className = 'class';
  if (reliability) {
    element.textContent = reliability;
    element.dataset.class = reliability;
    element.title = { A: 'First principles', B: 'Literature', C: 'Heuristic or synthetic' }[reliability];
  }
  return element;
}

let fieldCounter = 0;

/**
 * A number row bound to a parameter range. The value commits on change; an out-of-range entry is
 * marked and reverted instead of being clamped silently.
 */
export function numberField(container, { key, label, value, onCommit, reliability }) {
  const parameter = PARAMETERS[key];
  const { scale, unit } = display(key);
  const id = `field-${fieldCounter += 1}`;
  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.step = 'any';
  input.value = rounded(value * scale);
  input.addEventListener('change', () => {
    const next = Number(input.value) / scale;
    const valid = input.value !== '' && Number.isFinite(next) && next >= parameter.minimum && next <= parameter.maximum
      && (!parameter.integer || Number.isInteger(next));
    input.setAttribute('aria-invalid', String(!valid));
    if (!valid) {
      input.title = `${rounded(parameter.minimum * scale)}–${rounded(parameter.maximum * scale)} ${unit}`;
      return;
    }
    input.removeAttribute('title');
    onCommit(next);
  });
  input.addEventListener('blur', () => {
    if (input.getAttribute('aria-invalid') === 'true') {
      input.value = rounded(input.dataset.committed * scale);
      input.setAttribute('aria-invalid', 'false');
    }
  });
  input.dataset.committed = value;
  append(container, labelFor(label ?? parameter.label, unit, id), input, badge(reliability === undefined ? parameter.reliability : reliability));
  return {
    set(nextValue) {
      input.dataset.committed = nextValue;
      if (document.activeElement !== input) input.value = rounded(nextValue * scale);
    }
  };
}

/** Coordinate rows for a point in metres; `axes` limits them, as for a point fixed to the ground. */
export function pointFields(container, { label, point, onCommit, reliability = null, axes = ['x', 'y', 'z'] }) {
  const heading = document.createElement('div');
  heading.className = 'unit-row';
  heading.textContent = label;
  container.append(heading);
  const rows = axes.map(axis => numberField(container, {
    key: axis === 'z' ? 'heightMetres' : 'coordinateMetres',
    label: { x: 'East', y: 'North', z: 'Height' }[axis],
    value: point[axis],
    reliability,
    onCommit: value => onCommit({ ...point, [axis]: value })
  }));
  return { set(next) { rows.forEach((row, index) => row.set(next[axes[index]])); } };
}

export function textField(container, { label, value, onCommit }) {
  const id = `field-${fieldCounter += 1}`;
  const input = document.createElement('input');
  input.type = 'text';
  input.id = id;
  input.maxLength = 64;
  input.value = value;
  input.addEventListener('change', () => {
    const next = input.value.trim();
    if (next) onCommit(next); else input.value = value;
  });
  append(container, labelFor(label, '', id), input, badge(null));
}

export function selectField(container, { label, value, options, onCommit, reliability = null }) {
  const id = `field-${fieldCounter += 1}`;
  const select = document.createElement('select');
  select.id = id;
  for (const [optionValue, optionLabel] of options) select.add(new Option(optionLabel, optionValue, false, optionValue === value));
  select.addEventListener('change', () => onCommit(select.value));
  append(container, labelFor(label, '', id), select, badge(reliability));
}

export function checkboxField(container, { label, value, onCommit, reliability = null }) {
  const id = `field-${fieldCounter += 1}`;
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.id = id;
  input.checked = value;
  input.addEventListener('change', () => onCommit(input.checked));
  const holder = document.createElement('div');
  holder.append(input);
  append(container, labelFor(label, '', id), holder, badge(reliability));
}

export function seedField(container, { value, onCommit, onNew }) {
  const id = `field-${fieldCounter += 1}`;
  const holder = document.createElement('div');
  holder.className = 'seed';
  const input = document.createElement('input');
  input.type = 'number';
  input.id = id;
  input.min = '0';
  input.max = String(0xffffffff);
  input.step = '1';
  input.value = value;
  input.addEventListener('change', () => {
    const next = Number(input.value);
    if (Number.isInteger(next) && next >= 0 && next <= 0xffffffff) onCommit(next); else input.value = value;
  });
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = 'New';
  button.addEventListener('click', onNew);
  holder.append(input, button);
  append(container, labelFor('Seed', '', id), holder, badge('C'));
}
