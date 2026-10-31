import { emptyLibrary, ENVIRONMENT_PRESETS, environmentValues, flightSection, mergedLibraries, presetName, presetsIn, readLibrary, withEnvironment, withoutPreset, withPreset } from '../domain/presets.js';

const EMITTER_TAB = 'emitter';
const PARTS = Object.freeze([['device', 'Device'], ['flight', 'Flight'], ['both', 'Both']]);

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function iconNode(name) {
  const icon = node('i', `fa-solid ${name}`);
  icon.setAttribute('aria-hidden', 'true');
  return icon;
}

const textButton = (text, onClick, className = '') => {
  const button = node('button', className, text);
  button.type = 'button';
  button.addEventListener('click', onClick);
  return button;
};

/**
 * One window for the library: an emitter's device on one tab, the air and ground on the other. Presets stay in the
 * browser apart from the app's own data, so that a reset leaves them, and are saved to or merged from one file.
 */
export function createPresets({ tect, storageKey, state, commit, readScene, kinds, download }) {
  const title = `${tect[0].toUpperCase()}${tect.slice(1)}`;

  function load() {
    try { return readLibrary(JSON.parse(localStorage.getItem(storageKey)), tect); } catch { return emptyLibrary(tect); }
  }
  function store(library) {
    try { localStorage.setItem(storageKey, JSON.stringify(library)); } catch {}
  }

  const emitterOf = (scene, id) => scene.emitters.find(item => item.id === id);
  const presetOf = emitter => (emitter ? kinds[emitter.kind].preset ?? null : null);

  /** Each device section and then each flight section once, named after the first kind that gives it, in the tect's order of kinds. */
  const emitterSections = [];
  const addSection = (section, label) => { if (!emitterSections.some(([known]) => known === section)) emitterSections.push([section, label]); };
  for (const [kind, panel] of Object.entries(kinds)) if (panel.preset) addSection(panel.preset.section, panel.label({ kind }));
  for (const [kind, panel] of Object.entries(kinds)) if (panel.preset?.flightSection) addSection(flightSection(panel.preset.flightSection), `${panel.label({ kind })} flight`);

  let tab = EMITTER_TAB;
  let parts = 'device';
  let emitterId = null;
  let message = '';
  let confirming = null;

  /** The emitter the Emitter tab saves from and loads into: the one whose bookmark opened it while it exists, else the selected one. */
  function currentEmitter() {
    const chosen = emitterOf(state.scene, emitterId);
    if (chosen) return chosen;
    return state.selection.type === 'emitter' ? emitterOf(state.scene, state.selection.id) ?? null : null;
  }

  /** A follower's path comes from the tect it follows, so it has no flight of its own to save or load. */
  const flies = (emitter, preset) => Boolean(preset?.takeFlight && !emitter.follows);

  function slot() {
    if (tab === ENVIRONMENT_PRESETS) {
      return {
        section: ENVIRONMENT_PRESETS,
        take: scene => ({ values: environmentValues(scene) }),
        give: (scene, { values }) => withEnvironment(scene, values),
        pick: (from, into) => { into.air = from.air; into.ground = from.ground; }
      };
    }
    const emitter = currentEmitter();
    const preset = presetOf(emitter);
    if (!preset) return null;
    const id = emitter.id;
    const own = scene => emitterOf(scene, id);
    return {
      section: parts === 'flight' ? flightSection(preset.flightSection) : preset.section,
      deviceSection: preset.section,
      flightSection: flies(emitter, preset) ? flightSection(preset.flightSection) : null,
      take: scene => structuredClone({
        ...(parts !== 'flight' ? { values: preset.take(own(scene)) } : {}),
        ...(parts !== 'device' ? { flight: preset.takeFlight(own(scene)) } : {})
      }),
      give: (scene, { values, flight }) => {
        if (values) preset.give(own(scene), values);
        if (flight) preset.giveFlight(own(scene), flight);
        return scene;
      },
      pick: (from, into) => { const index = into.emitters.findIndex(item => item.id === id); into.emitters[index] = own(from); }
    };
  }

  /** A device preset loads into its own kind's section, a flight into its flight section, and both only where both fit. */
  function loadable(preset, section) {
    const current = slot();
    if (!current || tab === ENVIRONMENT_PRESETS) return Boolean(current);
    if (section === current.flightSection) return true;
    return section === current.deviceSection && (!preset.flight || Boolean(current.flightSection));
  }

  const dialog = document.body.appendChild(Object.assign(node('dialog', 'presets-dialog'), { tabIndex: -1 }));
  dialog.setAttribute('aria-labelledby', 'presets-title');
  const fileInput = Object.assign(node('input'), { type: 'file', accept: 'application/json,.json', hidden: true });

  /** A preset's values are read as an opened scene's are, so a library from another version still loads. */
  function apply(preset) {
    const { give, pick } = slot();
    let read;
    try {
      read = readScene(give(structuredClone(state.scene), structuredClone({ values: preset.values, flight: preset.flight })));
    } catch (error) {
      message = error.message;
      render();
      return;
    }
    dialog.close();
    commit(scene => pick(read, scene));
  }

  function presetRow(preset, section) {
    const row = node('li');
    const loadButton = textButton(preset.name, () => apply(preset), 'preset-load');
    loadButton.disabled = !loadable(preset, section);
    if (preset.values && preset.flight) loadButton.append(node('span', 'preset-part', 'Both'));
    const deleting = confirming === `${section}\n${preset.name}`;
    let remove;
    if (deleting) {
      remove = textButton('Delete', () => { store(withoutPreset(load(), section, preset.name)); confirming = null; render(); }, 'preset-delete');
    } else {
      remove = node('button', 'icon-button preset-remove');
      remove.type = 'button';
      remove.title = `Delete ${preset.name}`;
      remove.setAttribute('aria-label', remove.title);
      remove.append(iconNode('fa-xmark'));
      remove.addEventListener('click', () => { confirming = `${section}\n${preset.name}`; render(); });
    }
    row.append(loadButton, remove);
    return row;
  }

  /** One save row under the list: the name, and for an emitter that flies, whether its device, its flight, or both. */
  function saveRow() {
    const current = slot();
    const holder = node('div', 'preset-save-area');
    if (tab === EMITTER_TAB && presetOf(currentEmitter())?.takeFlight) {
      if (!current.flightSection) parts = 'device';
      const choice = node('div', 'preset-parts');
      choice.setAttribute('role', 'radiogroup');
      choice.setAttribute('aria-label', 'Save');
      for (const [key, label] of PARTS) {
        const input = Object.assign(node('input'), { type: 'radio', name: 'preset-parts', checked: parts === key, disabled: key !== 'device' && !current.flightSection });
        input.addEventListener('change', () => { parts = key; render(); });
        const option = node('label', 'preset-part-choice');
        option.append(input, label);
        choice.append(option);
      }
      holder.append(choice);
    }
    const section = slot().section;
    const row = node('div', 'preset-save');
    const nameInput = Object.assign(node('input'), { type: 'text', maxLength: 64, id: 'preset-name' });
    nameInput.setAttribute('aria-label', 'Preset name');
    const existing = presetsIn(load(), section);
    const saveButton = textButton('Save', () => {
      const name = presetName(nameInput.value);
      if (!name) return;
      store(withPreset(load(), { section, name, ...slot().take(state.scene) }));
      message = '';
      render();
    });
    const sync = () => {
      const name = presetName(nameInput.value);
      saveButton.disabled = !name;
      saveButton.textContent = existing.some(preset => preset.name === name) ? 'Replace' : 'Save';
    };
    nameInput.addEventListener('input', sync);
    nameInput.addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveButton.click(); } });
    sync();
    row.append(nameInput, saveButton);
    holder.append(row);
    return holder;
  }

  function tabButton(key, label) {
    const button = textButton(label, () => { tab = key; message = ''; confirming = null; render(); }, 'preset-tab');
    button.setAttribute('role', 'tab');
    button.setAttribute('aria-selected', String(tab === key));
    return button;
  }

  /** The emitter's own device and flight sections first and loadable, the other kinds dimmed below, so the whole library shows. */
  function emitterBody(body) {
    const emitter = currentEmitter();
    const current = emitter ? slot() : null;
    const own = current ? [current.deviceSection, current.flightSection].filter(Boolean) : [];
    if (emitter) body.append(node('p', 'preset-target', emitter.name));
    const library = load();
    const sections = [...emitterSections].sort(([a], [b]) => (own.includes(a) ? own.indexOf(a) : own.length) - (own.includes(b) ? own.indexOf(b) : own.length));
    for (const [section, label] of sections) {
      const presets = presetsIn(library, section);
      if (!presets.length) continue;
      const group = node('section', own.includes(section) ? 'preset-group' : 'preset-group other');
      group.append(node('h3', '', label));
      const list = node('ul', 'preset-list');
      presets.forEach(preset => list.append(presetRow(preset, section)));
      group.append(list);
      body.append(group);
    }
    if (current) body.append(saveRow());
  }

  function environmentBody(body) {
    const list = node('ul', 'preset-list');
    presetsIn(load(), ENVIRONMENT_PRESETS).forEach(preset => list.append(presetRow(preset, ENVIRONMENT_PRESETS)));
    body.append(list, saveRow());
  }

  function render() {
    const header = node('header', 'details-header');
    const titleNode = node('h2', '', 'Presets');
    titleNode.id = 'presets-title';
    header.append(titleNode, textButton('Done', () => dialog.close(), 'primary'));
    const tabs = node('div', 'preset-tabs');
    tabs.setAttribute('role', 'tablist');
    tabs.append(tabButton(EMITTER_TAB, 'Emitter'), tabButton(ENVIRONMENT_PRESETS, 'Air and ground'));
    const body = node('div', 'presets-body');
    body.setAttribute('role', 'tabpanel');
    if (tab === EMITTER_TAB) emitterBody(body); else environmentBody(body);
    if (message) body.append(node('p', 'preset-message', message));
    const footer = node('footer', 'export-actions');
    footer.append(
      textButton('Import library…', () => fileInput.click()),
      textButton('Export library…', () => download(`${tect}-presets.json`, new Blob([`${JSON.stringify(load(), null, 2)}\n`], { type: 'application/json' })))
    );
    dialog.replaceChildren(header, tabs, body, footer, fileInput);
  }

  fileInput.addEventListener('change', async () => {
    const [file] = fileInput.files;
    fileInput.value = '';
    if (!file) return;
    try {
      const incoming = readLibrary(JSON.parse(await file.text()), tect);
      store(mergedLibraries(load(), incoming));
      message = `${incoming.presets.length} ${incoming.presets.length === 1 ? 'preset' : 'presets'} from ${file.name}`;
    } catch (error) {
      message = error instanceof SyntaxError ? `${file.name} is not a ${title} preset library.` : error.message;
    }
    render();
  });

  function open(next) {
    tab = next === ENVIRONMENT_PRESETS ? ENVIRONMENT_PRESETS : EMITTER_TAB;
    emitterId = next === ENVIRONMENT_PRESETS ? null : next;
    parts = 'device';
    message = '';
    confirming = null;
    render();
    dialog.showModal();
    dialog.focus();
  }

  /** Only an emitter whose kind gives its device as a preset has the button; it opens the window on its own tab. */
  function button(next) {
    if (next !== ENVIRONMENT_PRESETS && !presetOf(emitterOf(state.scene, next))) return null;
    const element = node('button', 'icon-button dice-button');
    element.type = 'button';
    element.title = 'Presets';
    element.setAttribute('aria-label', 'Presets');
    element.setAttribute('aria-haspopup', 'dialog');
    element.append(iconNode('fa-bookmark'));
    element.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); open(next); });
    element.addEventListener('keydown', event => event.stopPropagation());
    return element;
  }

  return { button };
}
