// #369 (feedback, 2026-11-20 ~22:12Z, 866 sat gone in 337ae01a, load 1342): copy of page-combine-wallets' harness
// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY WALLET THIS BROWSER KEEPS, COMBINED INTO THE ONE THIS TAB PLAYS WITH (plan comment 298, Go
// 2026-10-05). index.html's combineWallets is lifted out of the page by its text and run as it is, against fake wallets: the
// browser's kept phrases (arena.seeds), each with its own e-cash; the current phrase's wallet `main`. Each other wallet with
// e-cash sends it all once, the e-cash is kept in the browser BEFORE it is received, received once into `main`, and the kept
// copy dropped only once the federation reissued it in full (Success, AlreadyReceived; a Rejected is kept as refused, kanban #1149). No balance
// moved twice, none stranded. The page's records are moved by ecash-transfer.js, the bundle's (ARENACLIENT carries it).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as TRANSFER from '../src/ecash-transfer.js';

const PAGE = readFileSync(new URL('../../../src/arena-ui/index.html', import.meta.url), 'utf8');
const SRC = (() => {
  const at = PAGE.indexOf('      const combiningBy = new Map();\n      function combineWallets(main, named, round) {');
  assert.ok(at > 0, 'index.html has no combineWallets');
  const end = PAGE.indexOf('        combiningBy.set(fedHex, run);\n        return run;\n      }\n', at);
  return PAGE.slice(at, end + '        combiningBy.set(fedHex, run);\n        return run;\n      }\n'.length);
})();
const hex = (n) => n.toString(16).padStart(2, '0').repeat(32);
const SEEDS = { cur: hex(1), rich: hex(2), poor: hex(3), none: hex(4), held: hex(5) };
const FED = 'fe'.repeat(32);

