/** A stopped page runs no code, so the mark outlives it and the next start does not repeat the render. */
export function createRenderMarker(storage, key) {
  let current = null;
  const write = () => {
    try { storage.setItem(key, JSON.stringify(current)); } catch {}
  };
  return {
    phase(text, details = {}) {
      if (text === null) {
        current = null;
        try { storage.removeItem(key); } catch {}
        return;
      }
      if (current?.phase === text && !Object.keys(details).length) return;
      current = { ...current, ...details, phase: text };
      write();
    },
    note(details) {
      if (!current) return;
      current = { ...current, ...details };
      write();
    },
    held: () => current,
    restore() { if (current) write(); },
    suspend() {
      try { storage.removeItem(key); } catch {}
    },
    take() {
      let text;
      try {
        text = storage.getItem(key);
        if (text !== null) storage.removeItem(key);
      } catch { return null; }
      if (text === null) return null;
      try {
        const found = JSON.parse(text);
        return found && typeof found === 'object' ? found : {};
      } catch { return {}; }
    }
  };
}

const counted = (count, word) => `${count.toLocaleString('en')} ${word}${count === 1 ? '' : 's'}`;

/** What the render held when it stopped: point sources while tracing, then the sound's length and channels. */
export function renderLoadText(mark) {
  const parts = [];
  if (typeof mark.phase === 'string' && mark.phase) parts.push(mark.phase);
  if (Number.isFinite(mark.seconds)) {
    parts.push(`${Math.round(mark.seconds).toLocaleString('en')} s`);
    if (Number.isFinite(mark.channels)) parts.push(counted(mark.channels, 'channel'));
  } else if (Number.isFinite(mark.sources)) parts.push(counted(mark.sources, 'point source'));
  if (mark.preview === true) parts.push('Preview');
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export function unfinishedRenderText(mark) {
  return mark.hidden === true
    ? `The last render stopped while the page was in the background${renderLoadText(mark)}`
    : `This device ran out of memory during the last render${renderLoadText(mark)}`;
}
