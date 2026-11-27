// kanban #3802 (feedback #588): a faucet claim looped on "storage nearly full - Compress" for ever. room() refused a deposit whenever the
// origin's storage held more than 3.5M characters in total, although the 300,000-character probe still fitted, and Compress reloaded
// with "Room made" without checking. room() is the probe write now; Compress that frees too little says so instead of reloading.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const start = html.indexOf('window.ARENA_MONEY_ALERT = (() => {');
const end = html.indexOf('\n    })();', start);
assert.ok(start > 0 && end > start, 'ARENA_MONEY_ALERT block found');
const src = html.slice(start, end) + '\n    })();';

function quotaStore(quota) {
  const m = new Map();
  const size = () => [...m].reduce((n, [k, v]) => n + k.length + v.length, 0);
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => { const was = m.get(k); m.set(k, String(v)); if (size() > quota) { if (was === undefined) m.delete(k); else m.set(k, was); throw new Error('QuotaExceededError'); } },
    removeItem: (k) => { m.delete(k); } };
}
function page(store) {
  const el = { textContent: '', classList: { add() {}, remove() {}, toggle() {} }, appendChild() {} };
  const w = { ARENA_BROWSER_STORE: () => store, ARENA_TRACK: () => {}, ARENA_TRACK_SIZE: () => 0 };
  const reloads = [];
  const ctx = { window: w, localStorage: store, console: { log() {}, error() {} }, setTimeout, clearTimeout, BigInt, Map, Set, JSON, Number, String, Math, Date,
    document: { getElementById: () => el, createElement: () => ({ onclick: null }), createTextNode: () => ({}) },
    location: { reload: () => reloads.push(1) }, ARENACLIENT: { packWallets: () => 0 } };
  vm.runInNewContext(src, ctx);
  return { alert: w.ARENA_MONEY_ALERT, el, reloads };
}

test('#3802 a deposit is allowed while the probe write fits, even with 3.6M characters already stored', () => {
  const s = quotaStore(5000000); s.setItem('arena.walletdb.kept', 'x'.repeat(3600000));
  const { alert } = page(s);
  assert.equal(alert.room(), true);
  assert.equal(s.getItem('arena.room.probe'), null, 'the probe is removed again');
});

test('#3802 a store that cannot take the probe still asks for room', () => {
  const s = quotaStore(5000000); s.setItem('arena.walletdb.kept', 'x'.repeat(4800000));
  const { alert } = page(s);
  assert.equal(alert.room(), false);
  assert.equal(s.getItem('arena.room.probe'), null);
});

test('#3802 Compress that frees too little says so and does not reload into the same banner', () => {
  const s = quotaStore(5000000); s.setItem('arena.walletdb.kept', 'x'.repeat(4800000));
  const { alert, el, reloads } = page(s);
  alert.needRoom();
  // the Compress button's handler is `fix`; needRoom painted it, reach it through paint's button
  let clicked = null;
  const ctxEl = el; ctxEl.appendChild = (b) => { if (b && 'onclick' in b) clicked = b; };
  alert.paint();
  assert.ok(clicked && typeof clicked.onclick === 'function', 'Compress button painted');
  clicked.onclick();
  assert.equal(reloads.length, 0, 'no reload while there is still no room');
  assert.match(el.textContent, /did not make enough room/);
});

test('#3802 Compress that makes room reloads as before', () => {
  const s = quotaStore(5000000); s.setItem('arena.slowtx', 'x'.repeat(4800000));
  const { alert, el, reloads } = page(s);
  alert.needRoom();
  let clicked = null; el.appendChild = (b) => { if (b && 'onclick' in b) clicked = b; };
  alert.paint(); clicked.onclick();
  assert.equal(reloads.length, 1);
  assert.match(el.textContent, /Room made/);
});
