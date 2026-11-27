// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 bypass of #1485 (feedback #010) through its twins #2634 / #3694: THE FULL-TABLE CHECK SPARES EVERY HANDOUT OF A SEATED PLAYER KEY.
// takeHandout's "table is full" count leaves out every seated entry of the handout's own player key (meant for a reload re-posting the same
// handout), so a second, different order of a player already seated - two tabs of one imported seed tapping the same table, the second racing
// the first - is taken at POST /handout AND at the page's pre-lock recheck (#3694, join.h2hLockRecheck) on a table that is full. The page then
// makes the stake and fee lock and every seat refuses its entry "already seats ... 2 players": a lock for an order the seats refuse, the #010 loss.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, rand, playFor, warmPlay, secretScalar } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { headToHeadCommit } from '../../arena-protocol/src/head-to-head.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { dealHandout, encodeHandout, handoutId } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { feldmanGroup } from '../src/curve.js';
import { netStakeMsat } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat, entryFeeBpsOf } from '../../arena-protocol/src/fee.js';
import { entryGiftsInFee, entryFeeBpsForRound } from '../../arena-protocol/src/reserves.js';
import { pluginForRound } from '../src/plugins.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { sha256 } from '../../arena-protocol/src/hash.js';
import * as join from '../../arena-client/src/join.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const P_KEY = b32(0x5a);   // ONE player key: two tabs of one imported seed derive the same key for the same round (playerFor, order 0)
const P = () => ({ name: 'p', key: P_KEY, worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const Q = { name: 'q', key: b32(0x5b), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] };
const salt = () => new Uint8Array(randomBytes(32));
const feeBps = (w) => { const f = pluginForRound(w.c, w.nodes[0].round.plugins); if (!f.ok) return undefined;
  return entryGiftsInFee(w.c, f.plugin.manifest) ? entryFeeBpsForRound(w.c, f.plugin.manifest) : entryFeeBpsOf(f.plugin.manifest); };

// THE PAGE'S ORDER (index.html: postHandout, then funding + lockStake, then the entry): step 1, the handout to every seat
async function pageHandout(w, who) {
  const preimage = secretScalar(), e = rand(32);
  const dealt = await dealHandout({ preimage, signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: who.key, ephemeralSecret: e,
    ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: (w.needed || 2) - 1 }, () => scalarFrom32(rand(32)) % FIELD),
    needed: w.needed || 2, curve: feldmanGroup });
  assert.equal(dealt.ok, true, dealt.why);
  const said = [];
  for (const d of w.nodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) });
    said.push(`${r.status} ${(await r.text()).slice(0, 100)}`);
  }
  return { preimage, dealt, said };
}
// step 2 + 3: the stake and fee lock made at the federation on the seats' 201, then the entry
async function pageLockAndEnter(w, who, { preimage, dealt }, move) {
  const session = ed25519.utils.randomSecretKey();
  await warmPlay(who, w.randomness);
  const feeSecret = rand(32), outpoint = { txid: rand(32), outIdx: 0n }, feeOutpoint = { txid: rand(32), outIdx: 1n };
  const entry = {
    roundId: w.rid, playerPubkey: who.key, sessionPubkey: ed25519.getPublicKey(session),
    stakeCommitment: sha256(preimage), stakeMsat: w.c.stakeMsat, feeMsat: entryFeeMsat(w.c.stakeMsat, feeBps(w)), donationMsat: 0n,
    joinTick: 0, worldSecret: playFor(who, w.randomness).worldSecret, vssSharesRef: handoutId(dealt.handout), stakePoint: dealt.handout.commitments[0],
    feePreimage: feeSecret, stakeLockOutpoint: outpoint, feeLockOutpoint: feeOutpoint, claimKeyAttestationRef: b32(0x9a),
  };
  entry.commit = headToHeadCommit({ roundId: w.rid, entryKey: entry.sessionPubkey, move, salt: salt() });
  const span = w.c.stakeExpiryBlocks > 144 ? w.c.stakeExpiryBlocks : 200;
  const fields = { paymentImage: { kind: 'point', bytes: entry.stakePoint }, amountMsat: netStakeMsat(entry), claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + span };
  // THE LOCK IS MADE (money moves at the federation) - the page does this on the handout's 201, before any entry
  await w.port.put(outpoint, fields);
  await w.port.put(feeOutpoint, { paymentImage: { kind: 'hash', bytes: sha256(feeSecret) }, amountMsat: entry.feeMsat, claimPk: w.claimPk,
    refundPk: refundKeyOf(who.key), expiration: w.port.height + span });
  const said = [];
  for (const d of w.nodes) {
    const r = await fetch(`http://127.0.0.1:${d.port}/entry`, { method: 'POST', body: encodeEntryContract(entry) });
    said.push(`${r.status} ${(await r.text()).slice(0, 120)}`);
  }
  return said;
}

test('#1489 bypass-late-lock 1: a second order of a seated player key passes the handout door and the #3694 recheck on a full table - locked, then refused everywhere', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, h2hHandoutLeadMs: 0 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const nodes = w.nodes.map((d) => `http://127.0.0.1:${d.port}`);
    const needed = w.needed || 2;
    // tab B of player P taps the table: its handout reaches every seat while a seat is free (201)
    const b = await pageHandout(w, P());
    // meanwhile Q sits down, and P's tab A (same key, its own order) sits down too: the table is full
    await lockAndPlay(w, Q, { hidden: { move: ROCK, salt: salt() }, noMarks: true });
    await lockAndPlay(w, P(), { hidden: { move: SCISSORS, salt: salt() }, noMarks: true });
    // tab B's funding is done: the page's pre-lock recheck posts its handout again (#3694)
    const stake = { body: encodeHandout(b.dealt.handout), handout: { needed } };
    const preLock = await join.h2hLockRecheck({ stake, nodes, needed, put: null, entryCloseMs: w.c.entryCloseMs, leadMs: 0 });
    // a stranger's handout at that moment, for comparison: "table is full"
    const r = await pageHandout(w, { ...Q, key: b32(0x5c) });
    const left = Number(w.c.entryCloseMs) - testNow();
    // the recheck said lock: the page locks and posts the entry, long before the close
    const bEntry = preLock === null ? await pageLockAndEnter(w, P(), b, PAPER) : null;
    console.log('  FACTS (#1489 bypass-late-lock-1):', JSON.stringify({ bHandout: b.said, preLock, stranger: r.said, msBeforeClose: left, bEntry }));
    assert.ok(b.said.every((s) => s.startsWith('201')), 'precondition: tab B\'s handout was taken while a seat was free');
    assert.ok(r.said.every((s) => /^409 .*table is full/.test(s)), `precondition: the table is full: ${JSON.stringify(r.said)}`);
    assert.ok(left > 0, `the test ran out of window: ${left} ms`);
    // THE EFFECT: the recheck must refuse on a full table - otherwise the lock is made and every seat refuses the entry
    assert.ok(preLock !== null, `the #3694 recheck let tab B lock on a full table; its entry: ${JSON.stringify(bEntry)}`);
  } finally { await w.close(); }
});
