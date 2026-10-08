// ONE /settled READ OF EACH SIGNER NODE PER OWED SCAN, MATCHED AGAINST EVERY SAVED PHRASE (kanban #153, the owner 2026-10-07):
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

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/BtcLogistics/index.html', import.meta.url);
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
