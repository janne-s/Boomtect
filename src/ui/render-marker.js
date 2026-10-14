/**
 * Marks a render in progress in persistent storage. A browser that stops the page, as when it runs
 * out of memory, runs no code, so the mark outlives it: the next start finds it and does not begin
 * the same render again by itself. Ending the page normally clears it.
 */
export function createRenderMarker(storage, key) {
  let current = null;
  const write = () => {
    try { storage.setItem(key, JSON.stringify(current)); } catch { /* Without storage there is no mark to find. */ }
  };
  return {
    /** Records the phase now running, with what was known when the render began. */
    phase(text, details = {}) {
      if (text === null) {
        current = null;
        try { storage.removeItem(key); } catch { /* Nothing was stored. */ }
        return;
      }
      if (current?.phase === text && !Object.keys(details).length) return;
      current = { ...current, ...details, phase: text };
      write();
    },
    /** Writes the mark again, for a page restored after the browser hid it. */
    restore() { if (current) write(); },
    /** Clears the stored mark but remembers it, for a page the browser hides normally. */
    suspend() {
      try { storage.removeItem(key); } catch { /* Nothing was stored. */ }
    },
    /** The mark a previous page left, removed so that it is reported once. */
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
      } catch { return {}; /* A broken mark still means the last render did not finish. */ }
    }
  };
}

/** A short description of an unfinished render's mark, from whatever fields it still has. */
export function unfinishedRenderText(mark) {
  const parts = [];
  if (typeof mark.phase === 'string' && mark.phase) parts.push(mark.phase);
  if (Number.isFinite(mark.sources)) parts.push(`${mark.sources.toLocaleString('en')} point sources`);
  if (mark.preview === true) parts.push('Preview');
  return `The last render did not finish${parts.length ? ` (${parts.join(', ')})` : ''}`;
}
