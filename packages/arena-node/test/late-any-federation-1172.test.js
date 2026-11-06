// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A LATE LOSER OF A ROUND THAT TAKES ANY FEDERATION IS CLAIMED, IN ITS OWN FEDERATION (kanban #1172, the 2026-11-06 state-machine audit, the 1.9 line).
// Before: lateMessage and lateSettlementCandidates read the round's own lock_settlements row, which a round that takes any federation never has (its
// rows are per federation), so its late loser was never claimed - its lock expired back and the winners lost that share. Now its settlement is ACCEPTED
// once every federation's row is, and the late loser's second settlement is built, fee-priced, submitted and confirmed in its entry's federation.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import * as curve from '../src/curve.js';
import { LockSettlement } from '../src/settlement.js';
import { openStore } from '../src/store.js';
import { Round } from '../src/round.js';
import { FAILED, DELIVERED } from '../../arena-protocol/src/payout.js';
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
const W1 = entry(1, DELIVERED, 5), L1 = entry(3, FAILED, 0), LATE = entry(4, FAILED, 0);
const at = (o) => `${toHex(o.txid)}:${String(o.outIdx)}`;
const lockAt = (e) => ({ txid: b32(0x40 + Number(e.pubkey[0])), outIdx: BigInt(e.pubkey[0]) });
const V3 = encodeRoundContract({ networkId: NETWORK_ID_REGTEST, configHash: b32(1), censusConfirmations: 1, gameVerifySlots: 7, settlementSlots: 7,
  gameId: NEXTBLOCK_GAME_ID, simCoreHash: b32(9), committeeTimeMs: 0n, randomnessRule: 'bitcoin-block-hash', startTimeMs: 1n, entryCloseMs: 2n,
  objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: new Uint8Array(32),
  stakeExpiryBlocks: 144, publicationRelays: ['wss://r.example'], donationSetId: donationSetId(TEST_DONATION_SET_REGTEST.recipients), censusHeight: 900000,
  censusRoot: b32(2), stakeMsat: STAKE, bondMinSats: 50000n, blockTicks: 4920, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20,
  timeFloor: 30, timeCeil: 150, minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: [], protocolVersion: 3 });
const CLAIM_SK = b32(0x33);
const CLAIM_PK = Uint8Array.from([0x02, ...schnorr.getPublicKey(CLAIM_SK)]);
const lateEntryBytes = encodeEntryContract({ roundId: RID, playerPubkey: LATE.pubkey, sessionPubkey: b32(0x71), stakeCommitment: b32(0x72), stakeMsat: STAKE,
  feeMsat: FEE, donationMsat: 0n, joinTick: 0, worldSecret: b32(0x73), vssSharesRef: b32(0), stakePoint: new Uint8Array(33), feePreimage: b32(0x74),
  stakeLockOutpoint: lockAt(LATE), feeLockOutpoint: { txid: b32(0x45), outIdx: 4n }, claimKeyAttestationRef: b32(0x75), federationId: fromHex(B) });

function fedPort(fid, built) {
  const bytesOf = ({ claims, payouts, nonce }) => sha256(new TextEncoder().encode(JSON.stringify({ fid, c: claims.map((c) => at(c.outpoint)), p: payouts.map((p) => `${toHex(p.payoutPk)}:${p.msat}`), n: toHex(nonce) })));
  const spent = new Set(), stored = new Set();
  const locks = new Set([W1, L1, LATE].map((e) => at(lockAt(e))));
  return {
    spent, stored,
    landed(txid, claims, n) { for (const c of claims) spent.add(c); for (let i = 0; i < n; i++) stored.add(`${txid}:${i}`); },
    fees: async () => ({ ppm: 0n, baseMsat: 0n }),
    status: async (o) => ({ blockCount: 500, stored: stored.has(at(o)) || (locks.has(at(o)) && !spent.has(at(o))) ? { blocksLeft: 100 } : null }),
    settle: async ({ claims, payouts, nonce, signature }) => {
      const msg = bytesOf({ claims, payouts, nonce });
      if (!signature) { built.push(fid); return { message: toHex(msg), txid: toHex(msg) }; }
      return { accepted: false, error: 'not in this test' };
    },
  };
}

