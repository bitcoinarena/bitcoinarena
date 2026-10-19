// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE PAYOUT LOOK WITHOUT JOINING THE ROUND'S OWN WALLET (comment 567: the join froze the lobby 270 ms on
// desktop and 1.1 s on a phone at every load of a tab with an open round). index.html's lookRound runs under the page's
// name (page-script.js) with fake wallets. Measured: with the round's wallet read empty before, a look asks lockStatus of
// the player wallet already open on the same federation and joins nothing; it joins the round's wallet when something is
// owed, when the empty note is missing (and writes it), for another federation, and after 30 s without a player wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const at = HTML.indexOf("    const TAB_EMPTY = 'arena.tabempty.';");
assert.ok(at > 0, 'index.html holds lookRound');
const SRC = HTML.slice(at, HTML.indexOf('\n    }\n', HTML.indexOf('async function lookRound', at)) + '\n    }\n'.length);

const FED = 'ab'.repeat(32), RID = 'cd'.repeat(32);
const round = { roundIdHex: RID, round: { federationId: FED } };
function page({ note = true, warm = 'open', fed = FED, owed = 0n, inTab = 0n, held = true, now = 6000 } = {}) {
  const store = new Map(note ? [['arena.tabempty.' + RID, '1']] : []);
  const vault = () => ({ getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v), removeItem: (k) => store.delete(k) });
  const asked = []; const joins = []; const looks = [];
  const player = { lockStatus: async (t, i) => { asked.push([t, i]); return '{"stored":null}'; }, withdrawableMsat: async () => '999000' };
  const window = { BLWP_WALLET_WARM: warm === 'open' ? Promise.resolve(player) : warm === 'failed' ? Promise.resolve(undefined) : undefined,
    BLWP_WALLET_FEDERATION: fed, BLWP_LOCK_WASM: async () => ({ LockClient: 'LC' }) };
  const BLWPCLIENT = { toHex: (x) => x, lookOwed: async (a) => {
    looks.push(a.client);
    if (a.client.lockStatus) await a.client.lockStatus('tx', 0);
    const tab = typeof a.client.withdrawableMsat === 'function' && a.client !== player ? inTab : 0n;
    return { owedMsat: owed, inTabMsat: tab }; } };
  const roundWallet = async () => { joins.push(1); return held ? { LockClient: 'LC', client: { lockStatus: async () => '{}', withdrawableMsat: async () => String(inTab) } } : null; };
  const run = pageFunction(PAGE, ['vault', 'window', 'BLWPCLIENT', 'roundAsk', 'roundWallet', 'performance'], SRC, 'return lookRound;')(
    vault, window, BLWPCLIENT, () => ({}), roundWallet, { now: () => now });
  return { run: () => run(round), store, asked, joins, looks, player };
}

test('the round\'s wallet read empty before, nothing owed: the player wallet answers lockStatus, nothing is joined', async () => {
  const p = page();
  const r = await p.run();
  assert.equal(p.joins.length, 0, 'no round wallet joined');
  assert.deepEqual(p.asked, [['tx', 0]], 'lockStatus asked of the player wallet');
  assert.deepEqual(Object.keys(p.looks[0]), ['lockStatus'], 'the look is handed lockStatus alone - not the player wallet\'s balance as the round\'s');
  assert.equal(r.held, true); assert.equal(r.look.inTabMsat, 0n); assert.equal(r.LockClient, 'LC');
});

test('something owed: the round\'s own wallet is joined and looked at again before the collect', async () => {
  const p = page({ owed: 98000n });
  const r = await p.run();
  assert.equal(p.joins.length, 1);
  assert.equal(p.looks.length, 2, 'the read-only look, then the look with the round\'s wallet');
  assert.equal(r.look.owedMsat, 98000n);
});

test('no empty note yet: the round\'s wallet is joined once and, read empty, the note is written; ecash in it removes the note', async () => {
  const p = page({ note: false });
  await p.run();
  assert.equal(p.joins.length, 1);
  assert.equal(p.store.get('arena.tabempty.' + RID), '1');
  const q = page({ note: true, owed: 1000n, inTab: 5000n });
  await q.run();
  assert.equal(q.store.has('arena.tabempty.' + RID), false, 'a round wallet holding ecash is looked at with its wallet again');
});

test('a round of another federation, or a player wallet that did not open: the round\'s wallet, as before', async () => {
  const other = page({ fed: 'ee'.repeat(32) });
  await other.run();
  assert.equal(other.joins.length, 1);
  const failed = page({ warm: 'failed' });
  await failed.run();
  assert.equal(failed.joins.length, 1);
});

test('the player wallet not opening yet: no look and no join in the first 30 s, the round\'s wallet after', async () => {
  const early = page({ warm: 'none', now: 5000 });
  const r = await early.run();
  assert.equal(early.joins.length, 0); assert.equal(r.look, null); assert.equal(r.held, true);
  const late = page({ warm: 'none', now: 31000 });
  await late.run();
  assert.equal(late.joins.length, 1);
});

test('the round held by another tab of this browser: not held, nothing looked at', async () => {
  const p = page({ note: false, held: false });
  const r = await p.run();
  assert.equal(r.held, false); assert.equal(r.look, null);
});