// a browser: storage, kept phrases, one fake wallet per phrase (e-cash notes it can send once), and the current tab's main
function browser({ balances, receive = () => 'Success', heldLocks = [], pending = [], blwp = {}, handover = null, failWrite = null } = {}) {
  const store = new Map();
  // a tab that holds a phrase writes its heartbeat; a lock without one is taken over (kanban #803)
  for (const h of heldLocks) store.set('arena.seed.held.' + h.slice(0, 16), JSON.stringify({ at: Date.now() }));
  const L = { getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k),
    setItem: (k, v) => { if (failWrite && failWrite(k, String(v))) { const e = new Error('The quota has been exceeded.'); e.name = 'QuotaExceededError'; throw e; } store.set(k, String(v)); } };
  const proxy = new Proxy(L, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: (t, k) => (store.has(k) ? { enumerable: true, configurable: true, value: store.get(k) } : undefined) });
  L.setItem('arena.seeds', JSON.stringify(Object.values(SEEDS).map((h) => ({ hex: h }))));
  for (const p of pending) L.setItem(p.key, JSON.stringify(p.rec));
  const log = [];
  const received = new Set();
  const wallets = new Map();
  for (const [name, h] of Object.entries(SEEDS)) {
    const w = { name, msat: BigInt(balances[name] ?? 0), entries: name === 'none' ? 0 : 3 };
    w.balanceMsat = async () => String(w.msat);
    w.sendAllEcash = async () => { log.push(`send ${name} ${w.msat}`); if (w.msat === 0n) return JSON.stringify({ ecash: '' }); const msat = w.msat; w.msat = 0n; return JSON.stringify({ ecash: `ecash:${name}:${msat}`, msat: String(msat) }); };
    // ITS OWN NOTES TAKEN BACK (kanban #1149: a browser that cannot keep them after the send)
    w.receiveEcash = async (ecash) => { if (received.has(ecash)) return JSON.stringify({ state: 'Rejected' }); received.add(ecash); w.msat += BigInt(ecash.split(':')[2]); log.push(`receive back ${ecash}`); return JSON.stringify({ state: 'Success', msat: ecash.split(':')[2] }); };
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
  const main = { msat: 0n };
  main.receiveEcash = async (ecash) => {
    const state = receive(ecash, received);
    log.push(`receive ${ecash} ${state}`);
    if (state === 'Success') { if (received.has(ecash)) throw new Error('received twice'); received.add(ecash); main.msat += BigInt(ecash.split(':')[2]); }
    if (state === 'throw') throw new Error('the federation did not answer');
    return JSON.stringify({ state, msat: ecash.split(':')[2] });   // the face value, as the 2.0 lock client's receive says it
  };
  const opened = [];
  const ARENACLIENT = { ...TRANSFER,
    toHex: (b) => (typeof b === 'string' ? b : Buffer.from(b).toString('hex')),
    fromHex: (h) => h,
    phraseWalletEntries: (_L, h, _f, { ancestor = false } = {}) => { const w = (ancestor ? ancestors : wallets).get(h); return w ? w.entries : 0; },
    issuingMsat: async (c) => BigInt((c && c.issuing) || 0n),
    openPlayerWallet: async ({ seed, ancestor }) => { const w = (ancestor ? ancestors : wallets).get(seed); opened.push(w.name); return w; },
  };
  const window = { ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }) };
  // THE OTHER TAB THAT PLAYS WITH A HELD PHRASE (#615), as the page's channel answers for it: `handover` 'answers' sends all and keeps it for the asker
  const asked = [];
  window.ARENA_ASK_HANDOVER = async (phrase16, fed, to16) => {
    asked.push([phrase16, fed, to16]);
    if (handover !== 'answers') return { ok: false, why: 'that tab did not answer in 20 s' };
    const w = [...wallets.entries()].find(([h]) => h.slice(0, 16) === phrase16)[1];
    const sent = JSON.parse(await w.sendAllEcash());
    L.setItem(`arena.ecash.pending.${fed.slice(0, 16)}.1.${phrase16.slice(0, 8)}`, JSON.stringify({ ecash: sent.ecash, msat: sent.msat, from: 'tab', fed, to: to16, at: Date.now() }));
    return { ok: true, msat: sent.msat };
  };
  const locked = [];
  const navigator = { locks: { request: async (name, _o, fn) => { locked.push(name); return fn(heldLocks.some((h) => name === 'arena.phrase.' + h.slice(0, 16)) ? null : { name }); } } };
  const sessionStorage = { getItem: (k) => (k === 'arena.player.seed' ? SEEDS.cur : null) };
  const combineWallets = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['vault', 'sessionStorage', 'ARENACLIENT', 'window', 'navigator', 'paintMoney', 'console'],
    SRC, 'return combineWallets;')(() => proxy, sessionStorage, ARENACLIENT, window, navigator, () => {}, { log: (s) => log.push(s) });
  const run = () => combineWallets(main, { federation: 'fed1invite' }, { federationId: FED });
  const runIn = (fed) => window.ARENA_COMBINE_IN(main, fed, 'fed1invite');
  const pendingKeys = () => [...store.keys()].filter((k) => k.startsWith('arena.ecash.pending.'));
  return { run, runIn, main, wallets, ancestors, log, opened, locked, store, pendingKeys, asked, state: () => window.ARENA_MERGE_STATE,
    total: () => main.msat + [...wallets.values(), ...ancestors.values()].reduce((t, w) => t + w.msat, 0n) };
}


test('#369 a kept phrase whose notes are still being issued (balance 0, issuing 866 sat) is not marked empty, so tidyStorage never removes its database', async () => {
  const b = browser({ balances: { cur: 0, rich: 0, poor: 0, none: 0, held: 0 } });
  b.wallets.get(SEEDS.rich).issuing = 866187n;   // a merge receive / reissue the overloaded federation has not issued yet
  await b.run();
  const mark = b.store.get('arena.wallet.empty.' + SEEDS.rich.slice(0, 16));
  console.log(`  MEASURED #369: opened ${JSON.stringify(b.opened)}; empty mark for rich = ${mark}`);
  assert.ok(b.opened.includes('rich'), 'the merge opened it');
  assert.equal(mark, undefined, 'a wallet with 866 sat being issued was marked empty: the next page\'s tidyStorage removes its database');
});
