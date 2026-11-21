// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 refute of #3086: the page's own lookThePending, lifted as it is, over a fake vault, sessionStorage and seats.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as PL from '../src/page-lock.js';
import { decodeRoundContract, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const a = html.indexOf('    async function lookThePending() {');
const b = html.indexOf('    // THE CHAIN\'S TIP FOR THE LINE ABOVE', a);
assert.ok(a > 0 && b > a, 'lookThePending is in the page');
const lift = pageFunction(PAGE, ['ARENACLIENT', 'vault', 'collectSeed', 'collectNote', 'window', 'fetch', 'document', 'paintMoney', 'pendingTip'],
  html.slice(a, b), '; return lookThePending;');

// the same real contract page-collect-other-seeds.test.js uses
const CONTRACT_HEX = '010001bf876cb1a9cb671ba127e40e242ac9a79d82259ec28f8900f94faf5b1005604d0081b8aa7776c7f3a4c15637da6a256811c87ee2299f82e6bc901f66167cf340bbae68dc11e6e25f3dbb4d225cd52f2d4b32095a61a3bd1d8ced655eed82a5f1d15c39bb83b7cb63ce2b232a7b62b0078d78d9944013ce42799c80a29bf005ef000001a0f9e92000000001a0f9e9200000000000000927c001337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e0000009000000014007b128a1b6d1711fa320b7d1f2fe4bad8720218ac95b4a2d0cb81628ca4ca31b200025bab00000006a86ea4e0608caaebfa921cc3ea2bd17722ee3133f05e99f2b9130048abe33813000001a0f4c2c4000012626974636f696e2d626c6f636b2d6861736800070016687474703a2f2f3132372e302e302e313a33313232310016687474703a2f2f3132372e302e302e313a33313233310016687474703a2f2f3132372e302e302e313a33313234310016687474703a2f2f3132372e302e302e313a33313235310016687474703a2f2f3132372e302e302e313a33313236310016687474703a2f2f3132372e302e302e313a33313237310016687474703a2f2f3132372e302e302e313a3331323831070700000000000186a0000000000000c3502a30000003e800000028000000140000001e00000096000186a0030400072fca10904ca38498e45f073f7d7d8bbcfe8d75ba797fdf381cd6ca9b49e0c528438af56fb35ea4b0509ebd24359c647762cb263f2e99adf6afd3b65e1a1eb0fa5549ca259d4cc2cfa758d37ac422195b722b99d6e18f038274c2b0824e410618a63a3cd4fdfcd4766aafac59051c789081735f6dfc93e9dca7b0a46fb751a510ba8f85d114b78e907e72f9379b49af8b841771723d849eccc33b7a0f40cf3827f4bfe620527f1b8da832e9ec2ef8cafa2bee6742a6e1189559c7f8db0bcbe17cfefa194553c5ccbd851be273a407bfd2d9d11655539f1c2c6d10c88e960be391';
export const round = decodeRoundContract(fromHex(CONTRACT_HEX));
export const ROUND_HEX = toHex(encodeRoundContract(round));
export const NODES = ['https://n1', 'https://n2', 'https://n3', 'https://n4', 'https://n5', 'https://n6', 'https://n7'];
export const SEED = new Uint8Array(32).fill(7);
export const SEED_HEX = toHex(SEED);

export const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i], get length() { return m.size; }, _m: m }; };

// the note the join writes since #3086 (committedTo)
export function writeNote(V, S, { roundIdHex, entryIdHex, order = 0, seedHex = SEED_HEX, mine = true }) {
  const key = 'arena.pending.' + roundIdHex + '.' + entryIdHex;
  V.setItem(key, JSON.stringify({ roundIdHex, entryIdHex, nodes: NODES, invite: 'fed1invite', seed: seedHex, order, round: ROUND_HEX }));
  if (mine) { const m = JSON.parse(S.getItem('arena.pending.mine') || '[]'); m.push(key); S.setItem('arena.pending.mine', JSON.stringify(m)); }
  return key;
}

// a page with seats answering /standing per entry: answers[entryIdHex] = the body every seat returns
export function page(V, S, answers) {
  const said = [];
  const AC = { savedCollects: PL.savedCollects, saveCollect: PL.saveCollect, fromHex, toHex, decodeRoundContract,
    pendingWindowLine: () => '', savedLockExpiration: () => null };
  const win = { sessionStorage: S, ARENA_STAKE_BACK: new Map(), ArenaText: { say() {} } };
  const fetch = async (u) => { const e = new URL(u).searchParams.get('entry'); const body = answers[e]; return { ok: !!body, json: async () => body }; };
  const look = lift(AC, () => V, () => SEED, (k, t) => said.push(k + ': ' + t), win, fetch, { getElementById: () => null }, () => {}, () => ({}));
  return { look, said, win };
}
export const payout = (msat) => ({ kind: 'payout', pendingMsat: String(msat), provisional: false, state: 'FINAL', outcome: 'DELIVERED', windowCloseMs: 1 });
export const refund = () => ({ kind: 'refund', pendingMsat: null, provisional: false, state: 'FINAL', why: 'the round is refunded: every stake comes back' });
export const recordsOf = (V, rid) => PL.savedCollects(V, { seed: SEED }).filter((r) => r.roundIdHex === rid);
