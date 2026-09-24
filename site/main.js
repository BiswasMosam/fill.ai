// Fill.ai download page: copy buttons, a note for browsers that can't run
// the extension, and sections that ease in as they scroll into view.

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(btn.dataset.copy);
      btn.textContent = 'Copied';
    } catch {
      btn.textContent = 'Select it';
    }
    clearTimeout(btn.timer);
    btn.timer = setTimeout(() => (btn.textContent = 'Copy'), 1600);
  });
});

// Chrome, Edge and Brave on a computer can load Fill.ai. Everything else
// (phones, Firefox, Safari) gets told so before downloading a zip it can't use.
const ua = navigator.userAgentData;
const chromium = !!ua?.brands?.some((b) => /Chromium|Google Chrome|Microsoft Edge|Brave/.test(b.brand));
const mobile = ua ? ua.mobile : /Android|iPhone|iPad/i.test(navigator.userAgent);
if (!chromium || mobile) document.querySelector('.browser-note').hidden = false;

const items = document.querySelectorAll('[data-reveal]');
if ('IntersectionObserver' in window && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        e.target.classList.add('in');
        io.unobserve(e.target);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  items.forEach((el) => io.observe(el));
} else {
  items.forEach((el) => el.classList.add('in'));
}
