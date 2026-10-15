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

export function unfinishedRenderText(mark) {
  const parts = [];
  if (typeof mark.phase === 'string' && mark.phase) parts.push(mark.phase);
  if (Number.isFinite(mark.sources)) parts.push(`${mark.sources.toLocaleString('en')} point sources`);
  if (mark.preview === true) parts.push('Preview');
  return `The last render did not finish${parts.length ? ` (${parts.join(', ')})` : ''}`;
}
