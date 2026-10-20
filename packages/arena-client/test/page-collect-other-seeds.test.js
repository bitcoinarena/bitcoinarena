// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A CLOSED TAB'S ROUND IS COLLECTED INTO ITS OWN SEED'S WALLET BY A LATER TAB (ruled 2026-10-07): the
// page's own seed keeper picks a later tab's phrase (a kept one no tab holds, the one with the most wallet entries first);
// the page's own keptRecords / withRecordPhrase / roundAsk then walk EVERY saved phrase's records - the collect, the newest
// pick and the owed scan - each collected with the record's seed, never the tab's. A record whose seed no saved phrase holds
// is named uncollectable and paid into no other wallet.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { tabSeed } from '../src/join.js';
import * as PL from '../src/page-lock.js';
import { decodeRoundContract, encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { pageFunction } from './page-script.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const html = readFileSync(PAGE, 'utf8');
const kFrom = html.indexOf('function arenaSeedKeeper('), kTo = html.indexOf('\n    try {\n      window.ARENA_SEED_KEEPER', kFrom);
globalThis.ARENACLIENT = { phraseWalletEntries: PL.phraseWalletEntries };
const Keeper = pageFunction(PAGE, [], html.slice(kFrom, kTo), '; return arenaSeedKeeper;')();
// the page's readers, lifted as they are
const slice = (start, end) => { const a = html.indexOf(start), b = html.indexOf(end, a); assert.ok(a > 0 && b > a, `no slice ${start}`); return html.slice(a, b); };
const readers = pageFunction(PAGE, ['ARENACLIENT', 'vault', 'collectSeed', 'sessionStorage', 'navigator', 'window'], [
  slice('    function withMarketTerms(round) {', '    // ONE TAB AT A TIME USES A KEPT ROUND'),   // roundAsk calls withMarketTerms
  slice('    function keptRecords() {', '    function newestKept() {'),
], '; return { roundAsk, keptRecords, withRecordPhrase };');

// a real contract: the federation the wallets are kept for - in the Arena layout since: the live bytes with
// nextblock's game_id written after the network id
const CONTRACT_HEX = '010001bf876cb1a9cb671ba127e40e242ac9a79d82259ec28f8900f94faf5b1005604d0081b8aa7776c7f3a4c15637da6a256811c87ee2299f82e6bc901f66167cf340bbae68dc11e6e25f3dbb4d225cd52f2d4b32095a61a3bd1d8ced655eed82a5f1d15c39bb83b7cb63ce2b232a7b62b0078d78d9944013ce42799c80a29bf005ef000001a0f9e92000000001a0f9e9200000000000000927c001337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e0000009000000014007b128a1b6d1711fa320b7d1f2fe4bad8720218ac95b4a2d0cb81628ca4ca31b200025bab00000006a86ea4e0608caaebfa921cc3ea2bd17722ee3133f05e99f2b9130048abe33813000001a0f4c2c4000012626974636f696e2d626c6f636b2d6861736800070016687474703a2f2f3132372e302e302e313a33313232310016687474703a2f2f3132372e302e302e313a33313233310016687474703a2f2f3132372e302e302e313a33313234310016687474703a2f2f3132372e302e302e313a33313235310016687474703a2f2f3132372e302e302e313a33313236310016687474703a2f2f3132372e302e302e313a33313237310016687474703a2f2f3132372e302e302e313a3331323831070700000000000186a0000000000000c3502a30000003e800000028000000140000001e00000096000186a0030400072fca10904ca38498e45f073f7d7d8bbcfe8d75ba797fdf381cd6ca9b49e0c528438af56fb35ea4b0509ebd24359c647762cb263f2e99adf6afd3b65e1a1eb0fa5549ca259d4cc2cfa758d37ac422195b722b99d6e18f038274c2b0824e410618a63a3cd4fdfcd4766aafac59051c789081735f6dfc93e9dca7b0a46fb751a510ba8f85d114b78e907e72f9379b49af8b841771723d849eccc33b7a0f40cf3827f4bfe620527f1b8da832e9ec2ef8cafa2bee6742a6e1189559c7f8db0bcbe17cfefa194553c5ccbd851be273a407bfd2d9d11655539f1c2c6d10c88e960be391';
const round = decodeRoundContract(fromHex(CONTRACT_HEX));
const FED = toHex(round.federationId);

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i], get length() { return m.size; } }; };
let clock = 5_000_000, tabs = 0;
const rnd = (n) => { const b = new Uint8Array(n); for (let i = 0; i < n; i++) b[i] = (clock * 7 + i * 13 + n + tabs * 31) & 255; clock += 1; return b; };
function openTab(L) {
  const T = store(), handlers = {}, beats = [];
  const k = Keeper({ L, T, now: () => clock, every: (fn) => beats.push(fn), on: (n, fn) => { handlers[n] = fn; }, random: () => `tab${++tabs}` });
  const seed = tabSeed({ storage: T, random: rnd }); k.beat();
  return { T, seed, hex: toHex(seed), close: () => handlers.pagehide && handlers.pagehide(), tick: () => beats.forEach((f) => f()) };
}
const join = (L, seed, rid) => PL.saveCollect(L, { roundIdHex: rid, round, invite: 'fed1invite', nodes: ['https://n1', 'https://n2'], seed });
const walletOf = (L, seed, n) => { const s = PL.walletSecretFor(seed, round.federationId); L.setItem('arena.ledger.' + FED, '[]');
  for (let i = 0; i < n; i++) L.setItem(`arena.walletdb.${FED.slice(0, 16)}.${toHex(sha256(s)).slice(0, 16)}.${i}`, 'x'); };
