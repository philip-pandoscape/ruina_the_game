// Styles for the open-world HUD and panels, injected once. Same language as the combat HUD in
// index.html: dark glass, rounded corners, warm gold for what matters.

export const LIFE_CSS = /* css */ `
:root { --gold: #ffd166; --ink: #1d2733; --glass: rgba(16, 24, 34, 0.72); --glass2: rgba(26, 38, 52, 0.94);
  --line: rgba(255,255,255,0.14); --good: #7bed9f; --bad: #ff7b7b; --quest: #ffd166; --sea: #63d6cf; }
.lui { position: fixed; pointer-events: none; color: #fff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.lui .key { display: inline-flex; align-items: center; justify-content: center; min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: 4px; background: rgba(255,255,255,0.92); color: var(--ink); font-weight: 800; font-size: 11px; text-shadow: none; }

/* Wallet + labor, bottom left */
#lui-wallet { left: 14px; bottom: 58px; display: flex; flex-direction: column; gap: 6px; min-width: 210px;
  background: var(--glass); border: 1px solid var(--line); border-radius: 12px; padding: 9px 12px; font-size: 13px; }
#lui-wallet .row { display: flex; gap: 12px; align-items: center; font-weight: 700; }
#lui-wallet .coins { color: var(--gold); }
#lui-wallet .seals { color: #b8d8ff; }
#lui-wallet .bar { position: relative; height: 12px; border-radius: 6px; background: rgba(0,0,0,0.45); overflow: hidden; }
#lui-wallet .bar .fill { position: absolute; inset: 0 auto 0 0; background: linear-gradient(90deg, #4fb3ff, #7be0ff); }
#lui-wallet .bar .txt { position: absolute; inset: 0; text-align: center; font-size: 10px; line-height: 12px; font-weight: 800; }
#lui-wallet .meta { display: flex; justify-content: space-between; font-size: 11px; opacity: 0.85; }
#lui-wallet .meta b { color: var(--sea); }

/* Compass, top centre */
#lui-compass { top: 8px; left: 50%; transform: translateX(-50%); width: min(560px, 70vw); height: 30px; overflow: hidden;
  background: var(--glass); border: 1px solid var(--line); border-radius: 15px; }
#lui-compass .tick { position: absolute; top: 6px; transform: translateX(-50%); font-size: 12px; font-weight: 800; opacity: 0.85; }
#lui-compass .tick.card { color: var(--gold); }
#lui-compass .poi { position: absolute; top: 4px; transform: translateX(-50%); font-size: 15px; filter: drop-shadow(0 1px 1px #000); }
#lui-compass .goal { position: absolute; top: 1px; transform: translateX(-50%); font-size: 16px; color: var(--gold);
  text-shadow: 0 0 6px rgba(255, 209, 102, 0.9); font-weight: 900; }
#lui-compass .goal small { position: absolute; top: 15px; left: 50%; transform: translateX(-50%); font-size: 9px; white-space: nowrap; }
#lui-compass .centre { position: absolute; left: 50%; top: 0; bottom: 0; width: 2px; margin-left: -1px; background: rgba(255,255,255,0.5); }

/* Place banner */
#lui-banner { top: 24%; left: 50%; transform: translateX(-50%); text-align: center; opacity: 0; transition: opacity 0.6s; }
#lui-banner.show { opacity: 1; }
#lui-banner .name { font-size: 30px; font-weight: 900; letter-spacing: 3px; text-shadow: 0 2px 10px rgba(0,0,0,0.6); }
#lui-banner .sub { font-size: 13px; letter-spacing: 4px; text-transform: uppercase; opacity: 0.85; text-shadow: 0 1px 4px #000; }

/* Toasts */
#lui-toasts { top: 46px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 4px; }
#lui-toasts .t { padding: 5px 12px; border-radius: 999px; background: var(--glass); border: 1px solid var(--line); font-size: 13px;
  font-weight: 700; transition: opacity 0.4s, transform 0.4s; white-space: nowrap; }
#lui-toasts .t.good { color: var(--good); } #lui-toasts .t.bad { color: var(--bad); } #lui-toasts .t.coin { color: var(--gold); }
#lui-toasts .t.quest { color: var(--gold); border-color: rgba(255,209,102,0.55); }
#lui-toasts .t.fade { opacity: 0; transform: translateY(-6px); }

/* Interaction prompt */
#lui-prompt { left: 50%; bottom: 168px; transform: translateX(-50%); display: none; align-items: center; gap: 9px;
  background: var(--glass2); border: 1px solid rgba(255,255,255,0.22); border-radius: 12px; padding: 8px 14px; font-size: 15px; font-weight: 800;
  box-shadow: 0 6px 24px rgba(0,0,0,0.35); }
#lui-prompt.show { display: flex; }
#lui-prompt.off { opacity: 0.7; }
#lui-prompt .key { min-width: 24px; height: 24px; font-size: 13px; background: var(--gold); }
#lui-prompt.off .key { background: rgba(255,255,255,0.5); }
#lui-prompt .detail { font-size: 12px; font-weight: 600; opacity: 0.8; }

/* Quest tracker */
#lui-quests { top: 52px; right: 14px; width: 270px; display: flex; flex-direction: column; gap: 8px; }
#lui-quests .q { background: var(--glass); border: 1px solid var(--line); border-left: 3px solid var(--gold); border-radius: 10px; padding: 8px 10px; }
#lui-quests .q h4 { margin: 0 0 4px; font-size: 13px; color: var(--gold); }
#lui-quests .q .step { font-size: 12px; line-height: 1.35; opacity: 0.95; }
#lui-quests .q .count { color: var(--good); font-weight: 800; margin-left: 4px; }
#lui-quests .q.ready { border-left-color: var(--good); }
#lui-quests .q.ready h4 { color: var(--good); }
#lui-quests .hint { font-size: 11px; opacity: 0.6; text-align: right; }

/* Vehicle / glider readout, bottom right */
#lui-ride { right: 14px; bottom: 58px; min-width: 190px; background: var(--glass); border: 1px solid var(--line); border-radius: 12px;
  padding: 9px 12px; font-size: 12px; display: none; }
#lui-ride.show { display: block; }
#lui-ride .big { font-size: 26px; font-weight: 900; line-height: 1; }
#lui-ride .big small { font-size: 12px; opacity: 0.7; margin-left: 3px; }
#lui-ride .slots { display: flex; gap: 4px; margin-top: 6px; flex-wrap: wrap; }
#lui-ride .slot { width: 22px; height: 22px; border-radius: 5px; background: rgba(0,0,0,0.4); border: 1px solid var(--line);
  display: grid; place-items: center; font-size: 13px; }
#lui-ride .wind { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
#lui-ride .arrow { display: inline-block; font-size: 18px; transition: transform 0.2s; }
#lui-ride .trim { height: 7px; border-radius: 4px; background: rgba(0,0,0,0.4); overflow: hidden; margin-top: 4px; }
#lui-ride .trim i { display: block; height: 100%; background: linear-gradient(90deg, #f3e7c9, #fff); }
#lui-ride .vario.up { color: var(--good); } #lui-ride .vario.down { color: var(--bad); }

/* Name plates */
.lui-plate { position: fixed; transform: translate(-50%, -100%); text-align: center; pointer-events: none; white-space: nowrap;
  text-shadow: 0 1px 3px rgba(0,0,0,0.85); color: #fff; }
.lui-plate .mark { font-size: 22px; font-weight: 900; color: var(--gold); line-height: 1; text-shadow: 0 0 8px rgba(255,209,102,0.8), 0 1px 2px #000; }
.lui-plate .mark.ready { color: var(--good); text-shadow: 0 0 8px rgba(123,237,159,0.8), 0 1px 2px #000; }
.lui-plate .n { font-size: 12px; font-weight: 800; }
.lui-plate .t { font-size: 10px; opacity: 0.8; }

/* Panels */
.lui-panel { position: fixed; inset: 0; display: grid; place-items: center; background: rgba(8, 14, 22, 0.45); pointer-events: auto; z-index: 20; }
.lui-panel[hidden] { display: none; }
.lui-card { width: min(720px, 94vw); max-height: 86vh; overflow: auto; background: var(--glass2); border: 1px solid rgba(255,255,255,0.16);
  border-radius: 16px; box-shadow: 0 14px 50px rgba(0,0,0,0.5); padding: 16px 18px; color: #fff; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
.lui-card header { display: flex; align-items: center; gap: 12px; margin-bottom: 12px; }
.lui-card header .face { font-size: 34px; width: 52px; height: 52px; display: grid; place-items: center; border-radius: 12px; background: rgba(255,255,255,0.07); }
.lui-card header h2 { margin: 0; font-size: 19px; }
.lui-card header .sub { font-size: 12px; opacity: 0.7; }
.lui-card header .x { margin-left: auto; }
.lui-card p { line-height: 1.5; font-size: 14px; margin: 0 0 12px; }
.lui-card .say { font-style: italic; opacity: 0.95; border-left: 3px solid var(--gold); padding-left: 10px; }
.lui-card .btns { display: flex; gap: 8px; flex-wrap: wrap; }
.lui-btn { font: inherit; font-size: 13px; font-weight: 800; color: #fff; cursor: pointer; padding: 8px 14px; border-radius: 9px;
  background: rgba(255,255,255,0.1); border: 1px solid rgba(255,255,255,0.25); }
.lui-btn:hover { background: rgba(255,255,255,0.2); }
.lui-btn.gold { background: var(--gold); color: var(--ink); border-color: var(--gold); }
.lui-btn.good { background: #2ed573; color: var(--ink); border-color: #2ed573; }
.lui-btn[disabled] { opacity: 0.45; cursor: default; }
.lui-btn.small { padding: 5px 9px; font-size: 12px; }
.lui-focus { outline: 3px solid var(--gold) !important; outline-offset: 2px; }
.lui-btn:focus-visible, .lui-cell:focus-visible { outline: 3px solid var(--gold); outline-offset: 2px; }
.lui-list { display: flex; flex-direction: column; gap: 6px; }
.lui-row { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border-radius: 10px; background: rgba(255,255,255,0.05); border: 1px solid transparent; }
.lui-row:hover { border-color: var(--line); }
.lui-row .ic { font-size: 24px; width: 32px; text-align: center; }
.lui-row .body { flex: 1; min-width: 0; }
.lui-row .body b { display: block; font-size: 14px; }
.lui-row .body small { display: block; font-size: 12px; opacity: 0.75; line-height: 1.35; }
.lui-row .price { font-weight: 800; color: var(--gold); white-space: nowrap; font-size: 13px; }
.lui-row .have { color: var(--good); } .lui-row .lack { color: var(--bad); }
.lui-cols { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.lui-cols h3, .lui-card h3 { margin: 4px 0 8px; font-size: 12px; text-transform: uppercase; letter-spacing: 1.5px; opacity: 0.7; }
.lui-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 6px; }
.lui-cell { position: relative; aspect-ratio: 1; border-radius: 10px; background: rgba(0,0,0,0.3); border: 1px solid var(--line);
  display: grid; place-items: center; font-size: 26px; cursor: pointer; }
.lui-cell:hover { border-color: rgba(255,255,255,0.5); }
.lui-cell.sel { border-color: var(--gold); box-shadow: 0 0 0 2px rgba(255,209,102,0.4); }
.lui-cell .n { position: absolute; right: 4px; bottom: 2px; font-size: 11px; font-weight: 800; }
.lui-cell.empty { cursor: default; opacity: 0.4; }
.lui-detail { margin-top: 12px; padding: 10px 12px; border-radius: 10px; background: rgba(255,255,255,0.05); min-height: 64px; }
.lui-stats { display: flex; gap: 16px; font-size: 13px; font-weight: 700; margin-bottom: 12px; flex-wrap: wrap; }
#lui-map canvas { width: min(82vh, 92vw); height: min(82vh, 92vw); border-radius: 14px; display: block; }
.lui-tabs { display: flex; gap: 6px; margin-bottom: 10px; }
.lui-dev .lui-btn { margin: 0 6px 6px 0; }
`;

let injected = false;
export function injectLifeStyles(): void {
  if (injected) return;
  injected = true;
  const el = document.createElement('style');
  el.textContent = LIFE_CSS;
  document.head.appendChild(el);
}
