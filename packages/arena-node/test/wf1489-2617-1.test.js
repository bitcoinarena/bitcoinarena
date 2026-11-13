// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2617 (feedback #046, residual of #1236): THE ARBITER TOOK THE HALT, ITS CLOCKS AND ITS RECORD FROM THE FIRST SEAT, UNCHECKED.
// arbiter.mjs liquidationOf answered { ...listings[0], spentNonces }: haltHeight, liquidatesAt, claimWindowCloses, lateClaimsUntil and haltRecord
// as the first seat in ARENA_ARBITER_SEATS listed them, and remainderPayees read that haltRecord's guardians without a signature check. The
// report: 7 guardians, a genuine 7 of 7 HALTED at 1000 (regtest clocks), escrow 10,000,000 msat, 12 census nodes; two holders claim 4,000,000
// and 3,000,000 at 1012; at 1021 the first seat lists halt 800 (clocks to match) and an unsigned record naming every census node but its own as
// guardians - both claims refused "after drain_blocks", the remainder split at once, 7,500,000 to that seat's node.
// Safe: the halt record a strict majority of the seats list, verified against the federation's guardian keys; the clocks computed here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { encodeFederationRecord, joinSignedRecord, federationRecordId, FEDERATION_STATUS, thresholdOf } from '../../arena-protocol/src/federation-record.js';
import { REGTEST_CLOCKS, liquidationRemainderPayees } from '../../arena-protocol/src/federation-slash.js';
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
const LATER = signed(body(1005, 'HALTED'), guardians);                                          // genuine too, another start
const OPEN = signed(body(1000, 'OPEN'), guardians);
// the report's forgery: every census node but the liar's listed as a guardian, no signature
const FORGED = toHex(joinSignedRecord(encodeFederationRecord(body(800, 'HALTED', nodes.filter((n) => n !== liar))), []));

const sched = (h) => ({ haltHeight: h, liquidatesAt: h + 10, claimWindowCloses: h + 20, lateClaimsUntil: h + 100, remainderSplitsAt: h + 100 });
const honest = { federation: FID, ...sched(1000), haltRecord: GENUINE, spentSet: null };
const lying = { federation: FID, ...sched(800), haltRecord: FORGED, spentSet: null };

let tip = 1012;
const verifyHalt = (bytes) => verifyHaltRecord(bytes, { fid: FID, keys: KEYS, census, tip, networkId: NET, inviteFederationId });
const liqOf = (listings, extra = {}) => (fid) => liquidationFromSeats(fid, listings, { seatCount: listings.length, clocks: REGTEST_CLOCKS, verifyHalt, ...extra });

function book(listings) {
  const claims = createLiquidationClaims({ validate: async (_f, e) => (NOTES[e] ? { ok: true, notes: NOTES[e] } : { ok: false, why: 'no' }),
    liquidationOf: liqOf(listings), height: async () => tip, escrowMsatOf: async () => 10_000_000n, clocks: REGTEST_CLOCKS });
  return claims;
}
// the remainder's payees as arbiter.mjs names them now: the verified record's guardians out
const remainderPayeesOf = (claims) => async (fid, msat) => {
  const l = await claims.liquidation(fid);
  if (!l || l.ok === false) throw new Error(l ? l.why : 'none');
  const got = liquidationRemainderPayees({ msat, censusNodes: nodes.map((n) => n.pubkey), slashed: [], record: l.record, donation: [{ recipientPk: new Uint8Array(32).fill(0xdd), shareBps: 10000 }] });
  if (!got.ok) throw new Error(got.why);
  return got.payees;
};

async function payRun(listings) {
  tip = 1012;
  const claims = book(listings);
  const taken = [await claims.offer({ federation: FID, ecash: 'e1', payoutPk: P1 }), await claims.offer({ federation: FID, ecash: 'e2', payoutPk: P2 })];
  tip = 1021;
  const pays = [];
  const run = async (args) => {
    if (args[1] === 'pegin-address') return { address: 'tb1qsafe' };
    if (args[1] === 'pegin-claim') return { balance_before_msat: 0, balance_after_msat: 10_000_000 };
    if (args[1] === 'pay') { pays.push(args[3]); return { txid: `t${pays.length}`, payouts: args[3].split(',').map((x, i) => ({ refund_pk: x.split(':')[0], amount_msat: Number(x.split(':')[1]), out_idx: i })) }; }
    return {}; };
  const v = {};
  const r = await payOutLiquidation({ fid: FID, v, claims, height: async () => tip, run, spendEscrow: async () => ({ txid: 'x' }), remainderPayees: remainderPayeesOf(claims) });
  const again = await payOutLiquidation({ fid: FID, v, claims, height: async () => tip, run, spendEscrow: async () => ({ txid: 'x' }), remainderPayees: remainderPayeesOf(claims) });
  return { taken, r, again, pays, v, claims };
}

