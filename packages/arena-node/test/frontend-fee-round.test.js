// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE WEBSITE'S SHARE IN A PAYING LOCK ROUND, END TO END (roadmap item 7; RULED 2026-10-15, path (a): "Take it
// out of the nodes' 5% fee, 20% of that fee, so nodes earn less ... The player's stake is not increased by this fee"). The same
// tally round twice on the same two seats: once with no website, once at 2026.0.9 with both entries naming one. The settlement's
// lines are compared to the msat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, openLockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { TALLY, TALLY_CORE, TALLY_CORE_HASH, TALLY_CONFIG_HASH, TALLY_GAME_ID } from './plugins/tally/index.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { FRONTEND_FEE_VERSION } from '../../arena-protocol/src/constants.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const STAKE = 100_000_000n;
const DONATION = STAKE * 500n / 10000n;
const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const TALLY_ROUND = { donationSetId: donationSetId(NETWORK), gameId: TALLY_GAME_ID, simCoreHash: TALLY_CORE_HASH, configHash: TALLY_CONFIG_HASH, blockTicks: 600, startDeadlineTicks: 300 };
const SITE = (() => { const k = new Uint8Array(33).fill(0x5e); k[0] = 2; return k; })();
const sum = (xs) => xs.reduce((a, b) => a + b, 0n);

/** The settlement transaction that claims these players' locks: its lines by kind. */
function linesOf(w, players) {
  const ours = new Set(players.flatMap((p) => [p.outpoint, p.feeOutpoint]).map((o) => toHex(o.txid)));
  const tx = w.port.settlements.find((s) => s.claims.some((c) => ours.has(toHex(c.outpoint.txid))));
  assert.ok(tx, 'no settlement transaction claims this round\'s locks');
  const playerKeys = new Set(players.map((p) => toHex(refundKeyOf(p.entry.playerPubkey))));
  const site = toHex(SITE);
  return {
    players: tx.payouts.filter((p) => playerKeys.has(toHex(p.payoutPk))).map((p) => p.msat),
    website: tx.payouts.filter((p) => toHex(p.payoutPk) === site).map((p) => p.msat),
    nodes: tx.payouts.filter((p) => !playerKeys.has(toHex(p.payoutPk)) && toHex(p.payoutPk) !== site).map((p) => p.msat),
    claims: tx.claims.map((c) => c.amountMsat),
  };
}

