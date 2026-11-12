// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-sm3-settle-1 (state machine audit, round 3): a round that takes any federation, settled in federation A while federation B
// was not reached in that pass, reads ACCEPTED here (settlementState counts only the rows it holds) and drops out of every settle sweep
// (closedLockRoundsUnsettled, the attested sweep): B's losers' locks are never claimed, B's winners never paid.
// (fixture copied from any-federation-rows-1172.test.js)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement, federationPlans } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { encodeCommitments, decodeCommitments, encodeShare } from '../src/pool-wire.js';
import { DELIVERED, FAILED } from '../../arena-protocol/src/payout.js';
import { entryFeeMsat } from '../../arena-protocol/src/fee.js';
import { toHex, fromHex, sha256 } from '../../arena-protocol/src/hash.js';
import { encodeRoundContract, encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { NETWORK_ID_REGTEST } from '../../arena-protocol/src/genesis-ids.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const pk = (n) => { const k = new Uint8Array(32); k[0] = n; k[31] = n; return k; };
const refund = (n) => { const k = new Uint8Array(33); k[0] = 0x02; k[1] = n; k[32] = n; return k; };
const RID = b32(0x5e);
const STAKE = 100000n; const FEE = entryFeeMsat(STAKE);
const A = 'aa'.repeat(32), B = 'bb'.repeat(32);
const entry = (n, outcome, score) => ({ pubkey: pk(n), stakeMsat: STAKE, feeMsat: FEE, donationMsat: 0n, outcome, score, entryId: b32(0x10 + n) });
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), L2 = entry(4, FAILED, 0);
const fedOfPlayer = new Map([[1, A], [3, A], [4, B]]);
const locks = new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), { outpoint: { txid: b32(0x40 + Number(e.pubkey[0])), outIdx: BigInt(e.pubkey[0]) }, amountMsat: STAKE - FEE, refundPk: refund(e.pubkey[0]) }]));
const PLAN = federationPlans({ roundId: RID, entries: [W1, L1, L2], minScore: 1, locks, feeLocks: new Map() },
  { federationOf: (o) => fedOfPlayer.get(Number(o.outIdx)), feesOf: () => ({ ppm: 0n, baseMsat: 0n }) });
const at = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;
const V3 = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32),
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3 });

/**
 * A federation's port with what its guardians hold. `mode`: 'land' (the submit lands: its locks gone, its payouts stored - the tool says so),
 * 'prevalidate' (Ok from submit_transaction, nothing stored yet), 'refuse'. `landed(txid, claims, n)` lands a transaction as another asker's would.
 */
