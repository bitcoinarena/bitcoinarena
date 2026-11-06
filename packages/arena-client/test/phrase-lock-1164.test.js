// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1164 (the 2026-11-06 state-machine audit): ONE TAB PER PHRASE - the phrase's lock was stolen from a live tab.
//
// The page's own arenaSeedKeeper and withRecordPhrase, lifted from index.html, on fake storages and fake Web Locks that can be stolen and
// released; the merge's lock calls read from the page; the wallet open (openPlayerWallet) behind the keeper's gate. On the old page each
// test fails: the measure is the FACTS line each prints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { tabSeed, restoreSeed } from '../src/join.js';
import * as PL from '../src/page-lock.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';

const PAGE_URL = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE_URL, 'utf8');
const from = html.indexOf('function arenaSeedKeeper(');
const Keeper = pageFunction(PAGE_URL, [], html.slice(from, html.indexOf('\n    try {\n      window.ARENA_SEED_KEEPER', from)), '; return arenaSeedKeeper;')();
const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), map: m }; };
const settle = () => new Promise((r) => setTimeout(r, 5));
let clock = 5_000_000; let tabs = 0;
const rnd = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (clock * 3 + i * 7 + n) & 255; clock += 1; return b; };

/** Web Locks as a browser has them, one origin: held names, waiters queued, `steal(name)` takes a lock from its holder (its request rejects AbortError). */
function browserLocks() {
  const held = new Map(); const queue = new Map();
  const grant = (name, cb, done, fail) => {
    const h = { done, fail };
    held.set(name, h);
    Promise.resolve().then(() => cb({ name })).then((v) => { if (held.get(name) === h) { held.delete(name); next(name); } done(v); }, fail);
  };
  const next = (name) => { const q = queue.get(name); if (q && q.length) { const w = q.shift(); grant(name, w.cb, w.done, w.fail); } };
  return {
    held, query: async () => ({ held: [...held.keys()].map((name) => ({ name })) }),
    request(name, opts, cb) {
      if (typeof opts === 'function') { cb = opts; opts = {}; }
      return new Promise((done, fail) => {
        if (opts.steal) { const h = held.get(name); if (h) { held.delete(name); h.fail(Object.assign(new Error('the lock was stolen'), { name: 'AbortError' })); } grant(name, cb, done, fail); return; }
        if (!held.has(name)) { grant(name, cb, done, fail); return; }
        if (opts.ifAvailable) { Promise.resolve().then(() => cb(null)).then(done, fail); return; }
        if (!queue.has(name)) queue.set(name, []);
        queue.get(name).push({ cb, done, fail });
      });
    },
  };
}
const openTab = (L, locks, T = store()) => {
  let reloads = 0;
  const k = Keeper({ L, T, now: () => clock, every: () => {}, on: () => {}, random: () => `tab${++tabs}`, locks, reload: () => { reloads++; } });
  const seed = Buffer.from(tabSeed({ storage: T, random: rnd })).toString('hex');
  k.beat();
  return { T, k, seed, reloads: () => reloads };
};

