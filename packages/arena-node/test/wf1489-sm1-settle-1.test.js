// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-sm1-settle-1: A ROUND THAT TAKES ANY FEDERATION READS SETTLED WITH ONE FEDERATION'S PART NEVER MADE.
// (fixture copied from federation-settle-seat.test.js)
// #settleFederations writes a federation's row only once that federation's transaction is signed (SUBMITTING before its submit). A federation
// whose part failed before that - its port not reachable this pass, fewer than the threshold committed (a peer rebuilt other bytes: the #803 case),
// a share withheld - has NO row. round.js settlementState and closedLockRoundsUnsettled read only the rows there are: every row ACCEPTED is
// "settled". So with federation A's part landed and B's part never built, the round reads ACCEPTED (late settlements, forfeits, the nostr results
// go on), and retryUnsettled - the one path that asks a closed round again (#803) - never lists it: B's losers' locks go back to them at expiry
// and B's winners are never paid. Safe: while a federation of the round's split holds no ACCEPTED row the round is not settled, and it is retried.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement, federationPlans } from '../src/settlement.js';
import { openStore, CLOSED } from '../src/store.js';
import { Round } from '../src/round.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5f);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const fedOfPlayer = new Map([[1, A], [3, A], [4, B]]);
const locks = new Map([W1, L1, L2].map((e, i) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + Number(e.pubkey[0])), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE, refundPk: refund(e.pubkey[0]) }]));
const PLAN = federationPlans({ roundId: RID, entries: [W1, L1, L2], minScore: 1, locks, feeLocks: new Map() },
  { federationOf: (o) => fedOfPlayer.get(Number(o.outIdx)), feesOf: (f) => (f === A ? { ppm: 0n, baseMsat: 1000n } : { ppm: 0n, baseMsat: 0n }) });

