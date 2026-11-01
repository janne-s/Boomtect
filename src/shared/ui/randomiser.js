import { createRandom, newSeed } from '../domain/random.js';
import { lockKey, RANDOMISE, randomiseControls, randomiseEnvironment } from '../domain/randomise.js';

export const ENVIRONMENT = 'environment';

function icon(name) {
  const node = document.createElement('i');
  node.className = `fa-solid ${name}`;
  node.setAttribute('aria-hidden', 'true');
  return node;
}

function iconButton(className, name, title, onClick) {
  const node = document.createElement('button');
  node.type = 'button';
  node.className = className;
  node.title = title;
  node.setAttribute('aria-label', title);
  node.append(icon(name));
  node.addEventListener('click', event => { event.preventDefault(); event.stopPropagation(); onClick(); });
  node.addEventListener('keydown', event => event.stopPropagation());
  return node;
}

export function createRandomiser({ state, commit, controlsOf, upperWind, savePreferences, refreshPanel }) {
  const rolls = [];
  const preferences = () => state.preferences;
  const amount = () => preferences().randomAmount ?? RANDOMISE.defaultAmount;
  const locks = () => preferences().randomLockStates ?? {};
  const locked = section => control => locks()[lockKey(section, control)] ?? Boolean(control.lockedByDefault);
  const ownRolls = () => rolls.filter(roll => roll.mode === state.scene.mode);
  const rolled = target => ownRolls().some(roll => roll.parts.has(target));

  function rollInto(scene, target, random) {
    if (target === ENVIRONMENT) {
      const before = structuredClone({ air: scene.air, ground: scene.ground });
      randomiseEnvironment(scene, { upperWind: upperWind(scene), random, amount: amount(), locked: locked(ENVIRONMENT) });
      return before;
    }
    const emitter = scene.emitters.find(item => item.id === target);
    const before = structuredClone(emitter);
    randomiseControls(emitter, controlsOf(emitter, scene), { random, amount: amount(), locked: locked(emitter.kind) });
    return before;
  }

  function roll(targets) {
    const random = createRandom(newSeed());
    const entry = { mode: state.scene.mode, parts: new Map() };
    rolls.push(entry);
    if (rolls.length > RANDOMISE.historyLength) rolls.shift();
    commit(scene => { for (const target of targets) entry.parts.set(target, rollInto(scene, target, random)); });
    if (!entry.parts.size) rolls.splice(rolls.indexOf(entry), 1);
  }

  function restore(scene, target, before) {
    if (target === ENVIRONMENT) { scene.air = before.air; scene.ground = before.ground; return; }
    const index = scene.emitters.findIndex(item => item.id === target);
    if (index >= 0) scene.emitters[index] = before;
  }

  function back(target = null) {
    const roll = ownRolls().findLast(candidate => target === null || candidate.parts.has(target));
    if (!roll) return;
    const parts = target === null ? [...roll.parts] : [[target, roll.parts.get(target)]];
    for (const [key] of parts) roll.parts.delete(key);
    if (!roll.parts.size) rolls.splice(rolls.indexOf(roll), 1);
    commit(scene => { for (const [key, before] of parts) restore(scene, key, before); });
  }

  const allTargets = () => [...state.scene.emitters.filter(emitter => emitter.enabled).map(emitter => emitter.id), ENVIRONMENT];

  function diceButtons(target) {
    const holder = document.createElement('span');
    holder.className = 'dice-buttons';
    holder.append(iconButton('icon-button dice-button', 'fa-dice', 'Randomise', () => roll([target])));
    if (rolled(target)) holder.append(iconButton('icon-button dice-button', 'fa-arrow-rotate-left', 'Previous roll', () => back(target)));
    return holder;
  }

  function toggleLock(section, control) {
    preferences().randomLockStates = { ...locks(), [lockKey(section, control)]: !locked(section)(control) };
    savePreferences();
    refreshPanel();
  }

  function lockCell(label, section, control) {
    if (!preferences().showLocks) return label;
    const on = locked(section)(control);
    const cell = document.createElement('span');
    cell.className = 'lockable';
    if (label.parentNode) label.replaceWith(cell);
    const lock = iconButton('lock-button', on ? 'fa-lock' : 'fa-lock-open', `${on ? 'Unlock' : 'Lock'} ${control.label}`, () => toggleLock(section, control));
    lock.setAttribute('aria-pressed', String(on));
    cell.append(lock, label);
    return cell;
  }

  function menu(trigger) {
    const node = document.body.appendChild(Object.assign(document.createElement('div'), { id: 'randomise-menu', className: 'link-menu randomise-menu', popover: 'auto', tabIndex: -1 }));
    node.setAttribute('aria-label', 'Randomise');
    trigger.popoverTargetElement = node;
    const action = (text, name, onClick, disabled = false) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.disabled = disabled;
      item.append(icon(name), document.createTextNode(text));
      item.addEventListener('click', () => { onClick(); render(); });
      return item;
    };
    function render() {
      const amountRow = document.createElement('label');
      amountRow.className = 'randomise-amount';
      const slider = Object.assign(document.createElement('input'), { type: 'range', min: '5', max: '100', step: '5', value: String(Math.round(amount() * 100)) });
      const shown = document.createElement('span');
      const paint = () => {
        shown.textContent = `${slider.value} %`;
        slider.style.setProperty('--from', '0%');
        slider.style.setProperty('--to', `${(Number(slider.value) - 5) / 95 * 100}%`);
      };
      slider.addEventListener('input', paint);
      slider.addEventListener('change', () => { preferences().randomAmount = Number(slider.value) / 100; savePreferences(); });
      paint();
      amountRow.append(document.createTextNode('Amount'), slider, shown);
      const locksItem = action('Locks', 'fa-lock', () => { preferences().showLocks = !preferences().showLocks; savePreferences(); refreshPanel(); });
      locksItem.setAttribute('aria-pressed', String(Boolean(preferences().showLocks)));
      node.replaceChildren(
        action('Randomise all', 'fa-dice', () => roll(allTargets())),
        action('Previous roll', 'fa-arrow-rotate-left', () => back(), !ownRolls().length),
        document.createElement('hr'),
        amountRow,
        locksItem
      );
    }
    node.addEventListener('beforetoggle', event => {
      if (event.newState !== 'open') return;
      render();
      const anchor = trigger.getBoundingClientRect();
      node.style.top = `${anchor.bottom + 4}px`;
      node.style.right = `${Math.max(8, document.documentElement.clientWidth - anchor.right)}px`;
    });
    node.addEventListener('toggle', event => {
      trigger.setAttribute('aria-expanded', String(event.newState === 'open'));
      if (event.newState === 'open') node.focus({ preventScroll: true });
    });
    node.addEventListener('keydown', event => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      node.hidePopover();
      trigger.focus({ preventScroll: true });
    });
  }

  return { diceButtons, lockCell, menu };
}