test('#2617 the report: a lying first seat (halt 800, short clocks, unsigned record) is outvoted and its record never read; holders paid at face', async () => {
  const got = await payRun([lying, honest, honest]);
  const liq = await got.claims.liquidation(FID);
  console.log('  MEASURED #2617 liar first:', JSON.stringify({ haltHeight: liq.haltHeight, closes: liq.claimWindowCloses, late: liq.lateClaimsUntil, agree: `${liq.seatsAgree}/${liq.seats}`,
    signers: liq.haltSigners, pays: got.pays, remainderTxid: got.v.remainderTxid || null }));
  assert.deepEqual(got.taken.map((t) => t.ok), [true, true]);
  assert.deepEqual([liq.haltHeight, liq.liquidatesAt, liq.claimWindowCloses, liq.lateClaimsUntil], [1000, 1010, 1020, 1100], 'the clocks from the verified record, computed here');
  assert.equal(liq.record.guardians.length, 7);
  assert.deepEqual(got.pays, [`${P1}:4000000,${P2}:3000000`], 'both holders at face, nothing else');
  assert.equal(got.v.remainderTxid, undefined, 'the remainder waits for 1100');
  // and at 1100 the remainder goes to the 5 census nodes that are not the verified record's guardians, the liar one of five - not 75 % to it
  tip = 1100;
  const rest = await (remainderPayeesOf(got.claims))(FID, 3_000_000n);
  const toLiar = rest.find((p) => p.key === toHex(liar.pubkey));
  assert.equal(rest.filter((p) => p.part === 'node').length, 5);
  assert.equal(toLiar.msat, 450_000n);
});

test('#2617 a strict majority listing an unsigned (or keyless-signed) record is refused: nothing is taken, nothing settled, and the reason is said', async () => {
  tip = 1012;
  const claims = book([lying, lying, honest]);
  const offer = await claims.offer({ federation: FID, ecash: 'e1', payoutPk: P1 });
  const plan = await claims.plan(FID);
  console.log('  MEASURED #2617 forged majority:', JSON.stringify({ offer: [offer.status, offer.why], plan: [plan.status, plan.why] }));
  assert.equal(offer.ok, false); assert.equal(offer.status, 409); assert.match(offer.why, /does not stand/);
  assert.equal(plan.ok, false); assert.match(plan.why, /does not stand/);
  // a record signed by bonded strangers' nodes under their own keys: the config keys refuse it
  const strangers = nodes.slice(7, 12);
  const sybil = signed(body(800, 'HALTED', strangers), strangers);
  const s = await liqOf([{ ...lying, haltRecord: sybil }, { ...lying, haltRecord: sybil }, honest])(FID);
  assert.equal(s.ok, false); assert.match(s.why, /config does not name/);
  // no keys held: no halt counts
  const keyless = await liquidationFromSeats(FID, [honest, honest, honest], { seatCount: 3, clocks: REGTEST_CLOCKS,
    verifyHalt: (b) => verifyHaltRecord(b, { fid: FID, keys: null, census, tip, networkId: NET, inviteFederationId }) });
  assert.equal(keyless.ok, false); assert.match(keyless.why, /no guardian keys/);
  // a genuine record that is not HALTED does not start a liquidation
  const open = await liqOf([{ ...honest, haltRecord: OPEN }, { ...honest, haltRecord: OPEN }, honest])(FID);
  assert.equal(open.ok, false); assert.match(open.why, /not HALTED/);
});

test('#2617 every seat lists the genuine record but the first lies about the height and clocks: the record decides, the listing\'s numbers are not read', async () => {
  const got = await payRun([{ ...honest, ...sched(800) }, honest, honest]);
  assert.equal((await got.claims.liquidation(FID)).haltHeight, 1000);
  assert.deepEqual(got.pays, [`${P1}:4000000,${P2}:3000000`]);
});

test('#2617 the seats disagree without a strict majority: refused and said; the halt kept at the first pass is not moved later', async () => {
  tip = 1012;
  const later = { ...honest, ...sched(1005), haltRecord: LATER };
  const split = await liqOf([honest, honest, later, later])(FID);
  console.log('  MEASURED #2617 2 of 4:', JSON.stringify(split));
  assert.equal(split.ok, false); assert.match(split.why, /disagree.*2 of 4 seats, 3 needed/);
  // a seat that does not answer still counts toward the set: 1 of 3 listing is no majority
  const quiet = await liquidationFromSeats(FID, [honest], { seatCount: 3, clocks: REGTEST_CLOCKS, verifyHalt });
  assert.equal(quiet.ok, false); assert.match(quiet.why, /1 of 3 seats, 2 needed/);
  const claims = book([honest, later, later]);
  // honest still settles with a strict majority
  assert.equal((await liqOf([honest, honest, later])(FID)).haltHeight, 1000);
  // frozen at 1000: the seats now listing 1005 is refused, not followed
  const moved = await liqOf([honest, later, later], { frozen: { height: 1000 } })(FID);
  assert.equal(moved.ok, false); assert.match(moved.why, /counts from 1000/);
  assert.equal((await claims.plan(FID)).ok, true, 'without a kept halt the majority record (1005, verified) is the halt');
});
