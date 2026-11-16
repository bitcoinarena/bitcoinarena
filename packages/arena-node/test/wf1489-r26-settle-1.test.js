// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SERIES PUBLISHER'S FEE, PROVEN AT THE SEAT (§5A.52026.0.3): POST /series-publication { series, tx, parents }. The tx
// must be the series' first confirmed publication on the seat's own chain, its parents must prove its fee; then the seat keeps it and
// answers what the publisher is paid back (min(fee, 10,000 sat)). Anything else is refused by name.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { TRUCK_CORE_HASH, TRUCK_V3_CONFIG_HASH, NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';
import { seriesTemplate, seriesIndexAt, seriesId, seriesPublicationOutput } from '../../arena-protocol/src/series.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const NOW = 1790600000000;
function rawTx(inputs, outputs) {
  const b = [];
  const u32 = (n) => b.push(n & 255, (n >>> 8) & 255, (n >>> 16) & 255, (n >>> 24) & 255);
  u32(2); b.push(inputs.length);
  for (const [txid, vout] of inputs) { b.push(...txid); u32(vout); b.push(0); u32(0xffffffff); }
  b.push(outputs.length);
  for (const [sats, script] of outputs) { let v = BigInt(sats); for (let i = 0; i < 8; i++) { b.push(Number(v & 255n)); v >>= 8n; } b.push(script.length, ...script); }
  u32(0);
  return Uint8Array.from(b);
}
const P2WPKH = [0x00, 0x14, ...new Array(20).fill(7)];
const hex = (u) => Buffer.from(u).toString('hex');


// kanban #1489 r26: ONE PUBLICATION FEE IS PAID BACK ONCE. A creator's one transaction with two OP_RETURN outputs publishes two series
// (commitmentsOf reads every output); each series' proof is taken with the same txid and the same fee, so the publisher is paid
// min(fee, 10,000 sat) out of the nodes' fee in round 0 of EACH series - N series, one fee paid to the miners, N fees back.
test('wf1489 r26: one publication transaction is reimbursed for one series only', async () => {
  const mk = (back) => seriesTemplate({
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
    gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144,
    publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n,
    bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes: [b32(7), b32(8)] }, seriesIndexAt(NETWORK_ID_REGTEST, NOW) - back);
  const t1 = mk(1), t2 = mk(2);
  const s1 = seriesId(t1), s2 = seriesId(t2);
  assert.notEqual(hex(s1), hex(s2));
  const parent = rawTx([[b32(1), 0]], [[20000, P2WPKH]]);
  // ONE transaction, fee 8,000 sat, publishing BOTH series
  const pub = rawTx([[parseTransaction(parent).txid, 0]], [[0, [...seriesPublicationOutput(s1).script]], [0, [...seriesPublicationOutput(s2).script]], [12000, P2WPKH]]);
  const view = { firstHeight: 100, blocks: [{ header: new Uint8Array(80), transactions: [pub] }] };
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [t1, t2], chainFor: async () => view });
  try {
    const post = async (body) => { const r = await fetch(`http://127.0.0.1:${s.port}/series-publication`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, text: (await r.text()).trim() }; };
    const a = await post({ series: hex(s1), tx: hex(pub), parents: [hex(parent)] });
    const b = await post({ series: hex(s2), tx: hex(pub), parents: [hex(parent)] });
    const k1 = s.round.seriesPublication(s1), k2 = s.round.seriesPublication(s2);
    console.log(`  series 1: ${a.status} ${a.text}`);
    console.log(`  series 2: ${b.status} ${b.text}`);
    console.log(`  kept: s1 ${k1 && k1.txid.slice(0, 16)} fee ${k1 && k1.feeSats}; s2 ${k2 && k2.txid.slice(0, 16)} fee ${k2 && k2.feeSats}`);
    const paidBack = [k1, k2].filter(Boolean).reduce((t, k) => t + (k.feeSats < 10000n ? k.feeSats : 10000n), 0n);
    console.log(`  publisher paid back ${paidBack} sat in all for one fee of 8000 sat`);
    assert.ok(paidBack <= 8000n, `one publication fee of 8000 sat is paid back ${paidBack} sat across two series`);
  } finally { await s.close(); }
});
