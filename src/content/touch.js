// Loaded into every page from the start. Its only job is to notice which
// form fields the person changes by hand, so that when Fill.ai opens it can
// keep those answers as they are and remember them. It records which
// elements were touched, never what was typed, and keeps nothing after the
// page closes.

(() => {
  if (window.__fillaiTouch) return;
  const touched = new WeakSet();

  const EDITABLE = 'input, textarea, select, [contenteditable=""], [contenteditable="true"], [role="textbox"], [role="combobox"]';
  const CHOICE = '[role="radio"], [role="checkbox"], [role="switch"], [role="option"], [role="listbox"], [role="combobox"], [aria-haspopup="listbox"]';
  // Select2, Chosen and friends draw their own box next to a hidden <select>.
  const WIDGET = '.select2-container, .chosen-container, .ts-wrapper, .selectize-control, .choices, .bootstrap-select';

  function targetOf(e) {
    const t = e.composedPath?.()[0] || e.target;
    return t instanceof Element ? t : t?.parentElement || null;
  }

  function markWidget(t) {
    const box = t.closest(WIDGET);
    if (!box) return;
    const select = box.previousElementSibling?.tagName === 'SELECT' ? box.previousElementSibling : box.querySelector('select');
    if (select) touched.add(select);
  }

  // Typing and native selects, radios and checkboxes all end in input/change.
  const onEdit = (e) => {
    if (!e.isTrusted) return;
    const t = targetOf(e);
    const control = t?.closest(EDITABLE);
    if (control) touched.add(control);
  };

  // Custom choices (Google Forms radios and dropdowns, Select2) only get
  // clicks. Clicking into a text box is not a change, so it doesn't count.
  const onClick = (e) => {
    if (!e.isTrusted) return;
    const t = targetOf(e);
    if (!t) return;
    const choice = t.closest(CHOICE);
    if (choice) {
      touched.add(choice);
      const list = choice.closest('[role="listbox"]');
      if (list) touched.add(list);
      const group = choice.closest('[role="radiogroup"], [role="group"], [role="list"]');
      if (group) touched.add(group);
      // An option in a popup menu belongs to whatever opened it (react-select's
      // search box points at its menu with aria-controls).
      if (choice.getAttribute('role') === 'option') {
        for (let n = choice; n && n !== document.body; n = n.parentElement) {
          if (!n.id) continue;
          const id = CSS.escape(n.id);
          for (const c of document.querySelectorAll(`[aria-controls~="${id}"], [aria-owns~="${id}"]`)) touched.add(c);
        }
      }
    }
    markWidget(t);
  };

  addEventListener('input', onEdit, true);
  addEventListener('change', onEdit, true);
  addEventListener('click', onClick, true);

  window.__fillaiTouch = { has: (el) => touched.has(el) };
})();
