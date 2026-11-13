// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE SERIES PUBLISHER'S LINE IS DECIDED ALIKE AT EVERY SEAT (kanban #2638, outside report #054). POST /series-publication kept the
// proven publication at the ONE seat it was posted to, and the publisher line of round 0's settlement (§5A.5, server.js publisherFor ->
// lock-settlement.js 'publisher') was built only where that row stood: a proof posted to some of a round's seats made them build two
// settlements, no group reached the threshold, and the series' paying round never settled. The duty poster never posts the proof and
// tools/round-2of2.mjs posts it seat by seat, so the split came without an attacker too.
// The same tally round of a one-off paying series (protocol 2026.0.9, round 0 naming its creator), its publication confirmed in both
// seats' chain views (20,000 sat in, 18,750 out: a fee of 1,250 sat), two players locked, played and closed - three times:
//   A: no seat holds the proof -> ACCEPTED, no publisher line;
//   B: the proof posted to both seats -> ACCEPTED, the publisher paid 1,250,000 msat;
//   C: the proof posted to seat 0 only -> ACCEPTED as B (red before the fix: never settled).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { bondedChainFor } from './lock-fixture.js';
import { assumeAssigned } from './assignment.js';
import { b32, WINDOW_MS, contractFor, presentDay } from './window-fixture.js';
import { testNow } from './test-clock.js';
import { TALLY, TALLY_CORE, TALLY_CORE_HASH, TALLY_CONFIG_HASH, TALLY_GAME_ID } from './plugins/tally/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { TEST_FEDERATION_ID } from '../../arena-protocol/src/test-federation.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { FRONTEND_FEE_VERSION } from '../../arena-protocol/src/constants.js';
import { encodeRoundContract, roundId } from '../../arena-protocol/src/contracts.js';
import { creatorMessage } from '../../arena-protocol/src/creator.js';
import { seriesRound, seriesId, seriesPublicationOutput } from '../../arena-protocol/src/series.js';
import { parseTransaction } from '../../arena-protocol/src/tx.js';
import { receiptsNeeded } from '../../arena-protocol/src/threshold.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { chainOf } from '../../arena-protocol/tools/chainview.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const STAKE = 100_000_000n;
const DONATION = STAKE * 500n / 10000n;
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const TALLY_ROUND = { donationSetId: donationSetId(NETWORK), gameId: TALLY_GAME_ID, simCoreHash: TALLY_CORE_HASH, configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300 };
const CENSUS_HEIGHT = 900000;   // lock-fixture.js: the bonded chain's census height, its view mined from 20 blocks below
const hex = (u) => Buffer.from(u).toString('hex');

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