function fedPort(fid, log, allLocks) {
  const bytesOf = ({ claims, payouts, nonce }) => sha256(new TextEncoder().encode(JSON.stringify({ fid, c: claims.map((c) => `${toHex(c.outpoint.txid)}:${c.outpoint.outIdx}:${c.amountMsat}`),
    p: payouts.map((p) => `${toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  const spent = new Set(), stored = new Set();
  const p = {
    mode: 'land', spent, stored,
    landed(txid, claims, n) { for (const c of claims) spent.add(c); for (let i = 0; i < n; i++) stored.add(`${txid}:${i}`); },
    fees: async () => ({ ppm: 0n, baseMsat: 0n }),
    status: async (o) => ({ blockCount: 500, stored: stored.has(at(o)) || (allLocks.has(at(o)) && !spent.has(at(o))) ? { blocksLeft: 100 } : null }),
    settle: async ({ claimPk, claims, payouts, nonce, signature }) => {
      const msg = bytesOf({ claims, payouts, nonce });
      if (!signature) return { message: toHex(msg), txid: toHex(msg) };
      const good = schnorr.verify(signature, msg, claimPk.subarray(1));
      log.push({ fid, txid: toHex(msg), mode: p.mode, good });
      if (!good || p.mode === 'refuse') return { accepted: false, error: good ? 'the guardians said no' : 'bad signature' };
      if (p.mode === 'prevalidate') return { accepted: true, payoutsStored: payouts.map(() => null), locksAfter: claims.map(() => ({ held: true })) };
      p.landed(toHex(msg), claims.map((c) => at(c.outpoint)), payouts.length);
      return { accepted: true, payoutsStored: payouts.map(() => ({ stored: true })), locksAfter: claims.map(() => null) };
    },
  };
  return p;
}

function twoNodes() {
  const G = evenGroupSecret(0x51515n, curve);
  const deal = trustedDealerSplit({ secret: G.secret, max: 2, min: 2, coefficients: [0x77n], curve });
  const claimPk = deal.groupPublicKey;
  const log = [];
  const allLocks = new Set([...locks.values()].map((l) => at(l.outpoint)));
  const ports = { [A]: fedPort(A, log, allLocks), [B]: fedPort(B, log, allLocks) };
  const router = { forFederation: async (f) => ports[f] || null, status: async () => ({ stored: null }), settle: async () => { throw new Error('a round that takes any federation never settles on the home port'); } };
  const contract = { stakeMsat: STAKE, protocolVersion: 3, federationId: new Uint8Array(32), nodes: [pk(0xa1), pk(0xa2)], settlementSlots: 2, minScore: 1 };
  const nodes = [];
  for (const id of [1, 2]) {
    const round = new Round(openStore(':memory:'));
    round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: V3 } : null);
    const ls = new LockSettlement(round, { dkg: {}, port: router, curve, random: (n) => crypto.getRandomValues(new Uint8Array(n)),
      stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) }, peersFor: () => (id === 1 ? ['http://peer2'] : []) });
    ls.planOf = async () => ({ ok: true, anyFed: true, plan: PLAN.plan, split: PLAN.split, contract, claimPk,
      held: { signerNode: deal.shares[id - 1] }, lockEntry: new Map([W1, L1, L2].map((e) => [toHex(e.pubkey), e.entryId])) });
    ls.confirmSoon = () => {};
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
  return { nodes, ports, log };
}
const rowsOf = (n) => n.round.fedLockSettlementsOf(RID).map((r) => `${r.federation.slice(0, 2)} ${r.state}`).join(', ');

test('wf1489-sm3-settle-1: one federation settled and the other not reached is not ACCEPTED, and the round stays in the retry sweep', async () => {
  const { nodes, ports, log } = twoNodes();
  const one = nodes[0];
  // federation B's guardians do not answer for this one pass (the router finds no port for it): A is built, signed, submitted and lands
  const route = one.port.forFederation;
  one.port.forFederation = async (f) => (f === B ? null : route(f));
  const got = await one.settle(RID);
  console.log(`pass 1: ${rowsOf(one)}; answer ok=${got.ok} state=${got.state} - ${got.why.slice(0, 160)}`);
  assert.equal(got.ok, false, 'the pass itself says B was not settled');
  assert.equal(one.round.fedLockSettlement(RID, A).state, 'ACCEPTED');
  assert.equal(one.round.fedLockSettlement(RID, B), null, 'B has no row: nothing was submitted there');
  const sB = PLAN.split.settlements.find((s) => s.federation === B);
  console.log(`federation B: ${sB.claims.length} lock(s) to claim, ${sB.payouts.length} payout(s) to make, ${log.filter((x) => x.fid === B).length} submit(s) there`);
  // the round as a closed lock round of this store
  one.round.db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms, closed_ms) VALUES (?, ?, 1, 1, 1000)').run(Buffer.from(RID), Buffer.from(V3));
  one.round.db.prepare("INSERT INTO stake_locks (entry_id, round_id, outpoint, fields, contract_id, verified_ms) VALUES (?, ?, 'x:0', '{}', 'c', 1)").run(Buffer.from(L2.entryId), Buffer.from(RID));
  const unsettled = one.round.closedLockRoundsUnsettled(0, 10000).map(toHex);
  const state = one.round.settlementState(RID);
  console.log(`settlementState: ${state}; closedLockRoundsUnsettled lists the round: ${unsettled.includes(toHex(RID))}`);
  assert.notEqual(state, 'ACCEPTED', 'a round whose federation B settlement was never made is not ACCEPTED');
  assert.ok(unsettled.includes(toHex(RID)), 'the round is still asked again by retryUnsettled');
});
