// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY ENTRY A TEST BROWSER MAKES ENDS MARKED BOT (kanban #2035, measured 2026-11-12: three RPS entries of a CDP Chrome on the admin's address -
// 794beaab, 00dac9ed, 8f4a6eb5 - were never marked: the page's marker read only the paid lock's notes (arena.pending.*, a saved lock's committedTo,
// a stake row), written once the lock was committed, and those rounds' locks were not; a free entry writes none at all). Now the page names each
// entry id as it goes out - a run's join, a pick's and a hidden move's entry - and an admin browser tells the explorer at once. Measured here with the
// page's own code (index.html) and the explorer's own worker on an in-memory D1: a fresh automated wallet's RPS hidden move and Tick Tock run, with no
// lock note at all, end marked bot and the day's real players stay 0.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { applyPendingMarks } from '../../../src/website/explorer/worker.js';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const MIG = new URL('../../../src/website/explorer/migrations/', import.meta.url);
function store() {
  const db = new DatabaseSync(':memory:');
  for (const f of readdirSync(MIG).sort()) db.exec(readFileSync(new URL(f, MIG), 'utf8'));
  const prepare = (sql) => { const st = { b: [], bind: (...b) => { st.b = b; return st; }, all: async () => ({ results: db.prepare(sql).all(...st.b) }),
    first: async () => db.prepare(sql).get(...st.b) ?? null, run: async () => db.prepare(sql).run(...st.b) }; return st; };
  return { db, env: { DB: { prepare, batch: async (l) => { for (const s of l) await s.run(); } }, EXPLORER: { get: async () => null, put: async () => {} } } };
}
const hex = (n) => n.toString(16).padStart(64, '0');
const T = Date.now() - 60000;
function local() {
  const m = new Map();
  return { get length() { return m.size; }, key: (i) => [...m.keys()][i] ?? null, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const slice = (from, to) => { const a = PAGE.indexOf(from); const b = PAGE.indexOf(to, a); assert.ok(a > 0 && b > a, `${from} in index.html`); return PAGE.slice(a, b); };

// the page's two parts, as index.html has them: ARENA_MADE_ENTRY (first script) and markOwn (the admin block), wired to the explorer's worker
function pageOn({ env, ip, code = null, webdriver = true }) {
  const ls = local(), posts = [];
  const window = { localStorage: ls };
  const navigator = { webdriver };
  const fetch = async (url, o) => {
    posts.push({ url, body: JSON.parse(o.body), keepalive: o.keepalive });
    return worker.fetch(new Request(url, { method: o.method, headers: { 'cf-connecting-ip': ip, 'content-type': 'application/json' }, body: o.body }), env, { waitUntil: () => {} });
  };
  new Function('window', slice('    window.ARENA_MADE_ENTRY = function (idHex) {', '    // THE OLD NAMES, READ ONLY'))(window);
  window.ARENA_BROWSER_STORE = () => ls;
  const markOwn = new Function('window', 'navigator', 'fetch', 'store', 'adminCode',
    slice('      let addressTold = false;', '      if (window.ARENA_ADMIN) {') + '\nreturn markOwn;')(window, navigator, fetch, ls, code);
  return { window, posts, ls, markOwn };
}
const order = (db, id, round, player) => db.prepare(`INSERT INTO txs (id, round, app, federation, stored_ms, settled, hash, json, updated_ms, kind) VALUES (?, ?, ?, 'fe', ?, 'ACCEPTED', 'h', ?, 0, 'order')`)
  .run(id, round, 'rock-paper-scissors', T, JSON.stringify({ entry: { player, stakeMsat: '100000' } }));
const played = async (env) => (await (await worker.fetch(new Request('https://explorer.bitcoinarena.io/api/played'), env, { waitUntil: () => {} })).json()).day[0].all;

test('#2035 a fresh automated wallet on the admin address: its RPS hidden move and its Tick Tock run, with no lock note, are told as bot the moment they go out', async () => {
  const { db, env } = store();
  db.prepare('INSERT INTO admin_ips (ip, at_ms) VALUES (?, ?)').run('203.0.113.7', Date.now());
  const p = pageOn({ env, ip: '203.0.113.7' });
  p.window.ARENA_ADMIN_REPORT = () => p.markOwn(true);   // as the page sets it once GET /api/admin-ip says admin
  // the entries go out (index.html calls ARENA_MADE_ENTRY right before submitPick and client.join); nothing else is in the browser's store
  p.window.ARENA_MADE_ENTRY(hex(1)); await new Promise((r) => setTimeout(r, 20));
  p.window.ARENA_MADE_ENTRY(hex(2).toUpperCase()); await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(p.posts.map((x) => [x.url, x.body.kind, x.body.keys, x.keepalive]), [
    ['https://explorer.bitcoinarena.io/api/mark-ip', 'bot', [hex(1)], true],
    ['https://explorer.bitcoinarena.io/api/mark-ip', 'bot', [hex(2)], true]]);
  // the browser closes; the explorer reads both orders on its next poll
  order(db, hex(1), hex(900), hex(50)); order(db, hex(2), hex(901), hex(51));
  await applyPendingMarks(env);
  assert.deepEqual(db.prepare('SELECT key, kind FROM marked ORDER BY key').all().map((x) => [x.key, x.kind]), [[hex(1), 'bot'], [hex(2), 'bot']]);
  const day = await played(env);
  assert.equal(day.realPlayers, 0); assert.equal(day.bot, 2);
  // the next tick sends nothing again
  await p.markOwn(true); assert.equal(p.posts.length, 2);
});

test('#2035 an entry made before the admin answer is told by the first report; with the admin code an automated browser marks bot, a person\'s owner', async () => {
  for (const [webdriver, kind] of [[true, 'bot'], [false, 'owner']]) {
    const { db, env } = store();
    const p = pageOn({ env, ip: '198.51.100.20', code: 'the-code', webdriver });
    p.window.ARENA_MADE_ENTRY(hex(3));   // no ARENA_ADMIN_REPORT yet: kept
    assert.equal(p.posts.length, 0);
    assert.deepEqual(JSON.parse(p.ls.getItem('arena.made.entries')), [hex(3)]);
    await p.markOwn(false);
    assert.equal(p.posts.length, 1);
    assert.equal(p.posts[0].url, 'https://explorer.bitcoinarena.io/api/mark');
    assert.equal(p.posts[0].body.kind, kind); assert.deepEqual(p.posts[0].body.keys, [hex(3)]);
    // the test code is not this site's: the worker refuses it, and the page keeps it for the next report (nothing counted as sent)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM marked').get().n, 0);
    assert.equal(p.ls.getItem('arena.admin.marked'), null);
  }
});

test('#2035 index.html names every entry before it goes out: each submitPick call and the run join', () => {
  const at = (re) => [...PAGE.matchAll(re)].map((m) => m.index);
  const picks = at(/ARENACLIENT\.submitPick\(/g);
  assert.equal(picks.length, 2, 'a pick and a hidden move');
  for (const i of picks) assert.match(PAGE.slice(i - 400, i), /window\.ARENA_MADE_ENTRY\(ARENACLIENT\.toHex\(ARENACLIENT\.entryId\(entry\)\)\)/);
  const join = PAGE.indexOf('client.join = async function (entry) {');
  const sent = PAGE.indexOf('const out = await join(entry);', join);
  assert.match(PAGE.slice(join, sent), /window\.ARENA_MADE_ENTRY\(ARENACLIENT\.toHex\(ARENACLIENT\.entryId\(entry\)\)\)/);
  // and the admin's report runs at once, not only after 5 s
  assert.match(PAGE, /byIp\(\); setTimeout\(byIp, 5000\)/);
  assert.match(PAGE, /report\(\); setTimeout\(report, 5000\)/);
});
