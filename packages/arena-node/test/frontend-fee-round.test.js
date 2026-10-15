// THE WEBSITE'S SHARE IN A PAYING LOCK ROUND, END TO END (kanban #362 roadmap item 7; RULED the owner 2026-10-15, path (a): "Take it
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
