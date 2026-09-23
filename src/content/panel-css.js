export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.wrap {
  --bg: rgba(17, 16, 27, .94);
  --card: rgba(255, 255, 255, .045);
  --card-hi: rgba(255, 255, 255, .075);
  --line: rgba(255, 255, 255, .09);
  --text: #eeedf7;
  --muted: #a4a2ba;
  --faint: #737189;
  --a1: #a78bfa;
  --a2: #3b82f6;
  --fill: #8b7bff;
  --ask: #f5b544;
  --draft: #5cc8ff;
  --yours: #ff7a9a;
  font: 13px/1.45 "Inter", "Segoe UI Variable Text", "Segoe UI", system-ui, -apple-system, sans-serif;
  color: var(--text);
  -webkit-font-smoothing: antialiased;
}
.panel {
  position: fixed;
  width: min(372px, calc(100vw - 16px));
  max-height: calc(100vh - 24px);
  display: flex;
  flex-direction: column;
  background: var(--bg);
  backdrop-filter: blur(22px) saturate(150%);
  -webkit-backdrop-filter: blur(22px) saturate(150%);
  border: 1px solid var(--line);
  border-radius: 18px;
  box-shadow: 0 24px 64px rgba(0, 0, 0, .5), 0 0 0 1px rgba(167, 139, 250, .06) inset;
  overflow: hidden;
  animation: rise .28s cubic-bezier(.2, .8, .2, 1);
}
@keyframes rise { from { opacity: 0; transform: translateY(8px) scale(.98); } }
.bar {
  display: flex; align-items: center; gap: 10px;
  padding: 12px 12px 12px 14px;
  border-bottom: 1px solid var(--line);
  cursor: grab; user-select: none; touch-action: none;
}
.bar:active { cursor: grabbing; }
.brand { display: flex; align-items: center; gap: 8px; font-weight: 650; letter-spacing: .01em; font-size: 14px; }
.brand svg { width: 22px; height: 22px; display: block; }
.site { flex: 1; min-width: 0; color: var(--faint); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.icon {
  all: unset; box-sizing: border-box; width: 28px; height: 28px; border-radius: 8px;
  display: grid; place-items: center; color: var(--muted); cursor: pointer; font-size: 16px; line-height: 1;
  transition: background .15s, color .15s;
}
.icon:hover { background: var(--card-hi); color: var(--text); }
.icon:focus-visible { outline: 2px solid var(--a1); }
.body { overflow-y: auto; padding: 14px; display: flex; flex-direction: column; gap: 12px; scrollbar-width: thin; scrollbar-color: rgba(255,255,255,.15) transparent; }
.foot {
  display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-top: 1px solid var(--line);
  color: var(--faint); font-size: 11.5px;
}
.foot .grow { flex: 1; }
.link { all: unset; cursor: pointer; color: var(--muted); font-size: 12px; padding: 4px 6px; border-radius: 6px; }
.link:hover { color: var(--text); background: var(--card-hi); }

.hero { text-align: center; padding: 18px 8px 8px; display: flex; flex-direction: column; align-items: center; gap: 10px; }
.hero h2 { margin: 0; font-size: 16px; font-weight: 650; }
.hero p { margin: 0; color: var(--muted); max-width: 290px; }
.orb {
  width: 56px; height: 56px; border-radius: 50%;
  background: conic-gradient(from 0deg, var(--a1), var(--a2), #22d3ee, var(--a1));
  -webkit-mask: radial-gradient(circle, transparent 21px, #000 22px);
  mask: radial-gradient(circle, transparent 21px, #000 22px);
  animation: spin 1.4s linear infinite;
}
@keyframes spin { to { transform: rotate(1turn); } }
.steps { list-style: none; margin: 4px 0 0; padding: 0; width: 100%; display: flex; flex-direction: column; gap: 6px; text-align: left; }
.steps li { display: flex; align-items: center; gap: 10px; color: var(--faint); padding: 8px 10px; border-radius: 10px; }
.steps li.now { color: var(--text); background: var(--card); }
.steps li.done { color: var(--muted); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: currentColor; opacity: .5; flex: none; }
.steps li.now .dot { background: var(--a1); opacity: 1; box-shadow: 0 0 0 4px rgba(167,139,250,.18); }
.steps li.done .dot { background: var(--fill); opacity: 1; }
.meter { height: 4px; border-radius: 4px; background: var(--card-hi); overflow: hidden; width: 100%; }
.meter i { display: block; height: 100%; background: linear-gradient(90deg, var(--a1), var(--a2)); border-radius: inherit; transition: width .3s ease; }

.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: center; gap: 6px; padding: 5px 10px; border-radius: 999px; background: var(--card); border: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.chip b { color: var(--text); font-weight: 650; }
.chip .dot { opacity: 1; }
.c-fill .dot { background: var(--fill); } .c-ask .dot { background: var(--ask); } .c-draft .dot { background: var(--draft); } .c-yours .dot { background: var(--yours); }

.banner { padding: 10px 12px; border-radius: 12px; background: linear-gradient(135deg, rgba(167,139,250,.14), rgba(59,130,246,.10)); border: 1px solid rgba(167,139,250,.25); display: flex; align-items: center; gap: 10px; }
.banner span { flex: 1; }
.done-note { color: var(--muted); padding: 2px 2px 0; }

details.sec { border-radius: 14px; }
details.sec > summary {
  list-style: none; cursor: pointer; display: flex; align-items: center; gap: 8px;
  font-size: 11.5px; font-weight: 650; letter-spacing: .06em; text-transform: uppercase; color: var(--muted);
  padding: 4px 2px;
}
details.sec > summary::-webkit-details-marker { display: none; }
details.sec > summary::after { content: ""; margin-left: auto; width: 7px; height: 7px; border-right: 1.5px solid var(--faint); border-bottom: 1.5px solid var(--faint); transform: rotate(45deg); transition: transform .2s; }
details.sec[open] > summary::after { transform: rotate(225deg); }
.list { display: flex; flex-direction: column; gap: 8px; margin-top: 6px; }

.card { background: var(--card); border: 1px solid var(--line); border-radius: 14px; padding: 12px; display: flex; flex-direction: column; gap: 8px; border-left: 3px solid var(--ask); }
.card.draft { border-left-color: var(--draft); }
.card.yours { border-left-color: var(--yours); }
.q { font-weight: 600; color: var(--text); cursor: pointer; }
.q:hover { text-decoration: underline; text-decoration-color: var(--faint); text-underline-offset: 3px; }
.req { color: var(--ask); margin-left: 2px; }
.hint { color: var(--muted); font-size: 12px; }
.err { color: #ff9b9b; font-size: 12px; }
.src { display: flex; flex-wrap: wrap; gap: 4px; }
.src span { font-size: 11px; color: var(--faint); background: rgba(255,255,255,.04); border: 1px solid var(--line); padding: 1px 7px; border-radius: 999px; }

input.in, textarea.in, select.in {
  all: unset; box-sizing: border-box; width: 100%;
  background: rgba(0, 0, 0, .28); border: 1px solid var(--line); border-radius: 10px;
  padding: 8px 10px; color: var(--text); font: inherit; transition: border-color .15s, box-shadow .15s;
}
textarea.in { min-height: 96px; white-space: pre-wrap; overflow-y: auto; resize: vertical; }
select.in { cursor: pointer; }
select.in option { background: #16151f; color: var(--text); }
.in:focus { border-color: rgba(167,139,250,.6); box-shadow: 0 0 0 3px rgba(167,139,250,.16); }
.opts { display: flex; flex-wrap: wrap; gap: 6px; }
.opt { position: relative; }
.opt input { position: absolute; opacity: 0; pointer-events: none; }
.opt span { display: inline-block; padding: 6px 11px; border-radius: 999px; border: 1px solid var(--line); background: rgba(0,0,0,.2); cursor: pointer; color: var(--muted); transition: all .15s; }
.opt input:checked + span { color: #fff; border-color: transparent; background: linear-gradient(135deg, rgba(167,139,250,.55), rgba(59,130,246,.5)); }
.opt input:focus-visible + span { outline: 2px solid var(--a1); }

.row { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; }
.btn {
  all: unset; box-sizing: border-box; cursor: pointer; padding: 7px 13px; border-radius: 10px; font-weight: 600; font-size: 12.5px;
  border: 1px solid var(--line); color: var(--text); background: var(--card-hi); transition: transform .12s, filter .15s, background .15s; text-align: center;
}
.btn:hover { background: rgba(255,255,255,.11); }
.btn:active { transform: scale(.97); }
.btn:focus-visible { outline: 2px solid var(--a1); outline-offset: 2px; }
.btn.primary { border-color: transparent; background: linear-gradient(135deg, var(--a1), var(--a2)); color: #fff; box-shadow: 0 6px 18px rgba(99, 102, 241, .3); }
.btn.primary:hover { filter: brightness(1.08); }
.btn.big { padding: 10px 18px; font-size: 13.5px; }
.btn[disabled] { opacity: .5; pointer-events: none; }

.filled { display: flex; flex-direction: column; gap: 2px; }
.frow { display: grid; grid-template-columns: 1fr auto; gap: 2px 8px; align-items: center; padding: 8px 10px; border-radius: 10px; }
.frow:hover { background: var(--card); }
.frow .q { font-weight: 500; color: var(--muted); font-size: 12px; }
.frow .v { grid-column: 1; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.frow .icon { grid-row: 1 / span 2; grid-column: 2; width: 26px; height: 26px; font-size: 14px; opacity: 0; }
.frow:hover .icon, .frow .icon:focus-visible { opacity: 1; }
.frow .src { grid-column: 1; margin-top: 2px; }
.muted-row { color: var(--faint); font-size: 12px; padding: 4px 10px; }

.pill {
  all: unset; position: fixed; width: 48px; height: 48px; border-radius: 16px; cursor: pointer;
  display: grid; place-items: center; box-shadow: 0 12px 32px rgba(0,0,0,.45); touch-action: none;
  animation: rise .22s ease;
}
.pill svg { width: 48px; height: 48px; display: block; }
.pill .badge { position: absolute; top: -5px; right: -5px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--ask); color: #1a1405; font: 700 11px/18px system-ui, sans-serif; text-align: center; }
.pill:focus-visible { outline: 2px solid var(--a1); outline-offset: 3px; }
[hidden] { display: none !important; }
@media (prefers-reduced-motion: reduce) { .panel, .pill { animation: none; } .orb { animation-duration: 4s; } }
`;
