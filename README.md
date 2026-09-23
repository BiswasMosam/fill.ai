# fill.ai

**Forms, filled by an AI that actually knows you.**

Job applications, college portals, Google Forms: every one asks the same things in a slightly different layout. fill.ai reads your resume once, remembers you, and from then on fills forms for you. It fills what it knows, asks you about what it doesn't, and never presses submit.

![fill.ai filling a job application](docs/panel.png)

<sub>Every screenshot here uses a made-up test profile.</sub>

## What it does

1. **Teach it once.** Drop in your resume PDF, add your portfolio or LinkedIn link and anything else you like. Claude reads it all and builds a structured profile: education, experience, projects, skills, links, contact details. You can see and edit every line.
2. **Open any form** and press <kbd>Alt</kbd> <kbd>Shift</kbd> <kbd>F</kbd> (or click the fill.ai icon). A small panel appears in the corner. Drag it anywhere, or shrink it to a button.
3. **It reads the form and fills what it knows.** Names, email, phone, links, degree, college, graduation year, skills checkboxes, dropdowns, even the resume upload.
4. **It asks about the rest.** Each field it couldn't answer gets a card. Answer it and choose **Fill once**, or **Save & fill** to remember the answer for every future form.
5. **You check, then you submit.** fill.ai never submits anything.

| Google Forms | Shrinks out of the way |
| --- | --- |
| ![Google Forms style form](docs/google-forms.png) | ![Minimised to a button](docs/pill.png) |

## How it stays honest

An AI that fills forms for you is only useful if it never makes things up. fill.ai does not rely on the model behaving; the code checks every answer before it touches the page.

- **Every answer must cite your profile.** Claude has to name where each answer came from (`education[0].institution`, a saved answer, ...). If the citation points at nothing, the answer is thrown away and the field goes to *Needs you*. The panel shows the source under each filled field.
- **Checkable facts are checked.** An email must be one that is actually in your profile, a phone number must match yours digit for digit, and a dropdown answer must be one of the real options.
- **Personal questions are always yours.** Gender, ethnicity, caste, religion, disability, veteran status and ID numbers are never filled automatically, whatever the model says.
- **Agreements are always yours.** Terms, privacy policies, arbitration and "I certify" boxes are never ticked for you.
- **Some things are never read at all.** Passwords, OTPs, captchas and card or bank details are skipped before anything is sent to Claude.
- **Hidden fields are ignored.** A form can hide a "phone" field to harvest autofill data. fill.ai only reads fields a person can actually see.
- **Drafts are drafts.** Open questions such as "Why do you want to join us?" get a draft written from your profile, shown in the panel, and inserted only when you click *Insert*.

## Install

fill.ai is a Chrome extension (it also works in Edge and other Chromium browsers). It is not on the Chrome Web Store yet, so for now you load it yourself:

```bash
git clone https://github.com/BiswasMosam/fill.ai.git
cd fill.ai
npm install
npm run build
```

1. Open `chrome://extensions` and switch on **Developer mode**.
2. Click **Load unpacked** and choose the `dist` folder.
3. The fill.ai settings page opens. Paste a Claude API key from [console.anthropic.com](https://console.anthropic.com/settings/keys) and press **Save and test**.
4. Drop your resume into step 2 and press **Build my profile**. Check the result in *Your profile* and fix anything that is off.

![The settings page](docs/settings.png)

## What goes where

- Your profile, saved answers, resume file and API key live in this browser only (`chrome.storage.local`). Nothing is synced.
- When you fill a form, the form's questions, a short excerpt of the page (so drafts can mention the company) and your profile are sent to Anthropic's API so Claude can work out the answers. Nothing else leaves your machine.
- **Export profile** gives you everything as JSON; **Delete everything** wipes it.

## Cost

fill.ai uses Claude Opus 5 with your own API key. Reading your resume happens once. After that, each form is one request, and your profile is cached between forms, which makes repeat requests cheaper. The panel shows what each form cost ("This form: about $0.07"). As an estimate at Opus 5 prices, expect a few US cents to around 20 cents per form depending on its length. Settings has a **Fast / Balanced / Careful** switch that trades thoroughness for speed and cost.

## How it works

```
 toolbar / Alt+Shift+F
          │
          ▼
 ┌──────────────────┐   inject into every frame   ┌────────────────────────────┐
 │  service worker  │ ──────────────────────────▶ │ content script (per frame) │
 │  background/     │ ◀── fields (label, kind, ── │  scan: finds fields,       │
 │                  │      options, section)      │  labels, options           │
 │  1. guard fields │                             │  fill: types, clicks,      │
 │  2. ask Claude   │ ─── answers to fill ──────▶ │  picks, attaches, checks   │
 │  3. verify       │                             │  panel (top frame only)    │
 └──────────────────┘                             └────────────────────────────┘
          │ Claude Opus 5, strict JSON schema,
          ▼ adaptive thinking, cached profile prompt
    Anthropic API
```

- `src/content/scan.js` reads the form: native inputs, Google Forms' ARIA radios, checkboxes and listboxes, React comboboxes (their options are read by opening them for a moment), open shadow roots and cross-origin iframes. Labels come from what a person sees: `<label>`, `aria-labelledby`, fieldset legends and nearby text.
- `src/content/fill.js` fills fields the way a person would, so React, Angular and Google Forms all register the change, then reads every value back. Anything that doesn't stick goes to *Needs you*.
- `src/shared/matcher.js` is the gatekeeper between Claude and the page: citations, option matching, format checks and the personal-question guards (`src/shared/sensitive.js`).
- `src/shared/claude.js` is the only file that talks to Claude: `claude-opus-5` with strict JSON output, and `fallbacks: "default"` so a declined request is retried on Anthropic's recommended fallback model instead of failing.
- `src/content/panel.js` is the floating panel, in a closed shadow root so the page can't style, read or click it.
- `src/options/` is the settings and profile page.

## Development

```bash
npm run dev      # rebuild dist/ on every change (then reload the extension)
npm test         # unit tests: matcher, guards, option matching, profile schema
npm run e2e      # loads the real extension in Chrome against a mock Claude and drives it
npm run smoke    # checks the production build fills a form
node build.mjs --test && node test/e2e/live-probe.mjs <url>   # try a real site with the mock Claude
```

The end-to-end suite runs 65 checks against the real extension: a job application with a React-style controlled input, a cross-origin iframe, hidden trap fields, a Google Forms style form with a second page, the settings page building a profile from a real PDF, dragging and shrinking the panel, undo, *Save & fill* and saved answers being reused. The mock Claude deliberately invents one answer, and the suite checks that it is thrown out.

## Tested on

Reading and filling have been run against these, with the mock Claude standing in for the real one and nothing ever submitted:

- Live Greenhouse and Lever job applications: react-select dropdowns, resume upload, long option lists, EEO and consent questions
- Plain HTML forms, React-controlled inputs and cross-origin iframes
- A replica of Google Forms' structure (ARIA radios, checkboxes, dropdowns, a second page). Not yet run against a live Google Form.

## Known gaps

- Workday and other step-by-step portals that reload the page between steps: reopen fill.ai on each step.
- Date pickers that only accept clicks on a calendar.
- Only PDF resumes can be attached to upload fields.
- Friends need their own Claude API key for now.

## Roadmap

- A small backend so friends can use fill.ai without their own API key
- Chrome Web Store release
- Remembering which answers you changed after fill.ai filled them, and learning from it

## License

MIT
