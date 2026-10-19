// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SERIES PUBLISHER'S FEE, PROVEN AT THE SEAT (§5A.5, kanban #304; 2026.0.3): POST /series-publication { series, tx, parents }. The tx
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

test('a series\' publication fee is kept only when its tx is the confirmed publication and its parents prove the fee', async () => {
  const t = seriesTemplate({
    networkId: NETWORK_ID_REGTEST, configHash: TRUCK_V3_CONFIG_HASH, censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2,
    gameId: NEXTBLOCK_GAME_ID, simCoreHash: TRUCK_CORE_HASH, committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 0n, entryCloseMs: 0n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID, stakeExpiryBlocks: 144,
    publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000, censusRoot: b32(2), stakeMsat: 0n,
    bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150, minScore: 1,
    rankNumerator: 3, rankDenominator: 4, nodes: [b32(7), b32(8)] }, seriesIndexAt(NETWORK_ID_REGTEST, NOW) - 1);
  const sid = seriesId(t);
  const parent = rawTx([[b32(1), 0]], [[20000, P2WPKH]]);
  const pub = rawTx([[parseTransaction(parent).txid, 0]], [[0, [...seriesPublicationOutput(sid).script]], [18750, P2WPKH]]);   // fee 1250 sat
  const other = rawTx([[parseTransaction(parent).txid, 0]], [[19000, P2WPKH]]);
  const view = { firstHeight: 100, blocks: [{ header: new Uint8Array(80), transactions: [other] }, { header: new Uint8Array(80), transactions: [pub] }] };
  const s = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, funded: () => true, roundClock: () => NOW, series: [t], chainFor: async () => view });
  try {
    const post = async (body) => { const r = await fetch(`http://127.0.0.1:${s.port}/series-publication`, { method: 'POST', body: JSON.stringify(body) }); return { status: r.status, text: (await r.text()).trim() }; };
    const notPub = await post({ series: hex(sid), tx: hex(other), parents: [hex(parent)] });
    const noParent = await post({ series: hex(sid), tx: hex(pub), parents: [] });
    const unknown = await post({ series: 'ab'.repeat(32), tx: hex(pub), parents: [hex(parent)] });
    const good = await post({ series: hex(sid), tx: hex(pub), parents: [hex(parent)] });
    console.log(`  not the publication ${notPub.status}; no parent ${noParent.status} "${noParent.text.slice(0, 60)}"; unknown series ${unknown.status}; proven ${good.status} ${good.text}`);
    assert.equal(notPub.status, 409); assert.match(notPub.text, /not the series' first confirmed publication/);
    assert.equal(noParent.status, 422); assert.match(noParent.text, /was not handed over/);
    assert.equal(unknown.status, 404);
    assert.equal(good.status, 200, good.text);
    assert.deepEqual(JSON.parse(good.text), { txid: toHex(parseTransaction(pub).txid.slice().reverse()), feeSats: '1250', payoutSats: '1250' }, 'the txid as an explorer prints it');
    assert.deepEqual(s.round.seriesPublication(sid), { txid: toHex(parseTransaction(pub).txid), feeSats: 1250n });
  } finally { await s.close(); }
});
