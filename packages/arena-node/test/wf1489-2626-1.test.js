// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2626 (feedback #050): THE LIQUIDATION REMAINDER WAS COMPUTED FROM THE CURRENT PLAN, NOT FROM WHAT WAS PAID.
// payOutLiquidation paid the remainder as claims.plan(fid, { escrowMsat: claimedMsat }).remainderMsat, checked only as sum(payees) <= rest.
// The report: a verified halt at 1000 (regtest clocks), escrow 10,000,000 msat; notes A 4,000,000 and B 3,000,000 claimed at 1012 while no spent
// set stands; at 1021 the escrow is pegged in and batch 1 pays A and B; then a guardian copy brings session 9 to the 3-of-7 quorum and that set
// names A - the plan now refuses A, and at 1100 the remainder paid 7,000,000 (escrow - B): 14,000,000 out of a 10,000,000 escrow.
// Safe: what the escrow still holds is claimedMsat less what was paid; no batch and no remainder goes above it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, federationRecordId, FEDERATION_STATUS, thresholdOf } from '../../arena-protocol/src/federation-record.js';
import { REGTEST_CLOCKS, liquidationRemainderPayees } from '../../arena-protocol/src/federation-slash.js';
import { signSpentSet, encodeSpentSet } from '../../arena-protocol/src/spent-set.js';
import { liquidationFromSeats, verifyHaltRecord } from '../src/arbiter.js';
import { createLiquidationClaims, payOutLiquidation } from '../src/liquidation-claims.js';
import { inviteForGuardians, readInvite } from '../src/invite.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const FED = new Uint8Array(32).fill(0x37), FID = toHex(FED);
const NET = new Uint8Array(32).fill(0x10);
const INVITE = inviteForGuardians(FED, Array.from({ length: 7 }, (_, i) => ({ peer: i, url: `wss://g${i}.example` })));
const inviteFederationId = (inv) => fromHex(readInvite(inv).federationId);
const P1 = '02' + '11'.repeat(32), P2 = '02' + '22'.repeat(32);
const NOTES = { e1: [{ nonce: '02' + 'a1'.repeat(32), amountMsat: 4_000_000n }], e2: [{ nonce: '02' + 'b1'.repeat(32), amountMsat: 3_000_000n }] };

// 12 census nodes; the first 7 are the federation's guardians (config keys 0x60+i); node 11 runs the lying seat
const nodes = Array.from({ length: 12 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret),
  guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]) }; });
const guardians = nodes.slice(0, 7), liar = nodes[11];
const KEYS = guardians.map((g) => g.guardianKey);
const census = nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0x20 + i), vout: 0, bondSats: 50000n,
  advert: { operatorId: `op${i}`, endpoint: `https://seat-${i}.example`, guardianOf: i < 7 ? [{ federationId: FED, guardianKey: n.guardianKey }] : [] } }));
const row = (n) => ({ peerKey: n.guardianKey, nodePubkey: n.pubkey, operatorId: '', bondTxid: new Uint8Array(32), bondVout: 0, endpoint: '' });
const body = (height, status, list = guardians) => ({ federationId: FED, networkId: NET, invite: INVITE, nominal: list.length, threshold: thresholdOf(list.length),
  guardians: list.map(row).sort((a, b) => (toHex(a.nodePubkey) < toHex(b.nodePubkey) ? -1 : 1)), status: FEDERATION_STATUS[status],
  successorId: new Uint8Array(32), gone: [], exposureCapSats: 0n, reserveSats: 0n, height });
const signed = (b, by) => { const id = federationRecordId(b); return toHex(joinSignedRecord(encodeFederationRecord(b), by.map((n) => ({ nodePubkey: n.pubkey, signature: schnorr.sign(id, n.secret) })))); };

const GENUINE = signed(body(1000, 'HALTED'), guardians);                                        // 7 of 7

const sched = (h) => ({ haltHeight: h, liquidatesAt: h + 10, claimWindowCloses: h + 20, lateClaimsUntil: h + 100, remainderSplitsAt: h + 100 });
const NONCE_A = NOTES.e1[0].nonce, NONCE_B = NOTES.e2[0].nonce;
const P3 = '02' + '33'.repeat(32);
NOTES.e3 = [{ nonce: '02' + 'c1'.repeat(32), amountMsat: 5_000_000n }];

let tip = 1012;
const verifyHalt = (bytes) => verifyHaltRecord(bytes, { fid: FID, keys: KEYS, census, tip, networkId: NET, inviteFederationId });
// a guardian's copy of session `session` naming `nonces`, as a seat lists it in GET /liquidations
const spentCopy = (g, session, nonces) => {
  const c = signSpentSet({ federationId: FED, session, nonces: nonces.map(fromHex), signer: g.pubkey }, (m) => schnorr.sign(m, g.secret));
  const { signature, ...b } = c;
  return { spentSet: toHex(encodeSpentSet(b)), signature: toHex(signature) };
};