test('#1164 nothing in the page steals a phrase\'s lock (old: the merge stole it after 120 s without a heartbeat)', () => {
  const steals = [...html.matchAll(/locks\.request\([^;]*steal:\s*true/g)].length;
  console.log('  FACTS #1164 steals in the page:', steals);
  assert.equal(steals, 0, 'the page still takes a lock from a tab that holds it');
});

test('#1164 a lock taken from a live tab anyway (an older page) is a transition: lost, and the tab reloads so its wallet client stops (old: no handler, the client ran on)', async () => {
  const unhandled = []; const on = (e) => unhandled.push(e && e.name); process.on('unhandledRejection', on);
  try {
    const L = store(); const locks = browserLocks();
    const a = openTab(L, locks);
    await settle();
    const before = a.k.state ? a.k.state() : 'no state';
    // ANOTHER (OLDER) PAGE STEALS IT, as the merge did
    locks.request('arena.phrase.' + a.seed.slice(0, 16), { steal: true }, () => new Promise(() => {}));
    await settle();
    const facts = { before, after: a.k.state ? a.k.state() : 'no state', reloads: a.reloads(), unhandled: unhandled.length };
    console.log('  FACTS #1164 stolen:', JSON.stringify(facts));
    assert.equal(a.reloads(), 1, 'the tab whose lock was taken went on with its wallet client');
    assert.deepEqual([facts.before, facts.after], ['held', 'lost']);
  } finally { process.off('unhandledRejection', on); }
});

test('#1164 while another tab\'s collect holds the phrase, this tab\'s wallet does not open: it waits for the lock (old: only the reload waited)', async () => {
  const L = store(); const locks = browserLocks();
  const a = openTab(L, locks); const p = a.seed; await settle();
  // the first tab closes: its phrase is free to be taken - and another tab's collect takes its lock for a moment
  locks.held.clear(); clock += 60_000; L.removeItem('arena.seed.held.' + p.slice(0, 16));
  let releaseCollect; locks.request('arena.phrase.' + p.slice(0, 16), () => new Promise((r) => { releaseCollect = r; }));
  L.setItem('arena.seed.collecting.' + p.slice(0, 16), JSON.stringify({ at: clock }));
  await settle();
  const b = openTab(L, locks);
  assert.equal(b.seed, p, 'precondition: the new tab took the kept phrase');
  await settle();
  // THE WALLET OPEN, BEHIND THE KEEPER'S GATE (the page hands it: useWalletGate(keeper.ready))
  const joins = [];
  class Fake { static async join() { joins.push('join'); return new Fake(); } async balanceMsat() { return '0'; } }
  if (PL.useWalletGate && b.k.ready) PL.useWalletGate((hex) => b.k.ready(hex));
  const opening = PL.openPlayerWallet({ federationId: TEST_FEDERATION_ID, invite: 'fed11x', seed: Uint8Array.from(Buffer.from(p, 'hex')), LockClient: Fake, storage: store() });
  await settle();
  const whileCollecting = { state: b.k.state ? b.k.state() : 'no state', joins: joins.length, reloads: b.reloads() };
  releaseCollect();
  await opening; await settle();
  const facts = { whileCollecting, after: { state: b.k.state ? b.k.state() : 'no state', joins: joins.length } };
  console.log('  FACTS #1164 collecting:', JSON.stringify(facts));
  if (PL.useWalletGate) PL.useWalletGate(null);
  assert.equal(whileCollecting.joins, 0, 'the wallet opened while another tab\'s collect held the phrase');
  assert.equal(whileCollecting.reloads, 0);
  assert.deepEqual([whileCollecting.state, facts.after.state, facts.after.joins], ['waiting', 'held', 1]);
});

test('#1164 a restore reads the phrase\'s lock, not a heartbeat\'s age; the collect takes another phrase by its lock alone (old: clock checks first)', () => {
  const hex = 'cd'.repeat(32);
  const T = store(); const K = store();
  // the other tab is hidden: its heartbeat is a minute old, its lock is held
  K.setItem('arena.seed.held.' + hex.slice(0, 16), JSON.stringify({ tab: 'hidden', at: clock - 60_000 }));
  const got = restoreSeed({ text: hex, session: T, kept: K, now: clock, heldElsewhere: (h) => h === hex });
  const wrp = html.slice(html.indexOf('function withRecordPhrase('), html.indexOf('function newestKept('));
  const facts = { restore: got.ok ? 'restored' : got.why, heartbeatReadFirst: wrp.indexOf("'arena.seed.held.'") < wrp.indexOf("if (!navigator.locks") };
  console.log('  FACTS #1164 restore:', JSON.stringify(facts));
  assert.equal(got.ok, false, 'a phrase another tab holds was restored here because its heartbeat was old');
  assert.equal(facts.heartbeatReadFirst, false, 'withRecordPhrase reads a heartbeat\'s age before the lock');
});