// the page's readers in tab `tab`, with a fake browser lock manager (`taken`: phrase locks another tab holds)
function pageOf(L, tab, taken = new Set()) {
  const navigator = { locks: { request: (name, opts, fn) => Promise.resolve(fn(taken.has(name) ? null : { name })) } };
  const BL = { toHex, fromHex, savedCollects: PL.savedCollects, recordsToCollect: PL.recordsToCollect, browserSeedHexes: PL.browserSeedHexes };
  return readers(BL, () => L, () => tab.seed, tab.T, navigator, { ARENA_CURVE: null });
}
// the page's collect step for one record: under its phrase, with roundAsk's seed; answers which wallet it would collect into
async function collectOne(page, r) {
  return page.withRecordPhrase(r, async () => toHex(PL.walletSecretFor(page.roundAsk(r, null).seed, r.round.federationId)));
}

test('case 2: a later tab that takes another kept phrase still collects the closed tab\'s record, into that record\'s own wallet, and shows it', async () => {
  const L = store();
  const y = openTab(L); walletOf(L, y.seed, 3); clock += 2_000; y.tick();
  const a = openTab(L); const rid = 'a2'.repeat(32); join(L, a.seed, rid);
  y.close(); a.close(); clock += 60_000;
  const b = openTab(L);
  assert.equal(b.hex, y.hex, 'the later tab took the kept phrase with the bigger wallet');
  assert.notEqual(b.hex, a.hex);
  const page = pageOf(L, b);
  const k = page.keptRecords();
  const rec = k.collectable.find((r) => r.roundIdHex === rid);
  assert.ok(rec, 'the closed tab\'s record is among the records this tab collects');
  assert.equal(rec.own, false);
  assert.equal(toHex(rec.seed), a.hex, 'the record keeps the seed that joined');
  const into = await collectOne(page, rec);
  assert.equal(into, toHex(PL.walletSecretFor(a.seed, round.federationId)), 'collected into the joining seed\'s wallet');
  assert.notEqual(into, toHex(PL.walletSecretFor(b.seed, round.federationId)), 'not into the later tab\'s preferred wallet');
  assert.equal(k.uncollectable.length, 0);
});

test('case 2, held: a kept phrase another open tab holds is not collected here (one wallet, one tab)', async () => {
  clock = Date.now();                                          // the page reads a heartbeat's age against the real clock
  const L = store();
  const a = openTab(L); const rid = 'b2'.repeat(32); join(L, a.seed, rid);
  clock += 2_000; a.tick();
  const b = openTab(L);                                        // a is still open and beating
  const rec = pageOf(L, b).keptRecords().collectable.find((r) => r.roundIdHex === rid);
  assert.ok(rec && !rec.own);
  assert.equal(await collectOne(pageOf(L, b), rec), null, 'a held phrase was collected by a second tab');
  assert.equal(await collectOne(pageOf(L, b, new Set(['arena.phrase.' + a.hex.slice(0, 16)])), Object.assign(rec, {})), null);
});

test('case 3: a record whose seed no saved phrase holds is named uncollectable and is not redeemed by the preferred wallet', async () => {
  const L = store();
  const lost = tabSeed({ storage: store(), random: rnd });       // a tab-only phrase of a build before 2026-10-01
  const rid = 'c3'.repeat(32); join(L, lost, rid);
  clock += 60_000;
  const b = openTab(L);
  const k = pageOf(L, b).keptRecords();
  assert.equal(k.collectable.some((r) => r.roundIdHex === rid), false, 'an unkept seed\'s record would be collected');
  const u = k.uncollectable.find((r) => r.roundIdHex === rid);
  assert.ok(u, 'the record is not named');
  assert.match(u.why, /no key is left/);
  assert.notEqual(toHex(u.seed), b.hex);
});