function lateSeat() {
  const built = [];
  const ports = { [A]: fedPort(A, built), [B]: fedPort(B, built) };
  const router = { forFederation: async (f) => ports[f] || null, status: async () => ({ stored: null }), settle: async () => { throw new Error('never the home port'); }, fees: async () => { throw new Error('never the home port\'s fees'); } };
  const round = new Round(openStore(':memory:'));
  round.get = (rid) => (toHex(rid) === toHex(RID) ? { contract: V3 } : null);
  const lockOf = (e) => ({ outpoint: at(lockAt(e)), fields: { paymentImage: { kind: 'hash', bytes: '' }, amountMsat: String(STAKE - FEE), claimPk: toHex(CLAIM_PK), refundPk: toHex(refund(e.pubkey[0])), expiration: 1000 } });
  round.stakeLock = (eid) => [W1, L1, LATE].map((e) => (toHex(e.entryId) === toHex(eid) ? lockOf(e) : null)).find(Boolean) || null;
  round.feeLock = () => null;
  round.entry = (eid) => (toHex(eid) === toHex(LATE.entryId) ? lateEntryBytes : null);
  round.entriesOf = () => [W1, L1, LATE].map((e) => ({ entryId: e.entryId, entry: { playerPubkey: e.pubkey, stakeMsat: e.stakeMsat, feeMsat: e.feeMsat, donationMsat: 0n, feePreimage: b32(0x74) } }));
  const ls = new LockSettlement(round, { dkg: { signerNodeFor: () => ({ ok: true, signerNode: { id: 1 }, pool: { groupPublicKey: CLAIM_PK } }) }, port: router, curve,
    stakeSecrets: { open: async () => ({ ok: true, preimage: b32(0x99) }) } });
  ls.finalityOf = () => ({ state: 'FORFEIT', why: 'test view: the late loser forfeited after its re-run window' });
  ls.turn = async () => ({ mine: false, why: 'another seat combines' });
  // THE ROUND'S OWN SETTLEMENT, AS AN ANY-FEDERATION ROUND KEEPS IT: a row per federation, the moves under "federations", the winner's share
  round.putLockSettlementMoves({ roundId: RID, txid: 'federations', claims: [at(lockAt(L1))], payouts: 1 });
  round.putLockSettlementShares(RID, [{ pubkey: W1.pubkey, msat: STAKE - FEE }]);
  round.db.exec('PRAGMA foreign_keys = OFF');   // the round and its entries are this test's stubs, not rows
  round.db.prepare('INSERT INTO objections (round_id, entry_id, seen_ms) VALUES (?, ?, ?)').run(Buffer.from(RID), Buffer.from(LATE.entryId), 1);
  return { ls, round, ports, built };
}

test('#1172 a late loser of a round that takes any federation is a candidate once every federation is in, built and confirmed in its own federation', async () => {
  const { ls, round, ports, built } = lateSeat();
  round.putFedLockSettlement({ roundId: RID, federation: A, txid: 'a1'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'SUBMITTING', why: 'test' });
  const early = round.lateSettlementCandidates().length;
  round.putFedLockSettlement({ roundId: RID, federation: A, txid: 'a1'.repeat(32), message: new Uint8Array(32), signature: new Uint8Array(64), state: 'ACCEPTED', why: 'test' });
  const cands = round.lateSettlementCandidates().map((c) => toHex(c.entryId));
  const m = await ls.lateMessage(RID, LATE.entryId);
  console.log(`#1172 late loser: candidates while A SUBMITTING ${early}, once in ${cands.length}; built ${m.ok ? `in federation(s) ${built.map((f) => f.slice(0, 2)).join(',')}, txid ${m.txid.slice(0, 12)}` : `nothing: ${m.why}`}`);
  assert.equal(early, 0);
  assert.deepEqual(cands, [toHex(LATE.entryId)]);
  assert.equal(m.ok, true, m.why);
  assert.deepEqual(built, [B], 'the late loser\'s lock is in B: its second settlement is built there');
  // a seat holding the handed signature (SUBMITTING) asks B's guardians, not the home port, and finds it in
  round.putLateLockSettlement({ roundId: RID, entryId: LATE.entryId, txid: m.txid, message: m.message, signature: schnorr.sign(m.message, CLAIM_SK), state: 'SUBMITTING', why: 'handed' });
  ports[B].landed(m.txid, [at(lockAt(LATE))], m.plan.payouts.length);
  const got = await ls.settleLate(RID, LATE.entryId);
  const row = round.lateLockSettlement(RID, LATE.entryId);
  console.log(`#1172 late row after B landed it: ${row.state} - ${String(got.why).slice(0, 100)}`);
  assert.equal(row.state, 'ACCEPTED');
  assert.equal(ports[A].spent.size, 0, 'nothing moved in A');
});
