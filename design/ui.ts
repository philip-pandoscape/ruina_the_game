// The UI design system's live half. design/ui.html holds the prose; every specimen here is drawn
// with the game's own stylesheets and modules (src/ui/theme/), so the page shows what the game
// shows and changes when the game does.

import '../src/ui/theme/theme.css';
import '../src/ui/theme/hud.css';
import '../src/ui/theme/windows.css';
import { initUiScale } from '../src/ui/theme/scale';
import { iconHtml, money } from '../src/ui/theme/icons';
import { GOLD_STAR, pixelIcon } from '../src/ui/theme/pixelIcons';
import { addTipSource, wireTips } from '../src/ui/theme/tooltip';
import { openMenu } from '../src/ui/theme/contextMenu';
import { SMALL_WORDS, titleCase } from '../src/ui/theme/text';

const $ = (sel: string) => document.querySelector(sel) as HTMLElement;

// Tooltips and the right-click menu are drawn in the UI root, as in the game.
initUiScale($('#ui'));
wireTips();
addTipSource((tip) =>
  tip === 'demo:scarecrow'
    ? '<h5>Scarecrow</h5><div class="ty">Placeable · Stacks to 5</div><p>Claims an 8×8 m farm plot wherever the ground is open and level. Up to three.</p><hr><div class="row"><span class="muted">Worth</span>' + money(40, 12) + '</div>'
    : null,
);

// ---------- Writing ----------

$('#smallWords').textContent = [...SMALL_WORDS].join(', ');
const tcIn = $('#tcIn') as HTMLInputElement;
const tcOut = $('#tcOut') as HTMLOutputElement;
const retitle = () => (tcOut.textContent = `→ ${titleCase(tcIn.value.trim())}`);
tcIn.addEventListener('input', retitle);
retitle();

// ---------- Layout: the screen's regions, as src/ui/theme/hud.css places them ----------

const zones: Array<[string, string, number, number, number, number, boolean?]> = [
  ['Portrait & Vitals', 'health, MP, stamina, labor, purse', 1.2, 1.5, 22, 12],
  ['Compass', 'places and the quest goal', 34, 1, 32, 5],
  ['Minimap', 'north up; quest marks', 85.5, 1.5, 13, 17],
  ['Clock & Wind', '', 85.5, 19.5, 13, 3.5],
  ['Quest Tracker', 'tracked quests', 82, 24.5, 16.5, 16],
  ['Main Window', 'talk, quests, shop, character…', 1.2, 16, 30, 52, true],
  ['Bag', 'docks right', 69, 42, 25, 25, true],
  ['Place Banner', '', 40, 22, 20, 6],
  ['Prompt', 'F Talk to…', 41, 72, 18, 4.5],
  ['Hotbar', 'weapon, 8 slots, Skills', 32, 84, 36, 7],
  ['Controls Hint', '', 34, 92.5, 32, 5],
  ['Toasts', 'newest at the bottom', 84, 66, 15, 10],
  ['Menu Buttons', 'Bag · Character · Quests · Map · Rides · Settings', 69, 82, 30, 9],
  ['Account Badge', 'online: who, channel, sign out', 75, 92.5, 24, 6],
  ['Developer Readout', 'fps, draw calls', 1.2, 92.5, 22, 6],
];
$('#layoutMap').innerHTML = zones
  .map(([name, note, x, y, w, h, win]) => `<div class="zone${win ? ' win' : ''}" style="left:${x}%;top:${y}%;width:${w}%;height:${h}%"><div>${name}${note ? `<small>${note}</small>` : ''}</div></div>`)
  .join('');

// ---------- Colour & type, read from the stylesheet ----------

