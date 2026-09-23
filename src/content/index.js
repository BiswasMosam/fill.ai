// Injected into every frame of the tab when fill.ai is opened. Exposes a small
// API on the extension's isolated-world `window` for the background to call
// through chrome.scripting, and owns the panel in the top frame.

import { scanPage, pageContext } from './scan.js';
import { fillMany, undoMany, markMany, clearMarks, focusField } from './fill.js';
import { Panel } from './panel.js';

(() => {
  const existing = window.__fillai;
  // After the extension reloads, the old copy is orphaned (chrome.runtime.id
  // goes away). Replace it rather than trusting it.
  if (existing && existing.alive()) return;
  existing?.teardown?.();

  let panel = null;
  const isTop = window.top === window;

  window.__fillai = {
    alive: () => {
      try {
        return !!chrome.runtime?.id;
      } catch {
        return false;
      }
    },
    scan: async () => ({ fields: await scanPage(), context: isTop ? pageContext() : null, url: location.href }),
    fill: (items) => fillMany(items),
    undo: (ids) => undoMany(ids),
    mark: (marks) => markMany(marks),
    clearMarks: () => clearMarks(),
    focus: (id) => focusField(id),
    togglePanel: () => {
      if (!isTop) return;
      panel = panel || new Panel();
      panel.toggle();
    },
    teardown: () => {
      clearMarks();
      panel?.host?.remove();
    },
  };
})();
