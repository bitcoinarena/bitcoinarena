// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE /settled READ OF EACH SIGNER NODE PER OWED SCAN, MATCHED AGAINST EVERY SAVED PHRASE (2026-10-07):
// measured on 0.0.2842 (comment 695), the scan asked 7 x the kept phrases - 14 for 2, 21 for 3, 49 for a 7-phrase browser.
// index.html's own findTheRoundsOwed, lifted, with the real findOwedRounds and a counting fetch: 7 signer nodes, 3 phrases.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import * as PL from '../src/page-lock.js';
import { playerFor } from '../src/join.js';
import { pageCurve } from '../src/page-curve.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { decodeRoundContract, encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const PAGE = new URL('../../../src/arena-ui/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const SCAN = HTML.slice(HTML.indexOf('    const OWED_LOOKBACK_MS = 24 * 3600 * 1000;'), HTML.indexOf('    // THE SAME SCAN, ASKED BY THE LIVE HARNESS'));
const CONTRACT_HEX = readFileSync(new URL('./page-collect-other-seeds.test.js', import.meta.url), 'utf8').match(/CONTRACT_HEX = '([0-9a-f]+)'/)[1];

const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k),
  key: (i) => [...m.keys()][i], get length() { return m.size; } }; };

test('3 kept phrases, 7 signer nodes: one /settled read per node; a round owed to a kept phrase is kept under that phrase', async () => {
  const curve = pageCurve;
  const seeds = [1, 2, 3].map((n) => new Uint8Array(32).fill(n));
  const L = store(); L.setItem('arena.seeds', JSON.stringify(seeds.slice(1).map((s) => ({ hex: toHex(s), from: 'minted', at: 1 }))));
  const contract = decodeRoundContract(fromHex(CONTRACT_HEX)); const id = toHex(roundId(contract));
  const owedTo = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed: seeds[2], curve }).pubkey));      // the third phrase's key
  const nodes = [1, 2, 3, 4, 5, 6, 7].map((k) => `https://n${k}`);
  const asked = [];
  globalThis.fetch = async (url) => {
    asked.push(url);
    if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: [{ id, payouts: [owedTo], refunds: [] }] }) };
    if (url.includes('/round?id=')) return { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
    return { ok: false };
  };
  const BL = { ...PL, findOwedRounds: PL.findOwedRounds, tabSeed: () => seeds[0], toHex, fromHex };
  const window = { BLWP_CURVE: curve, sessionStorage: null };
  const scan = pageFunction(PAGE, ['BLWPCLIENT', 'vault', 'collectSeed', 'window', 'lookThePayout', 'crypto'], [SCAN], 'return findTheRoundsOwed;')(
    BL, () => L, () => seeds[0], window, () => {}, { getRandomValues: (a) => a });
  const found = await scan({ nodes, federation: 'fed1invite' });
  const settled = asked.filter((u) => u.includes('/settled?')).length;
  assert.equal(settled, 7, `${settled} /settled asks for 3 phrases on 7 signer nodes`);
  assert.deepEqual(found, [id]);
  const kept = PL.savedCollects(L, { seed: seeds[2] });
  assert.equal(kept.length, 1, 'the round owed to the third phrase is kept under it');
  assert.equal(PL.savedCollects(L, { seed: seeds[0] }).length, 0, 'and not under the tab\'s own');
});

// NO WALLET YET: behind the start screen collectSeed() is null; the scan waits for the first seed instead of
// throwing "Cannot read properties of null (reading 'length')", and asks the signer nodes only once there is one
test('a fresh browser behind the start screen: the scan waits for the wallet, then reads each signer node once', async () => {
  const seed = new Uint8Array(32).fill(9);
  const L = store();
  const nodes = [1, 2, 3].map((k) => `https://n${k}`);
  const asked = [];
  globalThis.fetch = async (url) => { asked.push({ url, at: Date.now() }); return url.includes('/settled?') ? { ok: true, json: async () => ({ rounds: [] }) } : { ok: false }; };
  let reads = 0, minted = 0;
  const collect = () => { reads += 1; if (reads < 3) return null; if (!minted) minted = Date.now(); return seed; };
  const BL = { ...PL, findOwedRounds: PL.findOwedRounds, tabSeed: () => seed, toHex, fromHex };
  const window = { BLWP_CURVE: pageCurve, sessionStorage: null };
  const errors = []; const was = console.error; console.error = (m) => errors.push(String(m));
  try {
    const scan = pageFunction(PAGE, ['BLWPCLIENT', 'vault', 'collectSeed', 'window', 'lookThePayout', 'crypto'], [SCAN], 'return findTheRoundsOwed;')(
      BL, () => L, collect, window, () => {}, { getRandomValues: (a) => a });
    const found = await scan({ nodes, federation: 'fed1invite' });
    assert.deepEqual(found, []);
  } finally { console.error = was; }
  assert.deepEqual(errors, [], 'no error at a fresh load');
  assert.equal(reads, 3, 'the seed read until there is one');
  assert.equal(asked.filter((a) => a.url.includes('/settled?')).length, 3, 'each signer node read once');
  assert.ok(asked.every((a) => a.at >= minted), 'no signer node asked before the wallet exists');
});

// A CONTRACT READ ONCE IS KEPT (2026-10-16: "Lower the amount of concurrent connections and network load";
// measured on live UI 158, one run, 60 s window: GET /round 208): the id is the contract's hash, so a second scan does not read it again
test('a second owed scan does not read the round contract again', async () => {
  PL.forgetOwedRounds();
  const seed = new Uint8Array(32).fill(5);
  const contract = decodeRoundContract(fromHex(CONTRACT_HEX)); const id = toHex(roundId(contract));
  const mine = toHex(refundKeyOf(playerFor({ id: fromHex(id) }, { seed, curve: pageCurve }).pubkey));
  const nodes = ['https://n1', 'https://n2'];
  const asked = [];
  const fetcher = async (url) => {
    asked.push(url);
    if (url.includes('/settled?')) return { ok: true, json: async () => ({ rounds: [{ id, payouts: [mine], refunds: [] }] }) };
    if (url.includes('/round?id=')) return { ok: true, arrayBuffer: async () => encodeRoundContract(contract).buffer.slice(0) };
    return { ok: false };
  };
  const first = await PL.findOwedRounds({ seed, curve: pageCurve, nodes, fetcher });
  const second = await PL.findOwedRounds({ seed, curve: pageCurve, nodes, fetcher });
  assert.deepEqual([first.length, second.length], [1, 1]);
  assert.equal(toHex(roundId(second[0].round)), id);
  assert.equal(asked.filter((u) => u.includes('/round?id=')).length, 1, 'the contract read once for two scans');
});