const css = getComputedStyle(document.documentElement);
const SWATCHES: Array<[string, string]> = [
  ['--title', 'Titles, focus'], ['--ink', 'Text'], ['--ink-2', 'Quiet text'], ['--ink-strong', 'Strong text'], ['--accent', 'Accent'],
  ['--price', 'Prices'], ['--good', 'Good, done'], ['--bad', 'Bad, warnings'], ['--sea', 'Wind, water'], ['--seal', 'Seals'],
  ['--btn', 'Buttons'], ['--btn-gold', 'The main action'], ['--btn-good', 'Confirm'], ['--wood', 'Frames'], ['--brass', 'Rims, rivets'],
  ['--parchment', 'Cards'], ['--strip', 'Title strips, hints'], ['--plaque', 'Banners, ribbons'],
  ['--hp', 'Health'], ['--mp', 'MP'], ['--stamina', 'Stamina'], ['--labor', 'Labor'], ['--cast', 'Cast bar'],
];
$('#swatches').innerHTML = SWATCHES.filter(([v]) => css.getPropertyValue(v).trim())
  .map(([v, use]) => `<div class="swatch"><i style="background:var(${v})"></i><span><b>${use}</b><code>${v}</code></span></div>`)
  .join('');
$('#typeSpecimens').innerHTML = [
  ['Ruina Title', 'var(--font-title)', 700, 'Window Titles · Headings', 'Alegreya SC, bold: titles, headings, the place banner'],
  ['Ruina Serif', 'var(--font)', 400, 'Body text and what people say', 'TeX Gyre Pagella: everything else'],
  ['Ruina Serif Bold', 'var(--font)', 700, 'Buttons, Labels, Numbers 1234', 'Pagella bold: buttons, labels, figures'],
  ['Ruina Serif Italic', 'var(--font)', 400, '“Plant, pack, haul - and keep your boots dry.”', 'Pagella italic: greetings and quotes', true],
]
  .map(([name, font, weight, sample, use, italic]) => `<div class="rule"><div style="font:${italic ? 'italic ' : ''}${weight} 22px ${font};color:var(--ink-strong)">${sample}</div><div style="font-size:12.5px;color:var(--ink-2)">${name} · ${use}</div></div>`)
  .join('');

// ---------- Components ----------

$('#buttons').innerHTML =
  '<button class="lui-btn gold">Complete Quest</button><button class="lui-btn">Goodbye</button><button class="lui-btn good">Confirm</button>' +
  '<button class="lui-btn small gold">Sell All Produce</button><button class="lui-btn small">Back</button><button class="lui-btn" disabled>Not Enough Money</button>' +
  '<span class="cap">.lui-btn · .gold for the main action · .good to confirm · .small in rows and feet · [disabled]</span>';

$('#windows').innerHTML =
  `<div class="mw has-portrait" style="width:400px;height:330px"><div class="mw-portrait"><span class="emoji">${iconHtml('🧓', undefined, 40)}</span></div>` +
  '<div class="mw-bar">Reeve Hollis <small>Village Elder</small></div><div class="mw-x">✕</div>' +
  `<div class="mw-body"><p class="g-say">“Lanternwick prospers when its people do. Plant, pack, haul - and keep your boots dry.”</p><div class="h">Quests</div>` +
  `<ul class="g-opts"><li>${pixelIcon('qmark', 22)}<span>First Flight</span><small>Complete</small></li><li class="prog">${pixelIcon('qgray', 22)}<span>A Patch of Earth</span><small>In Progress</small></li></ul>` +
  `<div class="h">Talk</div><ul class="g-opts"><li class="talk">${pixelIcon('star', 22)}<span>Use the Workbench</span></li></ul></div>` +
  '<div class="mw-foot"><span></span><button class="lui-btn">Goodbye</button></div></div>' +
  '<div class="mw" style="width:330px"><div class="mw-bar">Bag <small>3 / 30</small></div><div class="mw-x">✕</div>' +
  `<div class="mw-body" style="overflow:hidden"><div class="bag-grid" style="grid-template-columns:repeat(7, 38px)">` +
  `<div class="ib sm sel">${iconHtml('🧑‍🌾', 'scarecrow')}</div><div class="ib sm">${iconHtml('🥕', 'seed.sunroot')}<span class="n">8</span></div><div class="ib sm">${iconHtml('🪁', 'glider.wayfarer')}</div>` +
  '<div class="ib sm empty"></div><div class="ib sm empty"></div><div class="ib sm empty"></div><div class="ib sm empty"></div></div></div>' +
  `<div class="mw-foot"><span>${money(320)}&nbsp; ${pixelIcon('seal', 16)} <b>2</b></span><span>${pixelIcon('bolt', 14)} <b>800</b> Labor</span></div></div>`;