test('the website is paid 20% of the nodes\' 5% from the fee locks; the nodes earn that much less; the players pay and get exactly what they would', async () => {
  const w = await lockRound({ stakeMsat: STAKE, serveOpts: { plugins: [TALLY], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] }, round: TALLY_ROUND });
  try {
    const play = { adapter: TALLY_CORE.adapter, config: {} };
    const target = { network: NETWORK, game: TALLY.donationSet };
    const run = async (r, tag, frontendPk) => {
      const high = await lockAndPlay(r, { name: `high${tag}`, key: b32(0x21 + tag), worldSecret: b32(0x31), ticks: 600, words: () => [7, 0, 0, 0, 0] }, { address: true, game: play, donation: { msat: DONATION, target }, frontendPk });
      const low = await lockAndPlay(r, { name: `low${tag}`, key: b32(0x41 + tag), worldSecret: b32(0x32), ticks: 600, words: () => [2, 0, 0, 0, 0] }, { game: play, donation: { msat: DONATION, target }, frontendPk });
      await closeRound(r);
      const s = await untilSettled(r);
      return { s, players: [high, low], lines: linesOf(r, [high, low]) };
    };
    const plain = await run(w, 0, null);
    const v9 = await openLockRound(w, { stakeMsat: STAKE, round: { ...TALLY_ROUND, protocolVersion: FRONTEND_FEE_VERSION } });
    const site = await run(v9, 1, SITE);
    const fee = (STAKE * 2n * 500n) / 10000n;                        // the nodes' 5% of the gross: 10,000,000 msat
    const facts = {
      feeLocksEach: [plain, site].map((r) => r.players.map((p) => p.entry.feeMsat)),
      stakeEach: [plain, site].map((r) => r.players.map((p) => p.entry.stakeMsat)),
      nodesPaid: [sum(plain.lines.nodes), sum(site.lines.nodes)], websitePaid: site.lines.website, playersPaid: [plain.lines.players, site.lines.players],
      claimed: [sum(plain.lines.claims), sum(site.lines.claims)],
    };
    console.log('  FRONTEND:', JSON.stringify(facts, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.deepEqual(facts.feeLocksEach, [[entryFeeMsat(STAKE), entryFeeMsat(STAKE)], [entryFeeMsat(STAKE), entryFeeMsat(STAKE)]], 'a player\'s fee lock is the same 5%');
    assert.deepEqual(facts.stakeEach, [[STAKE, STAKE], [STAKE, STAKE]], 'a player\'s stake is not increased');
    assert.deepEqual(facts.playersPaid[0], facts.playersPaid[1], 'the players are paid exactly the same lines');
    assert.equal(plain.lines.website.length, 0);
    assert.deepEqual(site.lines.website, [fee / 5n], 'the website is paid 20% of the nodes\' fee (the mock federation charges no fee)');
    assert.equal(facts.nodesPaid[0], fee);
    assert.equal(facts.nodesPaid[1], fee - fee / 5n, 'the nodes earn exactly that much less');
    assert.equal(facts.claimed[0], facts.claimed[1], 'the same locks are claimed');
  } finally { await w.close(); }
});

// THE SAME ON AN ORDER BOOK (comment 2295): the test Up/Down market (node 0.5% + donation 0.5%), two 10,000 sat orders,
// YES and NO at 0.50, both filled, Up wins - once with no website, once at 2026.0.9 with both orders naming one.
test('an order book pays the website 20% of the nodes\' part of its fees; the nodes 20% less; donation and players unchanged', { timeout: 170000 }, async () => {
  const { UPDOWN, UPDOWN_TERMS, UPDOWN_PERIOD_MS } = await import('./plugins/updown/index.js');
  const { marketExpiryBlocks } = await import('../../arena-protocol/src/lock-expiry.js');
  const P = Number(UPDOWN_PERIOD_MS);
  const expiryFor = (c) => marketExpiryBlocks(c, UPDOWN_TERMS).blocks;
  const { testNow, skipTo } = await import('./test-clock.js');
  const { attestorSign } = await import('./plugins/sign.js');
  const { encodeAttestation } = await import('../../arena-protocol/src/attested.js');
  const { YES, NO } = await import('../../arena-protocol/src/order-book.js');
  const { NEXTBLOCK } = await import('../../nextblock/plugin/nextblock.js');
  const { standing } = await import('./lock-round-fixture.js');
  const { wait } = await import('./window-fixture.js');
  const B = 500;
  const STAKE_B = 10_000_000n;
  const ROUND = { gameId: UPDOWN.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 900000n };
  const w = await lockRound({ n: 2, stakeMsat: STAKE_B, round: ROUND, endMs: testNow() + 1800000, alignCloseMs: P, stakeExpiryFor: expiryFor,
    serveOpts: { plugins: [NEXTBLOCK, UPDOWN.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], orderBatchTimer: false } });
  try {
    for (const d of w.nodes) d.orderBook.intervalMs = B;
    const [A0, A1] = UPDOWN.attestors;
    const run = async (r, tag, frontendPk) => {
      // orders from the market's window on (entry_close - its period), never before (updown-market.test.js)
      skipTo(Math.max(Number(r.c.committeeTimeMs), Number(r.c.entryCloseMs) - P) + 100);
      const who = (n) => ({ name: `o${tag}${n}`, key: b32(0x60 + 16 * tag + n), worldSecret: b32(0), ticks: 1, words: () => [0, 0, 0, 0, 0] });
      const yes = await lockAndPlay(r, who(1), { noMarks: true, pick: YES, order: { price: 50000n }, frontendPk });
      const no = await lockAndPlay(r, who(2), { noMarks: true, pick: NO, order: { price: 50000n }, frontendPk });
      const k = Math.floor(testNow() / B);
      while (testNow() < (k + 1) * B + 20) await wait(5);
      const leader = r.nodes.find((d) => d.orderBook.leads(r.rid, k));
      const got = await leader.orderBook.lead(r.rid, k);
      assert.equal(got.certified, true, got.why);
      skipTo(Number(r.c.entryCloseMs) + 2 * B + 10);
      await closeRound(r, { window: false });
      const body = { roundId: r.rid, outcome: YES, observedAtMs: r.c.entryCloseMs + 1n };
      const rid = toHex(r.rid);
      await Promise.all(r.nodes.map((d) => fetch(`http://127.0.0.1:${d.port}/outcome?round=${rid}`, { method: 'POST', body: encodeAttestation({ ...body, signatures: [A0, A1].map((a) => attestorSign(a, body)) }) })));
      const o = await (await fetch(`http://127.0.0.1:${r.nodes[0].port}/outcome?round=${rid}`)).json();
      skipTo(Number(o.finalAtMs) + 100);
      let s;
      for (const stop = Date.now() + 60000; Date.now() < stop; await wait(250)) {
        s = await standing(r.a, r);
        if (s.state === 'ACCEPTED') break;
        await Promise.all(r.nodes.map((d) => d.settlements.settle(r.rid).catch(() => null)));
      }
      assert.equal(s.state, 'ACCEPTED', s.why);
      const pay = s.moved.payouts;
      const of = (kind) => pay.filter((p) => p.kind === kind).map((p) => BigInt(p.msat ?? p.amountMsat));
      return { players: [yes, no], nodes: of('signer node'), website: of('frontend'), donation: sum(of('donation key')),
        winners: of('qualifier'), fee: [yes, no].map((p) => p.entry.feeMsat), stake: [yes, no].map((p) => p.entry.stakeMsat) };
    };
    const plain = await run(w, 0, null);
    const v9 = await openLockRound(w, { stakeMsat: STAKE_B, endMs: testNow() + 1800000, alignCloseMs: P, stakeExpiryFor: expiryFor, round: { ...ROUND, protocolVersion: FRONTEND_FEE_VERSION } });
    for (const d of v9.nodes) d.orderBook.intervalMs = B;
    const site = await run(v9, 1, SITE);
    console.log('  BOOK FRONTEND:', JSON.stringify({ plain: { nodes: plain.nodes, donation: plain.donation, winners: plain.winners, fee: plain.fee, stake: plain.stake },
      site: { nodes: site.nodes, website: site.website, donation: site.donation, winners: site.winners, fee: site.fee, stake: site.stake } }, (k, v) => (typeof v === 'bigint' ? String(v) : v)));
    assert.deepEqual(plain.nodes, [50000n, 50000n]);
    assert.deepEqual(site.nodes, [40000n, 40000n], 'the nodes earn 20% less');
    assert.deepEqual(site.website, [20000n]);
    assert.equal(plain.website.length, 0);
    assert.deepEqual([plain.donation, site.donation], [100000n, 100000n]);
    assert.deepEqual([plain.winners, site.winners], [[19800000n], [19800000n]]);
    assert.deepEqual([plain.fee, site.fee, plain.stake, site.stake], [[100000n, 100000n], [100000n, 100000n], [STAKE_B, STAKE_B], [STAKE_B, STAKE_B]]);
  } finally { await w.close(); }
});
