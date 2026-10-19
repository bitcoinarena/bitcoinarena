// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY WALLET THIS BROWSER KEEPS, COMBINED INTO THE ONE THIS TAB PLAYS WITH (plan comment 298, Go
// 2026-10-05). index.html's combineWallets is lifted out of the page by its text and run as it is, against fake wallets: the
// browser's kept phrases (arena.seeds), each with its own e-cash; the current phrase's wallet `main`. Each other wallet with
// e-cash sends it all once, the e-cash is kept in the browser BEFORE it is received, received once into `main`, and the kept
// copy dropped only once the federation reissued it (Success, AlreadyReceived, Rejected). No balance moved twice, none stranded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = readFileSync(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), 'utf8');
const SRC = (() => {
  const at = PAGE.indexOf('      let combining = null;\n      function combineWallets(main, named, round) {');
  assert.ok(at > 0, 'index.html has no combineWallets');
  const end = PAGE.indexOf('        return combining;\n      }\n', at);
  return PAGE.slice(at, end + '        return combining;\n      }\n'.length);
})();
const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);
const SEEDS = { cur: hex(1), rich: hex(2), poor: hex(3), none: hex(4), held: hex(5) };
const FED = 'fe'.repeat(32);

// a browser: storage, kept phrases, one fake wallet per phrase (e-cash notes it can send once), and the current tab's main
function browser({ balances, receive = () => 'Success', heldLocks = [], pending = [], blwp = {} } = {}) {
  const store = new Map();
  const L = { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
  const proxy = new Proxy(L, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: (t, k) => (store.has(k) ? { enumerable: true, configurable: true, value: store.get(k) } : undefined) });
  L.setItem('arena.seeds', JSON.stringify(Object.values(SEEDS).map((h) => ({ hex: h }))));
  for (const p of pending) L.setItem(p.key, JSON.stringify(p.rec));
  const log = [];
  const wallets = new Map();
  for (const [name, h] of Object.entries(SEEDS)) {
    const w = { name, msat: BigInt(balances[name] ?? 0), entries: name === 'none' ? 0 : 3 };
    w.balanceMsat = async () => String(w.msat);
    w.sendAllEcash = async () => { log.push(`send ${name} ${w.msat}`); if (w.msat === 0n) return JSON.stringify({ ecash: '' }); const msat = w.msat; w.msat = 0n; return JSON.stringify({ ecash: `ecash:${name}:${msat}`, msat: String(msat) }); };
    wallets.set(h, w);
  }
  // EACH PHRASE'S BLWP-ERA WALLET: its own e-cash, its own store entries (none unless `blwp` names a balance)
  const ancestors = new Map();
  for (const [name, h] of Object.entries(SEEDS)) {
    const w = { name: name + ' (BLWP)', msat: BigInt(blwp[name] ?? 0), entries: name in blwp ? 2 : 0 };
    w.balanceMsat = async () => String(w.msat);
    w.sendAllEcash = async () => { log.push(`send ${w.name} ${w.msat}`); if (w.msat === 0n) return JSON.stringify({ ecash: '' }); const msat = w.msat; w.msat = 0n; return JSON.stringify({ ecash: `ecash:${name}-blwp:${msat}`, msat: String(msat) }); };
    ancestors.set(h, w);
  }
  const received = new Set();
  const main = { msat: 0n };
  main.receiveEcash = async (ecash) => {
    const state = receive(ecash, received);
    log.push(`receive ${ecash} ${state}`);
    if (state === 'Success') { if (received.has(ecash)) throw new Error('received twice'); received.add(ecash); main.msat += BigInt(ecash.split(':')[2]); }
    if (state === 'throw') throw new Error('the federation did not answer');
    return JSON.stringify({ state });
  };
  const opened = [];
  const BLWPCLIENT = {
    toHex: (b) => (typeof b === 'string' ? b : Buffer.from(b).toString('hex')),
    fromHex: (h) => h,
    phraseWalletEntries: (_L, h, _f, { ancestor = false } = {}) => { const w = (ancestor ? ancestors : wallets).get(h); return w ? w.entries : 0; },
    playerWallet: async ({ seed, ancestor }) => { const w = (ancestor ? ancestors : wallets).get(seed); opened.push(w.name); return w; },
  };
  const window = { ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }) };
  const locked = [];
  const navigator = { locks: { request: async (name, _o, fn) => { locked.push(name); return fn(heldLocks.some((h) => name === 'arena.phrase.' + h.slice(0, 16)) ? null : { name }); } } };
  const sessionStorage = { getItem: (k) => (k === 'arena.player.seed' ? SEEDS.cur : null) };
  const combineWallets = pageFunction(new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url), ['vault', 'sessionStorage', 'BLWPCLIENT', 'window', 'navigator', 'paintMoney', 'console'],
    SRC, 'return combineWallets;')(() => proxy, sessionStorage, BLWPCLIENT, window, navigator, () => {}, { log: (s) => log.push(s) });
  const run = () => combineWallets(main, { federation: 'fed1invite' }, { federationId: FED });
  const pendingKeys = () => [...store.keys()].filter((k) => k.startsWith('arena.ecash.pending.'));
  return { run, main, wallets, ancestors, log, opened, locked, store, pendingKeys,
    total: () => main.msat + [...wallets.values(), ...ancestors.values()].reduce((t, w) => t + w.msat, 0n) };
}

