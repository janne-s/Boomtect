export function createActionMenu(trigger, readItems) {
  const menu = document.body.appendChild(Object.assign(document.createElement('div'), {
    id: 'actions-menu', className: 'link-menu actions-menu', popover: 'auto', tabIndex: -1
  }));
  menu.setAttribute('role', 'menu');
  menu.setAttribute('aria-label', 'Actions');
  trigger.popoverTargetElement = menu;

  const open = () => menu.matches(':popover-open');
  const buttons = () => [...menu.querySelectorAll('button:not(:disabled)')];

  function position() {
    const anchor = trigger.getBoundingClientRect();
    menu.style.top = `${anchor.bottom + 4}px`;
    menu.style.right = `${Math.max(8, document.documentElement.clientWidth - anchor.right)}px`;
  }

  function render() {
    const focused = menu.contains(document.activeElement) ? document.activeElement.dataset.action : null;
    menu.replaceChildren(...readItems().map(item => {
      if (item.separator) return document.createElement('hr');
      const node = document.createElement(item.heading ? 'div' : 'button');
      node.textContent = item.heading ?? item.label;
      if (item.heading) { node.className = 'actions-heading'; return node; }
      node.type = 'button';
      node.dataset.action = item.id;
      node.disabled = Boolean(item.disabled);
      node.title = item.title ?? '';
      node.setAttribute('role', 'menuitem');
      node.addEventListener('click', () => { menu.hidePopover(); item.action(); });
      return node;
    }));
    if (focused) (buttons().find(node => node.dataset.action === focused) ?? buttons()[0] ?? menu).focus({ preventScroll: true });
  }

  menu.addEventListener('beforetoggle', event => {
    if (event.newState === 'open') { render(); position(); }
  });
  menu.addEventListener('toggle', () => {
    trigger.setAttribute('aria-expanded', String(open()));
    if (open()) (buttons()[0] ?? menu).focus({ preventScroll: true });
  });
  menu.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      menu.hidePopover();
      trigger.focus({ preventScroll: true });
      return;
    }
    const list = buttons();
    if (!list.length) return;
    const index = list.indexOf(document.activeElement);
    const next = { ArrowDown: (index + 1) % list.length, ArrowUp: index < 0 ? list.length - 1 : (index - 1 + list.length) % list.length, Home: 0, End: list.length - 1 }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    list[next].focus({ preventScroll: true });
  });
  window.addEventListener('resize', () => {
    if (!open()) return;
    if (!trigger.getClientRects().length) menu.hidePopover(); else position();
  });

  return { refresh() { if (open()) render(); } };
}