// THE FEDERATIONS' PORTS: each builds bytes from the claims, payouts and nonce it is handed, and accepts a submit only when the
// signature verifies under the claim key over exactly those bytes - as the guardians check a settlement
function fedPort(fid, log) {
  const bytesOf = ({ claims, payouts, nonce }) => sha256(new TextEncoder().encode(JSON.stringify({ fid, c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${c.amountMsat}`),
    p: payouts.map((p) => `${toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  return {
    fees: async () => (fid === A ? { ppm: 0n, baseMsat: 1000n } : { ppm: 0n, baseMsat: 0n }),
    settle: async ({ claimPk, claims, payouts, nonce, signature }) => {
      const msg = bytesOf({ claims, payouts, nonce });
      if (!signature) return { message: toHex(msg), txid: toHex(msg) };
      const accepted = schnorr.verify(signature, msg, claimPk.subarray(1));
      log.push({ fid, claims: claims.map((c) => Number(c.outpoint.outIdx)), payouts: payouts.map((p) => [toHex(p.payoutPk).slice(0, 6), p.msat]), nonce: toHex(nonce), accepted });
      // AS THE TOOL ANSWERS (kanban #1171, #1172): an accepted submit's payouts stored and its claimed locks gone
      return accepted ? { accepted: true, payoutsStored: payouts.map(() => ({ stored: true })), locksAfter: claims.map(() => null) } : { accepted: false, error: 'bad signature' };
    },
  };
}


test('wf1489 sm1-settle-1: one federation\'s part never built leaves the round unsettled and retried', async () => {
  assert.equal(PLAN.ok, true, PLAN.why);
  const G = evenGroupSecret(0x51515n, curve);
  const deal = trustedDealerSplit({ secret: G.secret, max: 2, min: 2, coefficients: [0x77n], curve });
  const claimPk = deal.groupPublicKey;
  const log = [];
  const ports = { [A]: fedPort(A, log), [B]: fedPort(B, log) };
  let bDown = true;   // federation B's guardians not reachable from the asker for this one pass
  const routerOf = (id) => ({ forFederation: async (f) => (id === 1 && f === B && bDown ? null : ports[f] || null), settle: async () => { throw new Error('never the home port'); } });
  const contract = { stakeMsat: STAKE, protocolVersion: 3, federationId: new Uint8Array(32), nodes: [pk(0xa1), pk(0xa2)], settlementSlots: 2, minScore: 1 };
  const nodes = [];
  for (const id of [1, 2]) {
    const round = new Round(openStore(':memory:'));
    const ls = new LockSettlement(round, { dkg: {}, port: routerOf(id), curve, random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) }, peersFor: () => (id === 1 ? ['http://peer2'] : []) });
    ls.planOf = async () => ({ ok: true, anyFed: true, plan: PLAN.plan, split: PLAN.split, contract, claimPk,
      held: { signerNode: deal.shares[id - 1] }, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])) });
    nodes.push(ls);
  }
  nodes[0].fetcher = async (url, o) => {
    const u = new URL(url); const fed = u.searchParams.get('federation'); const two = nodes[1];
    const ok = (bytes) => ({ ok: true, arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length), text: async () => '' });
    const no = (why) => ({ ok: false, text: async () => why });
    if (u.pathname === '/settle-commit') { const g = await two.commit(RID, { txid: u.searchParams.get('txid'), federation: fed }); return g.ok ? ok(encodeCommitments([g.commitment])) : no(g.why); }
    if (u.pathname === '/settle-share') { const g = await two.share(RID, decodeCommitments(new Uint8Array(o.body)), { federation: fed }); return g.ok ? ok(encodeShare(g.share)) : no(g.why); }
    if (u.pathname === '/settle-signature') { const g = await two.take(RID, o.body, { federation: fed }); return g.ok ? ok(new Uint8Array(0)) : no(g.why); }
    return no('no such door');
  };
  const V3 = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
    gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
    objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32),
    stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
    censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
    timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3 });
  for (const n of nodes) n.round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: V3 } : null);
  // the round is closed at the asker, with a stake lock: what retryUnsettled lists (#803)
  const MIN = 60000, now = Date.now();
  const db = nodes[0].round.db;
  db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms, closed_ms) VALUES (?, ?, ?, ?, ?)').run(RID, V3, CLOSED, now - 31 * MIN, now - 30 * MIN);
  db.prepare('INSERT INTO stake_locks (entry_id, round_id, outpoint, fields, contract_id, verified_ms) VALUES (?, ?, ?, ?, ?, ?)').run(L2.entryId, RID, `${toHex(b32(0x44))}:4`, '{}', 'c', now - 30 * MIN);
  const listed = () => nodes[0].round.closedLockRoundsUnsettled(0, now - 15 * MIN).map((r) => toHex(r));
  assert.deepEqual(listed(), [toHex(RID)], 'before any settlement the closed round is listed for a retry');

  const got = await nodes[0].settle(RID);
  console.log('  SETTLE:', got.why);
  assert.equal(got.ok, false, 'B\'s part was not built this pass');
  assert.equal(log.filter((x) => x.fid === A && x.accepted).length, 1, 'A\'s transaction landed');
  assert.equal(log.filter((x) => x.fid === B).length, 0, 'B\'s transaction was never submitted');
  const rows = nodes[0].round.fedLockSettlementsOf(RID).map((r) => [r.federation, r.state]);
  console.log('  ROWS:', JSON.stringify(rows));
  console.log('  settlementState:', nodes[0].round.settlementState(RID), ' retry list:', JSON.stringify(listed()));
  // THE INVARIANT: B's losers are not claimed and B's winners not paid, so the round is not settled here, and it stays asked again
  assert.notEqual(nodes[0].round.settlementState(RID), 'ACCEPTED', 'the round reads ACCEPTED while federation B\'s part was never made');
  assert.deepEqual(listed(), [toHex(RID)], 'the round left the retry list while federation B\'s part was never made');
});