test('every other wallet with e-cash is swept once into this tab\'s; the current phrase is never swept; nothing is lost or counted twice', async () => {
  const b = browser({ balances: { cur: 0, rich: 300000, poor: 0, none: 0, held: 0 } });
  const before = b.total();
  await b.run();
  assert.equal(b.main.msat, 300000n, 'the rich wallet\'s e-cash is in this tab\'s');
  assert.equal(b.wallets.get(SEEDS.rich).msat, 0n);
  assert.equal(b.total(), before, 'nothing created or lost');
  assert.deepEqual(b.log.filter((l) => l.startsWith('send ')), ['send rich 300000'], 'rich sends once; an empty wallet sends nothing');
  assert.ok(!b.opened.includes('cur'), 'the current phrase is not opened');
  assert.ok(!b.opened.includes('none'), 'a phrase with no wallet entries here is not opened');
  assert.deepEqual(b.pendingKeys(), [], 'the kept copy dropped once received');
  assert.equal(b.log.filter((l) => l.startsWith('receive ')).length, 1);
});

test('an empty wallet is noted and not opened again until its store changes', async () => {
  const b = browser({ balances: { poor: 0 } });
  await b.run();
  assert.ok(b.opened.includes('poor'));
  assert.equal(b.store.get('arena.wallet.empty.' + SEEDS.poor.slice(0, 16)), '3', 'noted with its entry count');
  b.opened.length = 0;
  await b.run();
  assert.ok(!b.opened.includes('poor'), 'not opened again while its store is the same');
  b.wallets.get(SEEDS.poor).entries = 4;
  b.wallets.get(SEEDS.poor).msat = 5000n;
  await b.run();
  assert.ok(b.opened.includes('poor'), 'its store changed: opened again');
  assert.equal(b.main.msat, 5000n);
});

test('the e-cash is kept before it is received: a receive that fails leaves the copy, the next page receives it first, once', async () => {
  let fail = true;
  const b = browser({ balances: { rich: 120000 }, receive: () => (fail ? 'throw' : 'Success') });
  await b.run();
  assert.equal(b.main.msat, 0n, 'not received');
  assert.equal(b.wallets.get(SEEDS.rich).msat, 0n, 'sent');
  const kept = b.pendingKeys();
  assert.equal(kept.length, 1, 'the sent e-cash is kept in the browser - not stranded');
  assert.match(JSON.parse(b.store.get(kept[0])).ecash, /^ecash:rich:120000$/);
  fail = false;
  await b.run();
  assert.equal(b.main.msat, 120000n, 'received from the kept copy');
  assert.deepEqual(b.pendingKeys(), []);
  assert.equal(b.log.filter((l) => l.startsWith('send rich')).length, 1, 'sent once in all');
});