async function scenario({ spentSetAfterBatch, lateClaim = false }) {
  tip = 1012;
  const listing = { federation: FID, ...sched(1000), haltRecord: GENUINE, spentSet: null };
  const listings = [listing, { ...listing }, { ...listing }];
  const claims = createLiquidationClaims({ validate: async (_f, e) => (NOTES[e] ? { ok: true, notes: NOTES[e] } : { ok: false, why: 'no' }),
    liquidationOf: (fid) => liquidationFromSeats(fid, listings, { seatCount: listings.length, clocks: REGTEST_CLOCKS, verifyHalt }),
    height: async () => tip, escrowMsatOf: async () => 10_000_000n, clocks: REGTEST_CLOCKS });
  const remainderPayees = async (fid, msat) => {
    const l = await claims.liquidation(fid);
    const got = liquidationRemainderPayees({ msat, censusNodes: nodes.map((n) => n.pubkey), slashed: [], record: l.record, donation: [{ recipientPk: new Uint8Array(32).fill(0xdd), shareBps: 10000 }] });
    if (!got.ok) throw new Error(got.why);
    return got.payees;
  };
  const taken = [await claims.offer({ federation: FID, ecash: 'e1', payoutPk: P1 }), await claims.offer({ federation: FID, ecash: 'e2', payoutPk: P2 })];
  const pays = [];
  const run = async (args) => {
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 10_000_000 };
    if (args[1] === 'pay') { pays.push(args[3]); return { txid: `t${pays.length}`, payouts: args[3].split(',').map((x, i) => ({ refund_pk: x.split(':')[0], amount_msat: Number(x.split(':')[1]), out_idx: i })) }; }
    return {}; };
  const v = {};
  const pass = () => payOutLiquidation({ fid: FID, v, claims, height: async () => tip, run, spendEscrow: async () => ({ txid: 'x' }), remainderPayees });
  tip = 1021;
  const first = await pass();
  if (spentSetAfterBatch) {
    // a guardian copy brings session 9 to the 3-of-7 quorum (n - t + 1); that set names A, already paid
    const copies = guardians.slice(0, 3).map((g) => spentCopy(g, 9, [NONCE_A]));
    for (const l of listings) l.spentSet = { copies };
  }
  const liq = await claims.liquidation(FID);
  let late = null;
  if (lateClaim) { tip = 1050; late = await claims.offer({ federation: FID, ecash: 'e3', payoutPk: P3 }); await pass(); }
  tip = 1100;
  const passes = [await pass(), await pass(), await pass()];
  const total = pays.flatMap((p) => p.split(',')).reduce((a, x) => a + BigInt(x.split(':')[1]), 0n);
  return { taken, first, liq, late, passes, pays, total, v };
}

test('#2626 the report: a spent set naming an already-paid note after batch 1 does not raise the remainder - total out is the escrow', async () => {
  const got = await scenario({ spentSetAfterBatch: true });
  console.log('  MEASURED #2626 spent set after batch 1:', JSON.stringify({ spentNonces: got.liq.spentNonces, session: got.liq.spentSetSession, pays: got.pays.length,
    remainder: got.v.remainderMsat || null, total: String(got.total) }));
  assert.deepEqual(got.taken.map((t) => t.ok), [true, true]);
  assert.deepEqual(got.liq.spentNonces, [NONCE_A], 'the spent set stands and names A');
  assert.equal(got.pays[0], `${P1}:4000000,${P2}:3000000`, 'batch 1 paid A and B at face');
  assert.equal(got.v.remainderMsat, '3000000', 'the remainder is what the escrow still holds');
  assert.ok(got.total <= 10_000_000n, `total out ${got.total} exceeds the 10,000,000 msat escrow`);
  assert.equal(got.total, 10_000_000n);
});

test('#2626 a late note after the spent set voids a paid note is paid from what the escrow still holds, never above it', async () => {
  const got = await scenario({ spentSetAfterBatch: true, lateClaim: true });
  console.log('  MEASURED #2626 late note:', JSON.stringify({ late: got.late && got.late.ok, pays: got.pays, total: String(got.total) }));
  assert.equal(got.late.ok, true);
  assert.equal(got.pays[1], `${P3}:3000000`, 'the late note takes what is left: 3,000,000 of its 5,000,000');
  assert.ok(got.total <= 10_000_000n, `total out ${got.total} exceeds the 10,000,000 msat escrow`);
});

test('#2626 control: no new spent set - the notes at face and the remainder 3,000,000, total exactly the escrow, and paid once', async () => {
  const got = await scenario({ spentSetAfterBatch: false });
  assert.equal(got.liq.spentNonces, null);
  assert.equal(got.pays.length, 2, 'batch 1 and the remainder, once');
  assert.equal(got.v.remainderMsat, '3000000');
  assert.equal(got.total, 10_000_000n);
});
