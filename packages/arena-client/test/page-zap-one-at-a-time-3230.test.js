import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
// kanban #3230 (feedback #305): the page's zap box, run against stubs - a zap still paying while the dialog is opened for another player
test('a zap still paying keeps its dialog: no second send, no stale result in the next player dialog', async () => {
const html = readFileSync(fileURLToPath(new URL('../../../src/arena-ui/index.html', import.meta.url)), 'utf8');
const a = html.indexOf('      let job = null, choice = CHOICES[0], busy = false;');
const b = html.indexOf("      document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && box.classList.contains('show')) close(); });", a);
const body = html.slice(a, b);
const rel = []; const release = () => rel.forEach((f) => f()); const sends = [];
const ARENACLIENT = { zapSatLine: (m) => String(m / 1000n) + ' sat', fromHex: (h) => h,
  zapPlayer: (o) => { sends.push(o.player); return new Promise((r) => { rel.push(() => r({ ok: false, why: "no federation of your wallet holds 21 sat" })); }); } };
const v = {}; const box = { classList: { add() {}, remove() {}, contains: () => true }, addEventListener() {} };
const set = (o) => Object.assign(v, o), say = (t, k = '') => set({ st: t, stKind: k }), paint = () => {};
const CHOICES = [21000n]; const window = {};
const itemsKey = () => ({ pubkey: 'k', sign() {} }), donateWallets = async () => [{ msat: 10n ** 9n, c: {}, fid: 'f' }], vault = () => ({}), zapSeats = () => [], nwcUri = () => '';
const f = new Function('ARENACLIENT', 'v', 'box', 'set', 'say', 'paint', 'CHOICES', 'window', 'itemsKey', 'donateWallets', 'vault', 'zapSeats', 'nwcUri', 'RELAYS', 'sign',
  body + '\nreturn { open, send };');
const z = f(ARENACLIENT, v, box, set, say, paint, CHOICES, window, itemsKey, donateWallets, vault, zapSeats, nwcUri, [], null);
await z.open({ recipient: 'aa', name: 'Alice' });
const first = z.send();
await new Promise((r) => setTimeout(r, 10));
await z.open({ recipient: 'bb', name: 'Bob' });
const second = z.send(); await new Promise((r) => setTimeout(r, 10));
release(); await first; await second; await new Promise((r) => setTimeout(r, 10));
assert.equal(sends.length, 1);
assert.ok(!/Bob/.test(v.to || '') || !/Not sent/.test(v.st || ''), 'the first zap result landed in the next dialog');
});