// ROUND 0 OF A ONE-OFF PAYING SERIES ON THE STANDING SEATS (lock-round-fixture.js openLockRound, as a series round): the series held by
// both seats, its publication (fee 1,250 sat) in the block after the bonds of the round's chain view, the round opened with its creator's signature
async function openSeriesRound(on, held, tag) {
  const { nodes, slot } = on;
  const creator = b32(0x70 + tag);
  const first = { ...contractFor(nodes.map((d) => d.round.pubkey), BigInt(WINDOW_MS), nodes.map((d) => `http://127.0.0.1:${d.port}`)),
    custody: 'FEDERATION', federationId: TEST_FEDERATION_ID, minScore: 1, stakeMsat: STAKE, ...TALLY_ROUND,
    protocolVersion: FRONTEND_FEE_VERSION, creatorPubkey: schnorr.getPublicKey(creator) };
  const drafted = presentDay(first, testNow() + 3000);
  const bonded = bondedChainFor(drafted.nodes, drafted, slot, { endpoints: nodes.map((d) => `ws://127.0.0.1:${d.port}`), hostedGames: [TALLY_GAME_ID],
    protocolVersions: Array.from({ length: FRONTEND_FEE_VERSION }, (_, i) => i + 1) });
  const t = { ...drafted, censusRoot: bonded.censusRoot, committeeTimeMs: bonded.committeeTimeMs };
  const sid = seriesId(t);
  const c = seriesRound(t, 0);
  const rid = roundId(c);
  const parent = rawTx([[b32(0x90 + tag), 0]], [[20000, P2WPKH]]);
  const pub = rawTx([[parseTransaction(parent).txid, 0]], [[0, [...seriesPublicationOutput(sid).script]], [18750, P2WPKH]]);   // fee 1,250 sat
  const blocks = [];
  for (let h = CENSUS_HEIGHT - 20; h <= CENSUS_HEIGHT + 10; h++) blocks.push({ transactions: h === CENSUS_HEIGHT - 20 ? slot.bonds : [] });
  blocks[1] = { transactions: [pub] };
  slot.views.set(toHex(rid), chainOf(blocks, CENSUS_HEIGHT - 20, { timeOf: (at) => slot.committeeSec + Math.max(0, at - 10) }));
  held.push(t);
  const sig = toHex(schnorr.sign(creatorMessage(rid), creator));
  for (const d of nodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/round?creator=${sig}`, { method: 'POST', body: encodeRoundContract(c) });
    assert.equal(r.status, 201, await r.text());
    assumeAssigned(d.round, rid, c.nodes);
  }
  for (let pass = 0; pass < 2; pass++) for (const d of nodes) await d.dkg.run(c.nodes);
  const k = nodes[0].dkg.signerNodeFor(c.nodes);
  assert.equal(k.ok, true, k.why);
  const beacon = slot.randomnessFor({ contract: c });
  assert.ok(beacon && beacon.hash, 'the bonded chain names no beacon for the round');
  const proof = { series: hex(sid), tx: hex(pub), parents: [hex(parent)] };
  return { ...on, needed: receiptsNeeded(nodes.length), c, rid, claimPk: k.pool.groupPublicKey, randomness: beacon.hash, proof, creator: schnorr.getPublicKey(creator) };
}

test('round 0 of a paying series settles with one publisher line, whichever of its seats the publication proof was posted to', { timeout: 300000 }, async () => {
  const held = [];
  const w = await lockRound({ stakeMsat: STAKE, serveOpts: { plugins: [TALLY], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], series: held }, round: TALLY_ROUND });
  try {
    const play = { adapter: TALLY_CORE.adapter, config: {} };
    const target = { network: NETWORK, game: TALLY.donationSet };
    const run = async (tag, postTo) => {
      const r = await openSeriesRound(w, held, tag);
      const posted = [];
      for (const i of postTo) {
        const got = await fetch(`http://127.0.0.1:${r.nodes[i].port}/series-publication`, { method: 'POST', body: JSON.stringify(r.proof) });
        posted.push(`${got.status} ${(await got.text()).trim()}`);
        assert.equal(got.status, 200, posted.at(-1));
      }
      const high = await lockAndPlay(r, { name: `high${tag}`, key: b32(0x21 + tag), worldSecret: b32(0x31), ticks: 600, words: () => [7, 0, 0, 0, 0] }, { address: true, game: play, donation: { msat: DONATION, target } });
      const low = await lockAndPlay(r, { name: `low${tag}`, key: b32(0x41 + tag), worldSecret: b32(0x32), ticks: 600, words: () => [2, 0, 0, 0, 0] }, { game: play, donation: { msat: DONATION, target } });
      await closeRound(r);
      const s = await untilSettled(r, 40000);
      const pay = (s && s.moved && s.moved.payouts) || [];
      const publisher = pay.filter((p) => p.kind === 'publisher');
      const creatorKey = toHex(refundKeyOf(r.creator));
      console.log(`  #2638 run ${tag} proof at seats [${postTo}] (${posted.join('; ')}): ${s && s.state}${s && s.why ? ` (${s.why})` : ''}; publisher ${JSON.stringify(publisher.map((p) => String(p.msat ?? p.amountMsat)))}`);
      return { state: s && s.state, publisher: publisher.map((p) => BigInt(p.msat ?? p.amountMsat)), toCreator: publisher.every((p) => String(p.payoutPk || p.pubkey || '').toLowerCase().endsWith(creatorKey.slice(2))), players: [high, low] };
    };
    const none = await run(0, []);
    assert.equal(none.state, 'ACCEPTED', 'control A: no seat holds the proof - the round settles');
    assert.deepEqual(none.publisher, [], 'control A: no publisher line');
    const both = await run(1, [0, 1]);
    assert.equal(both.state, 'ACCEPTED', 'control B: the proof at both seats - the round settles');
    assert.deepEqual(both.publisher, [1_250_000n], 'control B: the publisher is paid its 1,250 sat fee back');
    const one = await run(2, [0]);
    assert.equal(one.state, 'ACCEPTED', 'the proof posted to seat 0 only: the seats must still build one settlement and settle');
    assert.deepEqual(one.publisher, [1_250_000n], 'the proof posted to one seat pays the publisher as the proof at every seat does');
  } finally { await w.close(); }
});