const demo = document.createElement('div');
demo.className = 'ib big';
demo.dataset.tip = 'demo:scarecrow';
demo.style.cursor = 'pointer';
demo.innerHTML = iconHtml('🧑‍🌾', 'scarecrow', 48);
demo.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  openMenu(e.clientX, e.clientY, 'Scarecrow', [
    { label: 'Place', primary: true, run: () => (demo.title = 'Placed (a demo)') },
    { label: 'Sell One', disabled: 'Talk to a merchant who buys it' },
  ]);
});
$('#items').append(demo);
$('#items').insertAdjacentHTML(
  'beforeend',
  `<div class="ib">${iconHtml('🥕', 'seed.sunroot')}<span class="n">8</span></div><div class="ib sel">${iconHtml('🪁', 'glider.wayfarer')}</div><div class="ib empty"></div>` +
    `<div class="tt" style="display:block">${'<h5>Scarecrow</h5><div class="ty">Placeable · Stacks to 5</div><p>Claims an 8×8 m farm plot wherever the ground is open and level.</p><hr><div class="row"><span class="muted">Worth</span>' + money(40, 12) + '</div>'}</div>` +
    '<div class="ctx"><div class="ctx-h">Scarecrow</div><button class="ctx-i primary">Place</button><button class="ctx-i" disabled>Sell One<small>Talk to a merchant who buys it</small></button></div>' +
    '<span class="cap">.ib item slots (.sel picked, .empty) · .tt tooltip · .ctx context menu. Right-click the first slot for the live menu.</span>',
);

const bar = (icon: string, colour: string, frac: number, text: string) =>
  `<div class="hud-bar" style="--c:${colour};width:228px"><span class="cap">${icon}</span><div class="track"><div class="fill" style="width:calc((100% - 12px) * ${frac})"></div><span class="txt">${text}</span></div></div>`;
const bars = [bar(pixelIcon('heart', 20), 'var(--hp)', 0.82, '82 / 100')];
if (css.getPropertyValue('--mp').trim()) bars.push(bar(pixelIcon('star', 20), 'var(--mp)', 0.6, '60 / 100'));
if (css.getPropertyValue('--stamina').trim()) bars.push(bar(pixelIcon('bolt', 20), 'var(--stamina)', 0.45, '45 / 100'));
bars.push(bar(pixelIcon('bolt', 20), 'var(--labor)', 0.8, '800 / 1000'));
const mark = (ready: boolean) =>
  `<div style="display:inline-grid;place-items:center;width:22px;height:22px;border-radius:50%;background:radial-gradient(circle at 40% 35%, ${ready ? '#b6f08e, #4fae3a 60%, #2f7a24' : '#ffe28a, #f0a92e 60%, #b8741a'});box-shadow:0 0 0 2px #7a1f26, 0 0 0 3.5px #2b1a0e">${pixelIcon(ready ? 'qmark' : 'excl', 14, { y: '#ffffff', Y: '#ffe6b0' })}</div>`;
$('#bits').innerHTML =
  `<div style="display:flex;flex-direction:column;gap:8px">${bars.join('')}</div>` +
  '<span class="key">F</span><span class="key">Esc</span><span class="key">Space</span>' +
  `<div id="lui-toasts" style="position:static"><div class="t good">${iconHtml('🧑‍🌾', 'scarecrow', 13)} +1 Scarecrow</div><div class="t quest">New quest: Landfall</div></div>` +
  mark(false) +
  mark(true) +
  `<div class="ib">${pixelIcon('star', 28, GOLD_STAR)}</div>` +
  '<span class="cap">Vitals bars · key caps · toasts (sentences) · quest marks: ! on offer, ? to hand in (over heads and on both maps)</span>';

document.documentElement.dataset.ready = '1';