test('a kept copy is dropped on Success, AlreadyReceived and Rejected - and kept on any other state', async () => {
  for (const [state, dropped] of [['Success', true], ['AlreadyReceived', true], ['Rejected', true], ['Pending', false], ['Created', false]]) {
    const b = browser({ balances: {}, receive: () => state, pending: [{ key: 'arena.ecash.pending.1.abcd', rec: { ecash: 'ecash:old:7000', msat: '7000', from: 'abcd' } }] });
    await b.run();
    assert.equal(b.pendingKeys().length === 0, dropped, state);
  }
  const bad = browser({ balances: {}, pending: [{ key: 'arena.ecash.pending.2.x', rec: { msat: '1' } }] });
  await bad.run();
  assert.deepEqual(bad.pendingKeys(), [], 'a kept record with no e-cash is dropped');
});

test('a second call while one runs is the same run - nothing swept twice; a phrase another tab holds is skipped', async () => {
  const b = browser({ balances: { rich: 50000 } });
  const [x, y] = [b.run(), b.run()];
  assert.equal(x, y, 'the same promise');
  await x;
  assert.equal(b.log.filter((l) => l.startsWith('send rich')).length, 1);
  assert.equal(b.main.msat, 50000n);
  const held = browser({ balances: { held: 80000, rich: 1000 }, heldLocks: [SEEDS.held] });
  await held.run();
  assert.equal(held.wallets.get(SEEDS.held).msat, 80000n, 'another tab holds that phrase: left where it is');
  assert.ok(!held.opened.includes('held'));
  assert.equal(held.main.msat, 1000n);
});

test('every phrase\'s BLWP-era wallet is swept once into this tab\'s Arena wallet - this tab\'s own phrase\'s too, without its lock ((a))', async () => {
  const b = browser({ balances: { rich: 1000 }, blwp: { cur: 250000, rich: 40000, poor: 0, held: 9000 }, heldLocks: [SEEDS.held] });
  const before = b.total();
  await b.run();
  console.log('  FACTS:', JSON.stringify({ main: String(b.main.msat), sends: b.log.filter((l) => l.startsWith('send ')), locks: b.locked.length }));
  assert.equal(b.main.msat, 250000n + 40000n + 1000n, 'the BLWP-era e-cash and the other phrase\'s Arena e-cash are in this tab\'s wallet');
  assert.equal(b.ancestors.get(SEEDS.cur).msat, 0n, 'this tab\'s own phrase\'s BLWP wallet was not swept');
  assert.equal(b.ancestors.get(SEEDS.held).msat, 9000n, 'a phrase another tab holds: its BLWP wallet left where it is');
  assert.equal(b.total(), before, 'nothing created or lost');
  assert.ok(!b.opened.includes('cur'), 'the current phrase\'s Arena wallet is this tab\'s own, never swept');
  assert.ok(!b.locked.includes('arena.phrase.' + SEEDS.cur.slice(0, 16)), 'this tab took a lock on its own phrase');
  assert.equal(b.store.get('arena.wallet.empty.blwp.' + SEEDS.poor.slice(0, 16)), '2', 'an empty BLWP wallet is noted, apart from its Arena one');
  assert.deepEqual(b.pendingKeys(), [], 'every kept copy received');
  // a second page sweeps nothing again: no e-cash leaves any wallet twice, nothing is counted twice
  const paying = () => b.log.filter((l) => l.startsWith('send ') && !/ 0$/.test(l)).length;
  const paid = paying();
  await b.run();
  assert.equal(paying(), paid, 'a wallet sent e-cash a second time');
  assert.equal(b.main.msat, 291000n, 'nothing counted twice');
});
