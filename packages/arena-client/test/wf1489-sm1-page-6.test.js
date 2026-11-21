// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state-machine audit (release 2026.1.9.29 step 0), area page, sm1-page-6 (SM-C6 merge runs x the empty mark, gap in #3140):
// A KEPT PHRASE'S WALLET THAT HOLDS SPENDABLE NOTES AND NOTES STILL BEING ISSUED IS MARKED EMPTY RIGHT AFTER ITS SPENDABLE PART IS SENT.
// #3140 (feedback #369) stopped the merge from marking a wallet empty when it reads 0 with notes issuing - but only on the first read. A wallet
// that reads 100 sat spendable AND 866 sat issuing is sent its 100 sat, and the merge's last line, `if (balanceMsat() === 0n) noteEmpty()`,
// asks no issuingMsat: arena.wallet.empty.<fed>.<phrase> = its entry count, its remembered balance dropped. The issuing notes are not in the
// balance, so no later merge opens that wallet again (wanted(): mark === entries), and the next page load's tidyStorage removes its database
// (mark === entries) - the #369 loss again, by the wallet that had a few spendable sat too. The #3140 recover-once does not help: its
// arena.recover.tried.<fed>.<phrase> is written on EVERY open (entriesOf(..) >= 0 is always true), so the phrase opened by this very merge
// is never opened again after the tidy.
// Driven: index.html's combineIn lifted by its text (page-merge-issuing-369's harness), two merge passes over one browser.
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
const SEEDS = { cur: hex(1), rich: hex(2) };
const FED = 'fe'.repeat(32);

function browser({ balances }) {
  const store = new Map();
  const L = { getItem: (k) => (store.has(k) ? store.get(k) : null), removeItem: (k) => store.delete(k), setItem: (k, v) => { store.set(k, String(v)); } };
  const proxy = new Proxy(L, { ownKeys: () => [...store.keys()], getOwnPropertyDescriptor: (t, k) => (store.has(k) ? { enumerable: true, configurable: true, value: store.get(k) } : undefined) });
  L.setItem('arena.seeds', JSON.stringify(Object.values(SEEDS).map((h) => ({ hex: h }))));
  const log = [];
  const received = new Set();
  const wallets = new Map();
  for (const [name, h] of Object.entries(SEEDS)) {
    const w = { name, msat: BigInt(balances[name] ?? 0), entries: 3, issuing: 0n };
    w.balanceMsat = async () => String(w.msat);
    w.sendAllEcash = async () => { log.push(`send ${name} ${w.msat}`); if (w.msat === 0n) return JSON.stringify({ ecash: '' }); const msat = w.msat; w.msat = 0n; return JSON.stringify({ ecash: `ecash:${name}:${msat}`, msat: String(msat) }); };
    w.receiveEcash = async (ecash) => { received.add(ecash); w.msat += BigInt(ecash.split(':')[2]); return JSON.stringify({ state: 'Success', msat: ecash.split(':')[2] }); };
    wallets.set(h, w);
  }
  const main = { msat: 0n };
  main.balanceMsat = async () => String(main.msat);
  main.receiveEcash = async (ecash) => {
    if (received.has(ecash)) throw new Error('received twice');
    received.add(ecash); main.msat += BigInt(ecash.split(':')[2]);
    log.push(`receive ${ecash} Success`);
    return JSON.stringify({ state: 'Success', msat: ecash.split(':')[2] });
  };
  const opened = [];
  const ARENACLIENT = { ...TRANSFER,
    toHex: (b) => (typeof b === 'string' ? b : Buffer.from(b).toString('hex')),
    fromHex: (h) => h,
    phraseWalletEntries: (_L, h, _f, { ancestor = false } = {}) => { if (ancestor) return 0; const w = wallets.get(h); return w ? w.entries : 0; },
    issuingMsat: async (c) => BigInt((c && c.issuing) || 0n),
    openPlayerWallet: async ({ seed }) => { const w = wallets.get(seed); opened.push(w.name); return w; },
  };
  const window = { ARENA_LOCK_WASM: async () => ({ default: async () => {}, LockClient: {} }), ARENA_ASK_HANDOVER: async () => ({ ok: false, why: 'none' }) };
  const navigator = { locks: { request: async (name, _o, fn) => fn({ name }) } };
  const sessionStorage = { getItem: (k) => (k === 'arena.player.seed' ? SEEDS.cur : null) };
  const combineWallets = pageFunction(new URL('../../../src/arena-ui/index.html', import.meta.url), ['vault', 'sessionStorage', 'ARENACLIENT', 'window', 'navigator', 'paintMoney', 'console'],
    SRC, 'return combineWallets;')(() => proxy, sessionStorage, ARENACLIENT, window, navigator, () => {}, { log: (s) => log.push(s), error: (s) => log.push(s) });
  const run = () => combineWallets(main, { federation: 'fed1invite' }, { federationId: FED });
  return { run, main, wallets, log, opened, store };
}

test('wf1489-sm1-page-6: a kept wallet with 100 sat spendable and 866 sat still issuing is not marked empty after its 100 sat are sent, and the next merge pass reads it again', async () => {
  const b = browser({ balances: { cur: 0, rich: 100000 } });
  const rich = b.wallets.get(SEEDS.rich);
  rich.issuing = 866187n;   // a reissue the overloaded federation has not issued yet (feedback #369), beside 100 sat already spendable
  await b.run();
  const mark = b.store.get('arena.wallet.empty.' + FED.slice(0, 16) + '.' + SEEDS.rich.slice(0, 16)) ?? b.store.get('arena.wallet.empty.' + SEEDS.rich.slice(0, 16));
  const known = b.store.get('arena.wallet.known.' + FED.slice(0, 16) + '.' + SEEDS.rich.slice(0, 16));
  // the second pass, while the 866 sat are still being issued (or issued after the client closed: the store's entry count is unchanged)
  await b.run();
  const opens = b.opened.filter((n) => n === 'rich').length;
  console.log(`  FACTS: main received ${b.main.msat} msat; rich still issuing ${rich.issuing} msat; empty mark after pass 1 = ${mark} (entries ${rich.entries}); `
    + `remembered balance = ${known}; rich opened ${opens} time(s) in two passes; recover-tried = ${b.store.get('arena.recover.tried.' + FED.slice(0, 16) + '.' + SEEDS.rich.slice(0, 16))}`);
  assert.equal(b.main.msat, 100000n, 'the spendable 100 sat merged');
  assert.equal(mark, undefined, 'a wallet with 866 sat still being issued was marked empty (mark = its entry count): tidyStorage removes its database on the next load');
  assert.ok(opens >= 2, 'the next merge pass never opens the wallet whose notes are still being issued');
});
