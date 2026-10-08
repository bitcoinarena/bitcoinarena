// THE GEAR FROM THE FIRST PAINT (kanban #200: Settings waited 2.6-5.1 s for Unity's lobby). The page's own code runs
// under the page's name (page-script.js) on a small fake page. Measured: the strip with the gear is up over the loading
// screen, Unity's title and the lobby, and gone over a round's own screens and while driving; the backup warning and the
// balance strip stay over the lobby alone; a click on the gear opens Settings at once, before the page's main script,
// and that script fills the panel once - on its own catch-up if the click came first, on the click otherwise.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const slice = (from, to) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(to, a) + to.length); };
const PAINT = slice('    function paintMoney() {', '\n    }\n');
const EARLY = slice("  document.getElementById('blwp-settings-go').addEventListener('click', () => {", '\n  });');
const CATCH_UP = slice('    if (window.BLWP_SETTINGS_EARLY && settingsPanel()', '\n');

const LOBBY = { showing: true, lobby: true, screen: [430, 932], balance: [56, 468, 318, 34] };

function strip({ unity = true, boot = false, lobby = LOBBY, driving = false }) {
  const els = {};
  const el = (id) => (els[id] = els[id] || { id, textContent: '', style: {} });
  for (const id of ['blwp-money', 'blwp-settings', 'blwp-lobby-balance', 'blwp-backup-notice', 'blwp-backup-warn', 'blwp-settings-backup',
    'blwp-lobby-confirmed', 'blwp-bal-confirmed', 'blwp-lobby-pending', 'blwp-bal-pending', 'blwp-balance-line', 'blwp-money-why']) el(id);
  const canvas = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 430, height: 932 }) };
  const document = { getElementById: (id) => (id === 'canvas' ? canvas : id === 'boot' ? (boot ? {} : null) : els[id] || null) };
  const window = { BLWP_UNITY_LOBBY: lobby, BLWP_WALLET_BALANCE: null, unityInstance: unity ? {} : undefined };
  const BLWPCLIENT = { backupLine: () => 'This wallet has no backup.', NO_BACKUP_LINE: 'This wallet has no backup.' };
  pageFunction(PAGE, ['document', 'window', 'BLWPCLIENT', 'drivingNow', 'backupStore', 'walletSeed', 'isBackedUp'], PAINT, 'return paintMoney();')(
    document, window, BLWPCLIENT, () => driving, () => ({}), () => 'seed', () => false);
  return { money: els['blwp-money'].style.display, warn: els['blwp-backup-warn'].style.display, balance: els['blwp-lobby-balance'].style.display };
}

test('the strip with the gear is up from the loading screen on: before Unity, over its title, over the lobby', () => {
  assert.deepEqual(strip({ unity: false, boot: true, lobby: undefined }), { money: '', warn: 'none', balance: 'none' }, 'the loading screen: the gear alone');
  assert.deepEqual(strip({ lobby: { showing: true, lobby: false } }), { money: '', warn: 'none', balance: 'none' }, 'Unity\'s title, no lobby: the gear alone');
  assert.deepEqual(strip({}), { money: '', warn: 'flex', balance: 'flex' }, 'the lobby: the gear, the warning and the balance, as before');
});

test('over a round\'s own screens and while driving the strip is gone', () => {
  assert.equal(strip({ lobby: { showing: false } }).money, 'none', 'Unity left the lobby (cargo panel, drive)');
  assert.equal(strip({ driving: true }).money, 'none');
});

function page() {
  const listeners = {};
  const panel = { style: { display: 'none' } };
  const document = { getElementById: (id) => (id === 'blwp-settings' ? panel
    : id === 'blwp-settings-go' ? { addEventListener: (ev, fn) => { listeners[ev] = fn; } } : null) };
  const window = {};
  pageFunction(PAGE, ['document', 'window'], EARLY)(document, window);
  return { click: () => listeners.click(), panel, window };
}

test('a click before the main script: Settings opens at once, and the main script fills it once when it arrives', () => {
  const { click, panel, window } = page();
  click();
  assert.equal(panel.style.display, '', 'open on the click, with no bundle, wallet or Unity');
  let filled = 0;
  window.BLWP_PAINT_SETTINGS = () => { filled++; };
  const catchUp = pageFunction(PAGE, ['window', 'settingsPanel'], CATCH_UP);
  catchUp(window, () => panel);
  catchUp(window, () => panel);
  assert.equal(filled, 1, 'filled once, not on every pass');
});

test('a click after the main script: opened and filled on the click, once', () => {
  const { click, panel, window } = page();
  let filled = 0;
  window.BLWP_PAINT_SETTINGS = () => { filled++; };
  pageFunction(PAGE, ['window', 'settingsPanel'], CATCH_UP)(window, () => panel);
  assert.equal(filled, 0, 'nothing to catch up on: Settings was never opened');
  click();
  assert.equal(panel.style.display, '');
  assert.equal(filled, 1);
});

test('the gear has one click handler: the main script no longer adds its own', () => {
  assert.equal(HTML.split("getElementById('blwp-settings-go').addEventListener").length - 1, 1);
});
