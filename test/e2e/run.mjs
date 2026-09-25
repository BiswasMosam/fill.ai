// End-to-end: loads the real extension (dist-test) into Chrome, points it at
// the mock AI server, and drives the panel on fixture forms the way a person
// would. The main run uses the default AI (Ollama); Gemini and Claude answer
// the same form once each. Run with `npm run e2e` (HEADFUL=1 to watch).

import puppeteer from 'puppeteer-core';
import path from 'node:path';
import { mkdirSync, readFileSync } from 'node:fs';
import { startServer, requests } from './server.mjs';
import { chromePath } from './chrome.mjs';
import { PROFILE } from '../fixtures/profile.mjs';

const PORT = 4455;
const BASE = `http://127.0.0.1:${PORT}`;
const OUT = path.resolve('test/e2e/out');
mkdirSync(OUT, { recursive: true });

let failures = 0;
function check(name, cond, detail = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${name}${!cond && detail !== '' ? `   got: ${JSON.stringify(detail)}` : ''}`);
  if (!cond) failures += 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = await startServer(PORT);
const browser = await puppeteer.launch({
  executablePath: chromePath(),
  headless: !process.env.HEADFUL,
  enableExtensions: [path.resolve('dist-test')],
  pipe: true,
  defaultViewport: { width: 1360, height: 900 },
  args: ['--window-size=1360,1000'],
});

try {
  const swTarget = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background.js'), { timeout: 20000 });
  const sw = await swTarget.worker();
  const extId = new URL(swTarget.url()).host;

  // A real PDF resume for the upload and profile-building paths. The LinkedIn
  // address exists only behind the link, as on most real resumes.
  const pdfPage = await browser.newPage();
  await pdfPage.setContent('<h1>Asha Rani Verma</h1><p>asha.verma@example.com · +91 98765 43210 · Pune · <a href="https://www.linkedin.com/in/asha-verma">LinkedIn</a></p><h2>Education</h2><p>B.Tech, Example Institute of Technology, 2022 to 2026</p>');
  const pdfPath = path.join(OUT, 'Asha_Verma_Resume.pdf');
  await pdfPage.pdf({ path: pdfPath, format: 'A4' });
  await pdfPage.close();
  const pdfB64 = readFileSync(pdfPath).toString('base64');

  const seed = (items) =>
    sw.evaluate(async (cfg) => {
      await chrome.storage.local.clear();
      await chrome.storage.local.set(cfg);
    }, items);
  const AI = {
    ollama: { provider: 'ollama', ollamaURL: BASE, ollamaModel: 'qwen3.5:4b' },
    gemini: { provider: 'gemini', geminiKey: 'test-gemini-key', geminiBaseURL: BASE },
    claude: { provider: 'claude', claudeKey: 'test-key', claudeBaseURL: BASE },
  };
  const fullSeed = (extra = {}, ai = 'ollama') =>
    seed({
      settings: { ...AI[ai], effort: 'high' },
      profile: PROFILE,
      facts: [],
      resumeFile: { name: 'Asha_Verma_Resume.pdf', type: 'application/pdf', size: 1000, data: pdfB64 },
      ...extra,
    });
  const storage = (key) => sw.evaluate(async (k) => (await chrome.storage.local.get(k))[k], key);
  async function storageUntil(key, pred, timeout = 5000) {
    const end = Date.now() + timeout;
    let value;
    do {
      value = await storage(key);
      if (pred(value)) return value;
      await sleep(100);
    } while (Date.now() < end);
    return value;
  }

  async function openPanel(page) {
    await page.bringToFront();
    await sw.evaluate((u) => globalThis.fillaiTest.openPanel(u), page.url());
  }
  async function waitPanel(page, what = 'results') {
    await page.waitForFunction(
      (w) => {
        const r = document.querySelector('#fillai-root')?.shadowRoot;
        if (!r) return false;
        if (w === 'results') return !!r.querySelector('.chips') || /went wrong|No form/.test(r.querySelector('.hero h2')?.textContent || '');
        return !!r.querySelector(w);
      },
      { timeout: 30000 },
      what,
    );
  }
  // The prompt and the form, read back out of whichever API was called.
  const systemOf = (r) => (r.provider === 'ollama' ? r.body.messages?.[0]?.content : r.provider === 'gemini' ? r.body.systemInstruction?.parts?.[0]?.text : r.body.system?.[0]?.text) || '';
  const userOf = (r) =>
    r.provider === 'ollama'
      ? r.body.messages.find((m) => m.role === 'user').content
      : r.provider === 'gemini'
        ? r.body.contents[0].parts.map((p) => p.text || '').join('')
        : r.body.messages[0].content.map((c) => c.text || '').join('');
  const formOf = (r) => JSON.parse(userOf(r).split('<form>\n')[1].split('\n</form>')[0]);
  const formRequests = () => requests.filter((r) => systemOf(r).startsWith('You fill in web forms'));
  const metaText = (page) => page.evaluate(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.meta').textContent);
  const panelText = (page) => page.evaluate(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.body').innerText);
  const panelAll = (page) => page.evaluate(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.body').textContent);
  // A card or row in the panel, found by the question it is about.
  const card = (page, label, sel = '[data-gid]') =>
    page.evaluateHandle(
      (l, s) => [...document.querySelector('#fillai-root').shadowRoot.querySelectorAll(s)].find((c) => c.querySelector('.q')?.textContent.trim().startsWith(l)),
      label,
      sel,
    );
  async function clickIn(handle, sel) {
    const target = await handle.evaluateHandle((c, s) => c.querySelector(s), sel);
    await target.asElement().click();
  }
  // Find and click in one synchronous step, so a re-render can't get between.
  const press = (page, label, sel, rowSel = '[data-gid]') =>
    page.evaluate(
      (l, s, r) => {
        const root = document.querySelector('#fillai-root').shadowRoot;
        const row = [...root.querySelectorAll(r)].find((c) => c.querySelector('.q')?.textContent.trim().startsWith(l));
        const target = row?.querySelector(s);
        if (!target) return false;
        target.click();
        return true;
      },
      label,
      sel,
      rowSel,
    );

  // ------------------------------------------------------------------ 1. job application form
  console.log('\nJob application form (native inputs, cross-origin iframe, traps)');
  await fullSeed();
  requests.length = 0;
  const page = await browser.newPage();
  page.on('dialog', (d) => d.accept());
  await page.goto(`${BASE}/fixtures/job-form.html`);
  await page.waitForFunction(() => document.getElementById('extra').contentDocument === null); // cross-origin frame attached
  await sleep(400);
  await openPanel(page);
  await waitPanel(page);
  await sleep(300);

  const v = await page.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    return {
      first: $('first').value,
      last: $('last').value,
      email: $('email').value,
      phone: $('phone').value,
      phoneState: window.__state.phone,
      city: $('city').value,
      cityState: window.__state.city,
      degree: $('degree').value,
      grad: $('grad').value,
      college: $('college').value,
      li: $('li').value,
      gh: $('gh').value,
      relocate: [...document.querySelectorAll('[name=relocate]')].find((r) => r.checked)?.value ?? null,
      skills: [...document.querySelectorAll('[name="skills[]"]:checked')].map((c) => c.value),
      k8s: $('k8s').value,
      notice: $('notice').value,
      why: $('why').value,
      cv: $('cv').files[0]?.name ?? null,
      gender: $('gender').value,
      consent: $('consent').checked,
      traps: [$('hp').value, $('hidden-phone').value, $('ghost').value, $('pw').value].join(''),
      submits: window.__submits || 0,
    };
  });
  check('first and last name', v.first === 'Asha' && v.last === 'Verma', [v.first, v.last]);
  check('email', v.email === 'asha.verma@example.com', v.email);
  check('phone reaches a React-style controlled input', v.phone === '+91 98765 43210' && v.phoneState === v.phone, [v.phone, v.phoneState]);
  check('city reaches a React-style controlled input', v.city === 'Pune' && v.cityState === 'Pune', [v.city, v.cityState]);
  check('degree select picks the matching option', v.degree === 'btech', v.degree);
  check('graduation year derived from the degree end date', v.grad === '2026', v.grad);
  check('college', v.college === 'Example Institute of Technology', v.college);
  check('LinkedIn and GitHub', v.li.includes('linkedin.com') && v.gh.includes('github.com'), [v.li, v.gh]);
  check('skills checkboxes match the profile only', JSON.stringify(v.skills) === '["python","react"]', v.skills);
  check('resume PDF attached to the upload field', v.cv === 'Asha_Verma_Resume.pdf', v.cv);
  check('invented Kubernetes answer was thrown out', v.k8s === '', v.k8s);
  check('relocation left for the person', v.relocate === null, v.relocate);
  check('notice period left for the person', v.notice === '', v.notice);
  check('draft not inserted without a click', v.why === '', v.why);
  check('gender never auto-filled', v.gender === '', v.gender);
  check('privacy consent never auto-ticked', v.consent === false);
  check('hidden, off-screen and password fields untouched', v.traps === '', v.traps);
  check('form was never submitted', v.submits === 0, v.submits);

  const frame = page.frames().find((f) => f.url().includes('frame.html'));
  const site = frame ? await frame.evaluate(() => document.getElementById('site').value) : null;
  check('field inside a cross-origin iframe filled', site === 'https://asha.example.dev', site);

  const req = formRequests()[0];
  const sentLabels = req ? formOf(req).fields.map((f) => f.label) : [];
  check('answered by the chosen local model', req?.provider === 'ollama' && req?.body.model === 'qwen3.5:4b', req?.body.model);
  check('Ollama is asked for JSON in the answers schema', req?.body.format?.properties?.answers?.type === 'array');
  check('context window sized to fit, temperature 0', req?.body.options?.num_ctx >= 8192 && req?.body.options?.temperature === 0, req?.body.options);
  check('Careful turns thinking on for a thinking model', req?.body.think === true, req?.body.think);
  check("extension Origin stripped, so Ollama's block never fires", req && req.headers.origin === undefined, req?.headers.origin);
  check('password field never sent to the AI', !sentLabels.some((l) => /password/i.test(l)), sentLabels);
  check('invisible trap fields never sent to the AI', sentLabels.filter((l) => /^(email|phone number|mobile number)$/i.test(l)).length === 1, sentLabels);
  check('iframe questions included in the same request', sentLabels.includes('Portfolio or personal website') && sentLabels.includes('Preferred way of working'), sentLabels);
  check('panel says the answers came from this computer', /qwen3\.5:4b on this computer/.test(await metaText(page)), await metaText(page));

  let text = await panelText(page);
  check('panel shows the counts', /filled/.test(text) && /need/.test(text), text.slice(0, 120));
  check('panel explains the rejected answer', /Kubernetes[\s\S]*Could not trace/.test(text));
  await page.screenshot({ path: path.join(OUT, '1-job-form-panel.png') });

  // Save & fill: answer once, remembered forever.
  const notice = await card(page, 'Notice period');
  await (await notice.evaluateHandle((c) => c.querySelector('input.in'))).asElement().type('30 days');
  await clickIn(notice, '[data-act=save]');
  await page.waitForFunction(() => document.getElementById('notice').value === '30 days', { timeout: 5000 }).catch(() => {});
  const facts = await storageUntil('facts', (f) => f?.length > 0);
  check('Save & fill puts the answer in the page', (await page.$eval('#notice', (e) => e.value)) === '30 days');
  check('Save & fill remembers it', facts?.some((f) => f.question === 'Notice period' && f.answer === '30 days'), facts);

  // Fill once on a choice question: into the page, not into memory.
  const relocate = await card(page, 'Are you willing to relocate');
  await (await relocate.evaluateHandle((c) => [...c.querySelectorAll('.opt span')].find((s) => s.textContent === 'Yes'))).asElement().click();
  await clickIn(relocate, '[data-act=once]');
  await page.waitForFunction(() => document.querySelector('[name=relocate][value=yes]').checked, { timeout: 5000 }).catch(() => {});
  check('Fill once ticks the radio', await page.$eval('[name=relocate][value=yes]', (e) => e.checked));
  check('Fill once does not remember', !(await storage('facts')).some((f) => /relocate/i.test(f.question)));

  // Half-typed answers must survive the panel re-rendering around them.
  const k8s = await card(page, 'Years of experience with Kubernetes');
  await (await k8s.evaluateHandle((c) => c.querySelector('input.in'))).asElement().type('0');

  await page.evaluate(() => {
    window.__focusLog = [];
    const d = (e) => { const t = e.composedPath()[0]; return `${e.type}:${t.tagName}${t.id ? '#' + t.id : ''}${t.className && typeof t.className === 'string' ? '.' + t.className.split(' ')[0] : ''}@${Math.round(performance.now())}`; };
    document.addEventListener('focusin', (e) => window.__focusLog.push(d(e)), true);
    document.addEventListener('focusout', (e) => window.__focusLog.push(d(e)), true);
  });
  // Draft: inserted only on request.
  check('Insert button found', await press(page, 'Why do you want to join Orbit', '[data-act=insert]'));
  await page.waitForFunction(() => document.getElementById('why').value.length > 20, { timeout: 5000 }).catch(() => {});
  check('Insert puts the draft in', (await page.$eval('#why', (e) => e.value)).startsWith('I build things'));
  // Wait for the panel to re-render with the draft moved to Filled.
  await page.waitForFunction(() => /Filled[\s\S]*Why do you want to join Orbit/i.test(document.querySelector('#fillai-root').shadowRoot.querySelector('.body').textContent), { timeout: 5000 }).catch(() => {});
  await sleep(100);
  const kept = await page.evaluate(() => {
    const root = document.querySelector('#fillai-root').shadowRoot;
    const c = [...root.querySelectorAll('[data-gid]')].find((x) => x.querySelector('.q')?.textContent.startsWith('Years of experience'));
    return { value: c?.querySelector('input.in')?.value, focused: root.activeElement === c?.querySelector('input.in'), docActive: document.activeElement?.id || document.activeElement?.tagName, rootActive: root.activeElement?.outerHTML?.slice(0, 80) };
  });
  if (!kept.focused) kept.log = await page.evaluate(() => window.__focusLog);
  check('typing in another card survives the re-render', kept.value === '0' && kept.focused, kept);

  // Undo a filled field, including React-style state.
  check('Undo button found', await press(page, 'Current city', '[data-act=undo]', '.frow'));
  await page.waitForFunction(() => document.getElementById('city').value === '' && window.__state.city === '', { timeout: 5000 }).catch(() => {});
  check('Undo restores the original value', (await page.evaluate(() => [document.getElementById('city').value, window.__state.city].join('|'))) === '|');
  await page.waitForFunction(() => /Needs you[\s\S]*Current city/i.test(document.querySelector('#fillai-root').shadowRoot.querySelector('.body').innerText), { timeout: 5000 }).catch(() => {});
  text = await panelText(page);
  check('undone field moves back to Needs you', /Needs you[\s\S]*Current city/i.test(text), text.slice(0, 300));

  // Move it out of the way, shrink it, bring it back.
  const bar = await page.evaluateHandle(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.bar'));
  const box = await bar.asElement().boundingBox();
  await page.mouse.move(box.x + 60, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x - 300, box.y + 260, { steps: 8 });
  await page.mouse.up();
  const moved = await bar.asElement().boundingBox();
  check('panel can be dragged', Math.abs(moved.x - (box.x - 360)) < 4 && Math.abs(moved.y - (box.y + 260 - box.height / 2)) < 4, [box.x, box.y, moved.x, moved.y]);
  check('dragged position is remembered', !!(await storage('panelPos')));
  await clickIn(await page.evaluateHandle(() => document.querySelector('#fillai-root').shadowRoot), '[data-act=min]');
  const pill = await page.evaluate(() => {
    const r = document.querySelector('#fillai-root').shadowRoot;
    return { pill: !r.querySelector('.pill').hidden, panel: !r.querySelector('.panel').hidden, badge: r.querySelector('.badge').textContent };
  });
  check('shrinks to a pill with a count of what needs you', pill.pill && !pill.panel && Number(pill.badge) > 0, pill);
  await sleep(400); // let the pill finish its entrance
  await page.screenshot({ path: path.join(OUT, '2-job-form-pill.png') });
  await clickIn(await page.evaluateHandle(() => document.querySelector('#fillai-root').shadowRoot), '.pill');
  check('pill opens the panel again', await page.evaluate(() => !document.querySelector('#fillai-root').shadowRoot.querySelector('.panel').hidden));
  check('still never submitted', (await page.evaluate(() => window.__submits || 0)) === 0);
  await page.screenshot({ path: path.join(OUT, '3-job-form-after.png') });

  // ------------------------------------------------------------------ 2. the saved answer is used next time
  console.log('\nSame form again: saved answers are used');
  const again = await browser.newPage();
  await again.goto(`${BASE}/fixtures/job-form.html?run=2`);
  await sleep(500);
  await openPanel(again);
  await waitPanel(again);
  await sleep(200);
  check('notice period filled from the saved answer', (await again.$eval('#notice', (e) => e.value)) === '30 days');
  const lastReq = formRequests().at(-1);
  check('saved answers travel in the profile prompt', systemOf(lastReq ?? {}).includes('"answer": "30 days"'));
  text = await panelAll(again);
  check('panel credits the saved answer', /Saved answer · Notice period/.test(text));
  await again.close();

  // ------------------------------------------------------------------ 3. Google Forms structure
  console.log('\nGoogle Forms style (ARIA radios, checkboxes, listbox, multi-page)');
  const DOB_FACT = { question: 'Date of Birth', answer: '2003-02-14', site: '', savedAt: '2026-09-01T00:00:00.000Z' };
  await fullSeed({ facts: [DOB_FACT] });
  requests.length = 0;
  const gf = await browser.newPage();
  await gf.goto(`${BASE}/fixtures/gforms.html`);
  // The person answers one question before opening Fill.ai.
  await gf.click('#hear-friend');
  await openPanel(gf);
  await waitPanel(gf);
  await sleep(400);
  const g = await gf.evaluate(() => ({
    name: document.querySelector('[aria-labelledby=h-name]').value,
    email: document.querySelector('[aria-labelledby=h-email]').value,
    year: document.querySelector('[aria-labelledby=h-year] [role=radio][aria-checked=true]')?.dataset.value ?? null,
    langs: [...document.querySelectorAll('[role=checkbox][aria-checked=true]')].map((c) => c.dataset.answerValue),
    country: document.querySelector('#country .lgbsse [role=option][aria-selected=true]')?.dataset.value ?? null,
    popupLeftOpen: [...document.querySelectorAll('.popup')].some((p) => p.style.display !== 'none'),
    hear: document.querySelector('[aria-labelledby=h-hear] [role=radio][aria-checked=true]')?.dataset.value ?? null,
    dob: document.querySelector('[aria-labelledby=h-dob]').value,
    more: document.querySelector('[aria-labelledby=h-else]').value,
  }));
  check('text questions', g.name === 'Asha Rani Verma' && g.email === 'asha.verma@example.com', [g.name, g.email]);
  check('ARIA radio choice clicked', g.year === 'Graduated', g.year);
  check('ARIA checkboxes ticked', JSON.stringify(g.langs) === '["English","Hindi"]', g.langs);
  check("dropdown that only opens from inside (Google's jsaction) picked", g.country === 'India' && !g.popupLeftOpen, [g.country, g.popupLeftOpen]);
  check('date question filled from a saved date', g.dob === '2003-02-14', g.dob);
  check('an answer the person gave first is left alone', g.hear === 'A friend', g.hear);
  let gFacts = await storageUntil('facts', (f) => f?.some((x) => /hear about/i.test(x.question)));
  check('and remembered as theirs', gFacts?.some((f) => f.question === 'How did you hear about us?' && f.answer === 'A friend' && f.how === 'typed'), gFacts);
  const gfReq = formRequests()[0];
  check('it is not even sent to the AI', gfReq && !formOf(gfReq).fields.some((f) => /hear about/i.test(f.label)), gfReq && formOf(gfReq).fields.map((f) => f.label));
  check('Google\'s "__other_option__" never shown as an option', !JSON.stringify(gfReq?.body ?? '').includes('__other_option__') && !(await panelAll(gf)).includes('__other_option__'));
  text = await panelText(gf);
  check('panel lists it under "You filled these" as remembered', /You filled these[\s\S]*How did you hear about us\?[\s\S]*Remembered/i.test(text), text.slice(-300));
  check('open question left as a draft', g.more === '');
  await gf.screenshot({ path: path.join(OUT, '4-gforms-panel.png') });

  // The reported bug: pick an option in the panel, "Save & fill", and the
  // Google Forms dropdown must actually take it.
  const batch = await card(gf, 'Preferred batch');
  await (await batch.evaluateHandle((c) => [...c.querySelectorAll('.opt span')].find((s) => s.textContent === 'Evening'))).asElement().click();
  await clickIn(batch, '[data-act=save]');
  await gf.waitForFunction(() => document.querySelector('#batch .lgbsse [role=option][aria-selected=true]')?.dataset.value === 'Evening', { timeout: 6000 }).catch(() => {});
  check('Save & fill picks the option in a Google Forms dropdown', (await gf.evaluate(() => document.querySelector('#batch .lgbsse [role=option][aria-selected=true]')?.dataset.value)) === 'Evening');
  gFacts = await storageUntil('facts', (f) => f?.some((x) => x.question === 'Preferred batch'));
  check('and remembers it', gFacts?.some((f) => f.question === 'Preferred batch' && f.answer === 'Evening'), gFacts);
  text = await panelText(gf);
  check('the card moves to Filled without an error', /Filled[\s\S]*Preferred batch/i.test(text) && !/Could not find that option/.test(text), text.slice(0, 400));

  await sleep(800); // Fill.ai holds the scroll position for a moment after filling
  await gf.click('#next');
  await waitPanel(gf, '.banner');
  check('new questions noticed after Next', /2 new questions/.test(await panelText(gf)), (await panelText(gf)).slice(0, 200));
  const banner = await gf.evaluateHandle(() => document.querySelector('#fillai-root').shadowRoot.querySelector('.banner'));
  await clickIn(banner, '[data-act=rescan]');
  await gf.waitForFunction(() => document.querySelector('[aria-labelledby=h-inst]').value !== '', { timeout: 20000 }).catch(() => {});
  const p2 = await gf.evaluate(() => [document.querySelector('[aria-labelledby=h-li]').value, document.querySelector('[aria-labelledby=h-inst]').value]);
  check('page two filled after "Fill them"', p2[0].includes('linkedin.com') && p2[1] === 'Example Institute of Technology', p2);
  await gf.screenshot({ path: path.join(OUT, '5-gforms-page2.png') });

  // ------------------------------------------------------------------ 3b. Select2 careers page
  console.log('\nCareers page built on Select2 and an input mask (where LinkedIn got "Indian")');
  await fullSeed({ facts: [DOB_FACT] });
  requests.length = 0;
  const cp = await browser.newPage();
  await cp.goto(`${BASE}/fixtures/careers.html`);
  await cp.waitForFunction(() => window.jQuery && document.querySelectorAll('.select2-container').length >= 5);
  // A few answers typed and picked by hand before Fill.ai is opened.
  await cp.type('#preferred', 'Ash');
  await cp.type('#last', 'Verma-Rao');
  await cp.click('#alt + .select2 .select2-selection');
  await cp.waitForSelector('.select2-results__option');
  const yes = await cp.evaluateHandle(() => [...document.querySelectorAll('.select2-results__option')].find((li) => li.textContent.trim() === 'Yes'));
  await yes.asElement().click();
  await sleep(200);
  await openPanel(cp);
  await waitPanel(cp);
  await sleep(500);
  const c = await cp.evaluate(() => {
    const $ = (id) => document.getElementById(id);
    const shown = (id) => $(id).nextElementSibling.querySelector('.select2-selection__rendered')?.textContent.replace('×', '').trim();
    return {
      li: $('li').value,
      first: $('first').value,
      preferred: $('preferred').value,
      last: $('last').value,
      alt: $('alt').value,
      country: [$('country').value, shown('country')],
      city: [$('city').value, shown('city')],
      airport: [$('airport').value, shown('airport')],
      base: $('base').value,
      nat: [...$('nat').selectedOptions].map((o) => o.value),
      natShown: $('nat').nextElementSibling.textContent,
      dob: $('dob').value,
      title: $('title').value,
      terms: $('terms').checked,
      submits: window.__submits || 0,
    };
  });
  const cReq = formRequests()[0];
  const cLabels = cReq ? formOf(cReq).fields.map((f) => f.label) : [];
  check('LinkedIn keeps its URL (nothing typed into it later)', c.li === 'https://www.linkedin.com/in/asha-verma-example', c.li);
  check("Select2's display box is not mistaken for a question", !cLabels.some((l) => /^(Dubai|India|Select an option|Mumbai)$/.test(l)) && cLabels.includes('Preferred work location'), cLabels);
  check('Select2 country set through its hidden select', c.country[0] === 'India' && c.country[1] === 'India', c.country);
  check('city picked from a list that only loaded after the country', c.city[0] === 'Pune' && c.city[1] === 'Pune', c.city);
  check('Select2 that only lists options once you type in it', c.airport[0] === 'Pune (PNQ)' && c.airport[1] === 'Pune (PNQ)', c.airport);
  check('Select2 multi-select (nationality)', JSON.stringify(c.nat) === '["Indian"]' && c.natShown.includes('Indian'), [c.nat, c.natShown]);
  check('date of birth goes through a 2-digit-year mask as 14/02/03', c.dob === '14/02/03', c.dob);
  check('empty questions still filled', c.first === 'Asha', c.first);
  check('typed answers left exactly as the person wrote them', c.preferred === 'Ash' && c.last === 'Verma-Rao' && c.alt === 'Yes', [c.preferred, c.last, c.alt]);
  check('and never sent to the AI', !cLabels.includes('Preferred first name') && !cLabels.includes('Last name'), cLabels);
  const cFacts = await storageUntil('facts', (f) => f?.length >= 4);
  const has = (q, a) => cFacts?.some((f) => f.question === q && f.answer === a && f.how === 'typed');
  check('what they typed is remembered', has('Preferred first name', 'Ash') && has('Last name', 'Verma-Rao') && has('Do you want to provide an alternate phone number?', 'Yes'), cFacts);
  check("what the site set by itself is not", !cFacts?.some((f) => /work location|email/i.test(f.question)), cFacts?.map((f) => f.question));
  check('Title (Mr/Ms) is a personal question, never guessed', c.title === '' && /Your call[\s\S]*Title/i.test(await panelText(cp)));
  check('terms never ticked, form never submitted', !c.terms && c.submits === 0, [c.terms, c.submits]);
  text = await panelText(cp);
  check('panel shows the kept answers as remembered', /You filled these[\s\S]*Preferred first name[\s\S]*Remembered/i.test(text), text.slice(-400));
  await cp.screenshot({ path: path.join(OUT, '8-careers-panel.png') });

  // Forget one of them from the panel.
  check('Forget button found', await press(cp, 'Preferred first name', '[data-act=forget]', '.frow'));
  const afterForget = await storageUntil('facts', (f) => !f?.some((x) => x.question === 'Preferred first name'));
  check('Forget removes it from memory', !afterForget?.some((f) => f.question === 'Preferred first name'), afterForget);
  await cp.waitForFunction(() => /Forgotten/.test(document.querySelector('#fillai-root').shadowRoot.querySelector('.body').innerText), { timeout: 4000 }).catch(() => {});
  check('and the panel says so', /Forgotten/.test(await panelText(cp)));
  await cp.close();

  // Next visit: the typed last name is used from memory.
  const cp2 = await browser.newPage();
  await cp2.goto(`${BASE}/fixtures/careers.html?run=2`);
  await cp2.waitForFunction(() => window.jQuery && document.querySelectorAll('.select2-container').length >= 5);
  await openPanel(cp2);
  await waitPanel(cp2);
  await sleep(400);
  const c2 = await cp2.evaluate(() => [document.getElementById('last').value, document.getElementById('alt').value, document.getElementById('preferred').value]);
  check('next time, the remembered answers fill the form', c2[0] === 'Verma-Rao' && c2[1] === 'Yes', c2);
  check('a forgotten answer is not used', c2[2] !== 'Ash', c2[2]);
  await cp2.close();

  // ------------------------------------------------------------------ 4. the other two AIs
  for (const ai of ['gemini', 'claude']) {
    console.log(`\nSame form with ${ai === 'gemini' ? 'Gemini' : 'Claude'}`);
    await fullSeed({}, ai);
    requests.length = 0;
    const p = await browser.newPage();
    await p.goto(`${BASE}/fixtures/job-form.html?run=${ai}`);
    await sleep(400);
    await openPanel(p);
    await waitPanel(p);
    await sleep(200);
    const got = await p.evaluate(() => [document.getElementById('first').value, document.getElementById('k8s').value, window.__submits || 0]);
    check('form filled, invented answer still thrown out, never submitted', got[0] === 'Asha' && got[1] === '' && got[2] === 0, got);
    const r = formRequests()[0];
    if (ai === 'gemini') {
      check('streams from the chosen Gemini model', r?.provider === 'gemini' && r.path === '/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse', r?.path);
      check('key sent only as the x-goog-api-key header', r?.headers['x-goog-api-key'] === 'test-gemini-key' && !/key=/.test(r?.path));
      check('asks for JSON in the answers schema', r?.body.generationConfig?.responseMimeType === 'application/json' && r?.body.generationConfig?.responseJsonSchema?.properties?.answers?.type === 'array');
      check('Careful maps to a high thinking level', r?.body.generationConfig?.thinkingConfig?.thinkingLevel === 'high', r?.body.generationConfig?.thinkingConfig);
      check('profile rides in the system instruction', systemOf(r ?? {}).includes('<profile>'));
      check('panel says Gemini free tier answered', /Gemini free tier/.test(await metaText(p)), await metaText(p));
    } else {
      check('request uses Claude Opus 5 with adaptive thinking', r?.body.model === 'claude-opus-5' && r?.body.thinking?.type === 'adaptive', r?.body.model);
      check('request asks for strict JSON output', r?.body.output_config?.format?.type === 'json_schema');
      check('request opts into server-side fallbacks', r?.body.fallbacks === 'default' && String(r?.headers['anthropic-beta']).includes('server-side-fallback-2026-07-01'), r?.headers['anthropic-beta']);
      check('profile prompt is marked for caching', r?.body.system?.[0]?.cache_control?.type === 'ephemeral');
      check('API key sent only as the x-api-key header', r?.headers['x-api-key'] === 'test-key');
      check('panel shows what the form cost', /about \$\d/.test(await metaText(p)), await metaText(p));
    }
    await p.close();
  }

  // ------------------------------------------------------------------ 5. setup nudges
  console.log('\nFirst run without setup');
  await seed({ settings: { ollamaURL: BASE } });
  const fresh = await browser.newPage();
  await fresh.goto(`${BASE}/fixtures/job-form.html?run=setup`);
  await openPanel(fresh);
  await waitPanel(fresh, '.hero .btn[data-act=settings]');
  text = await panelText(fresh);
  check('panel asks for setup instead of failing', /Let's set you up/.test(text) && /an AI to answer with/.test(text) && /resume/.test(text), text);
  await fresh.close();

  // ------------------------------------------------------------------ 6. settings page: find Ollama, build a profile from a PDF
  console.log('\nSettings page: find the local model and build a profile from a PDF');
  await seed({ settings: { ollamaURL: BASE } });
  requests.length = 0;
  const opt = await browser.newPage();
  opt.on('dialog', (d) => d.accept());
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await opt.waitForSelector('#readiness');
  await opt.waitForFunction(() => /ok|bad/.test(document.getElementById('ollamaStatus').className), { timeout: 10000 });
  check('"On this computer" is the default', await opt.$eval('.prov[data-provider=ollama]', (e) => e.getAttribute('aria-checked') === 'true'));
  check('Ollama found past its extension block', /Ollama 0\.34\.3 is running/.test(await opt.$eval('#ollamaStatus', (e) => e.textContent)), await opt.$eval('#ollamaStatus', (e) => e.textContent));
  const models = await opt.$$eval('#ollamaModel option', (o) => o.map((x) => ({ v: x.value, sel: x.selected })));
  check('chat models listed, embedding models left out', models.length === 2 && !models.some((m) => /embed/.test(m.v)), models);
  check('recommended model picked by itself', models.find((m) => m.sel)?.v === 'qwen3.5:4b' && (await storage('settings'))?.ollamaModel === 'qwen3.5:4b', models);
  await opt.waitForFunction(() => /1 step/.test(document.getElementById('readiness').textContent));
  check('readiness shows one step to go', true);

  const input = await opt.$('#files');
  await input.uploadFile(pdfPath);
  await opt.waitForFunction(() => document.querySelectorAll('#fileList li').length === 1);
  await opt.click('#build');
  await opt.waitForFunction(() => /ok|bad/.test(document.getElementById('buildStatus').className), { timeout: 30000 });
  const buildStatus = await opt.$eval('#buildStatus', (e) => e.textContent);
  check('profile built from the PDF', /Done/.test(buildStatus), buildStatus);
  const buildReq = requests.find((r) => systemOf(r).startsWith("You turn a person's documents"));
  const buildText = buildReq ? userOf(buildReq) : '';
  check('PDF turned into text on this computer', /Asha Rani Verma/.test(buildText) && /Example Institute of Technology/.test(buildText), buildText.slice(0, 200));
  check('link hidden behind "LinkedIn" recovered from the PDF', buildText.includes('https://www.linkedin.com/in/asha-verma'), buildText.slice(-200));
  check('no PDF bytes sent to the local model', !buildText.includes('JVBERi0') && !buildReq?.body.messages.some((m) => m.images?.length));
  check('profile extraction uses the profile schema', buildReq?.body.format?.properties?.basics?.type === 'object');
  const stored = await storage('profile');
  check('profile saved', stored?.basics?.full_name === 'Asha Rani Verma', stored?.basics?.full_name);
  check('resume kept for upload fields', (await storage('resumeFile'))?.name === 'Asha_Verma_Resume.pdf');
  await opt.waitForFunction(() => [...document.querySelectorAll('#profileEditor input')].some((i) => i.value === 'Asha Rani Verma'));
  check('editor shows the profile', true);
  check('readiness now ready', /Ready/.test(await opt.$eval('#readiness', (e) => e.textContent)));

  // Edit in the editor and save.
  const cityInput = await opt.evaluateHandle(() => [...document.querySelectorAll('#profileEditor label')].find((l) => l.firstChild?.textContent === 'City')?.querySelector('input'));
  await cityInput.asElement().click({ count: 3 });
  await cityInput.asElement().type('Mumbai');
  await opt.waitForSelector('#savebar:not([hidden])');
  await opt.click('#saveProfile');
  await sleep(200);
  const savedCity = (await storage('profile'))?.basics?.location?.city;
  check('editing the profile saves it', savedCity === 'Mumbai', savedCity);
  await opt.screenshot({ path: path.join(OUT, '6-settings.png'), fullPage: true });
  await opt.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await sleep(200);
  await opt.screenshot({ path: path.join(OUT, '7-settings-top.png') });

  // Switch to Gemini: a wrong key is caught, a good one connects, and PDFs go
  // to Gemini as they are.
  console.log('\nSettings page: switch to Gemini, then Claude');
  await opt.click('.prov[data-provider=gemini]');
  await opt.waitForSelector('.prov-panel[data-for=gemini]:not([hidden])');
  await opt.evaluate((b) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, geminiBaseURL: b } })), BASE);
  await opt.type('#geminiKey', 'bad-key');
  await opt.click('#saveGemini');
  await opt.waitForFunction(() => /ok|bad/.test(document.getElementById('geminiStatus').className), { timeout: 10000 });
  check('a wrong Gemini key is caught', /rejected/.test(await opt.$eval('#geminiStatus', (e) => e.textContent)), await opt.$eval('#geminiStatus', (e) => e.textContent));
  await opt.$eval('#geminiKey', (e) => (e.value = ''));
  await opt.type('#geminiKey', 'test-gemini-key');
  await opt.click('#saveGemini');
  await opt.waitForFunction(() => /Connected/.test(document.getElementById('geminiStatus').textContent), { timeout: 10000 }).catch(() => {});
  check('a good Gemini key connects', /Connected\. Gemini 3\.8 Flash is ready/.test(await opt.$eval('#geminiStatus', (e) => e.textContent)), await opt.$eval('#geminiStatus', (e) => e.textContent));
  check('the free-tier data warning is shown', await opt.$eval('.prov-panel[data-for=gemini] .note', (e) => /Google may use/.test(e.textContent) && e.offsetParent !== null));
  check('Gemini is now the chosen AI', (await storage('settings'))?.provider === 'gemini');
  requests.length = 0;
  await (await opt.$('#files')).uploadFile(pdfPath);
  await opt.waitForFunction(() => document.querySelectorAll('#fileList li').length === 1);
  await opt.click('#build');
  await opt.waitForFunction(() => /ok|bad/.test(document.getElementById('buildStatus').className) && !/Reading|reading/.test(document.getElementById('buildStatus').textContent), { timeout: 30000 });
  const gReq = requests.find((r) => r.provider === 'gemini' && systemOf(r).startsWith("You turn a person's documents"));
  check('PDF sent to Gemini as the file itself', !!gReq?.body.contents[0].parts.some((pt) => pt.inlineData?.mimeType === 'application/pdf'), gReq?.body.contents?.[0]?.parts?.map((pt) => Object.keys(pt)));

  await opt.click('.prov[data-provider=claude]');
  await opt.waitForSelector('.prov-panel[data-for=claude]:not([hidden])');
  await opt.evaluate((b) => chrome.storage.local.get('settings').then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, claudeBaseURL: b } })), BASE);
  await opt.type('#claudeKey', 'sk-ant-test-key');
  await opt.click('#saveClaude');
  await opt.waitForFunction(() => /ok|bad/.test(document.getElementById('claudeStatus').className) && !/Checking/.test(document.getElementById('claudeStatus').textContent), { timeout: 10000 });
  check('Claude key test passes', /Connected/.test(await opt.$eval('#claudeStatus', (e) => e.textContent)), await opt.$eval('#claudeStatus', (e) => e.textContent));
  await opt.close();

  // ------------------------------------------------------------------ 7. upgrading from v0.1
  console.log('\nUpgrading from v0.1 (Claude only)');
  await seed({ settings: { apiKey: 'sk-ant-old', baseURL: BASE, effort: 'medium' }, profile: PROFILE, facts: [] });
  const up = await browser.newPage();
  await up.goto(`chrome-extension://${extId}/options.html`);
  await up.waitForFunction(() => document.querySelector('.prov[aria-checked=true]'));
  const old = await up.evaluate(() => ({ chosen: document.querySelector('.prov[aria-checked=true]').dataset.provider, key: document.getElementById('claudeKey').value, url: document.getElementById('claudeBaseURL').value }));
  check('an old Claude key keeps working, and Claude stays chosen', old.chosen === 'claude' && old.key === 'sk-ant-old' && old.url === BASE, old);
  await up.close();
} catch (err) {
  failures += 1;
  console.error('\nE2E crashed:', err);
} finally {
  await browser.close();
  server.close();
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll end-to-end checks passed');
process.exit(failures ? 1 : 0);
