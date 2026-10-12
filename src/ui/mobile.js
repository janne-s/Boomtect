/**
 * The phone layout (styles.css, below MOBILE_QUERY's width): the scene fills the screen, the panel's
 * sections open one at a time as full-screen sheets from the tab bar, the plots fold into a strip
 * that opens over the scene, and what the scene's corners tell about the selection and the listening
 * microphone opens from a chip. The desktop layout is untouched by it.
 */

const MOBILE_QUERY = '(max-width: 700px)';

const SHEET_TITLES = Object.freeze({
  emitters: 'Emitters',
  receivers: 'Microphones',
  environment: 'Air and ground',
  terrain: 'Terrain',
  output: 'Output'
});

const EMITTER_ICONS = Object.freeze({ thunder: 'fa-bolt', blast: 'fa-explosion', sonic: 'fa-jet-fighter' });

const $ = id => document.getElementById(id);

export function createMobileLayout({ onResults }) {
  const media = window.matchMedia(MOBILE_QUERY);
  const body = document.body;
  const panel = document.querySelector('aside.panel');

  function openSheet(name) {
    if (body.dataset.sheet === name) { closeSheet(); return; }
    body.dataset.sheet = name;
    $('sheet-title').textContent = SHEET_TITLES[name];
    const target = panel.querySelector(`[data-sheet="${name}"]`);
    if (target instanceof HTMLDetailsElement) target.open = true;
    panel.scrollTop = 0;
    syncTabs();
  }

  function closeSheet() {
    delete body.dataset.sheet;
    syncTabs();
  }

  function syncTabs() {
    document.querySelectorAll('.sheet-tabs [data-sheet]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.sheet === body.dataset.sheet)));
  }

  document.querySelectorAll('.sheet-tabs [data-sheet]').forEach(button => button.addEventListener('click', () => openSheet(button.dataset.sheet)));
  $('sheet-close').addEventListener('click', closeSheet);

  // The header's file actions, which the phone's header has no room for, are in the Output sheet.
  document.querySelectorAll('.sheet-files [data-proxy]').forEach(button => {
    const original = $(button.dataset.proxy);
    button.addEventListener('click', () => original.click());
    const sync = () => { button.disabled = original.disabled; };
    new MutationObserver(sync).observe(original, { attributes: true, attributeFilter: ['disabled'] });
    sync();
  });

  // The rendering and playback switches stand with the view's switches on a phone.
  const toggles = document.querySelector('.bar .icon-toggles');
  const home = document.createComment('rendering switches');
  toggles.before(home);
  const place = () => {
    if (media.matches) document.querySelector('.view-side').prepend(toggles);
    else home.after(toggles);
    toggles.classList.toggle('view-tools', media.matches);
    if (!media.matches) { closeSheet(); setResults(false); }
  };
  media.addEventListener('change', place);
  place();

  function setResults(open) {
    body.classList.toggle('results-open', open);
    $('results-toggle').setAttribute('aria-expanded', String(open));
    $('results-toggle').setAttribute('aria-pressed', String(open));
    requestAnimationFrame(() => onResults());
  }
  $('results-toggle').addEventListener('click', () => setResults(!body.classList.contains('results-open')));

  const info = $('info-dialog');
  $('cube-chip').addEventListener('click', () => {
    info.showModal();
    info.focus();
  });
  $('info-close').addEventListener('click', () => info.close());

  return {
    update({ mode, name, selected }) {
      if (selected) body.dataset.selected = selected; else delete body.dataset.selected;
      document.querySelectorAll('.emitter-icon').forEach(icon => { icon.className = `fa-solid ${EMITTER_ICONS[mode]} emitter-icon`; });
      $('cube-chip-name').textContent = name;
      $('info-title').textContent = name;
      const sections = [$('cube-selected'), $('cube-listen')].filter(source => source.childElementCount).map(source => {
        const section = document.createElement('div');
        section.className = 'info-section';
        section.append(...[...source.children].map(child => child.cloneNode(true)));
        return section;
      });
      $('info-body').replaceChildren(...sections);
    },
    mobile: () => media.matches
  };
}
