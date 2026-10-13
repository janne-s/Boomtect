/** Clear this app's data only: GitHub Pages applications share an origin. */
export function clearAppStorage(storage, prefix) {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith(prefix)) storage.removeItem(key);
}

// Independent of app.js so recovery remains available after a startup failure.
if (typeof document !== 'undefined') {
  for (const button of document.querySelectorAll('[data-recovery-dialog]')) {
    button.addEventListener('click', () => setTimeout(() => {
      const dialog = document.getElementById(button.dataset.recoveryDialog);
      // Give the app's normal Settings handler the first chance to populate and open it.
      if (dialog && !dialog.open) {
        dialog.returnValue = 'cancel';
        dialog.showModal();
      }
    }, 0));
  }
  for (const button of document.querySelectorAll('[data-reset-app]')) {
    button.addEventListener('click', () => {
      const { resetApp, storagePrefix, sessionPrefix = storagePrefix } = button.dataset;
      if (!window.confirm(`Reset ${resetApp}? All scenes and settings saved in this browser will be removed. Exported files are kept.`)) return;
      try {
        window.dispatchEvent(new Event('app-reset'));
        clearAppStorage(window.localStorage, storagePrefix);
        clearAppStorage(window.sessionStorage, sessionPrefix);
        window.location.reload();
      } catch {
        window.alert(`${resetApp} could not clear its browser storage.`);
      }
    });
  }
}
