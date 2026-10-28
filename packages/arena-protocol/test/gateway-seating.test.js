// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE GATEWAY SEATING SIGNED BY THE GUARDIANS (spec §23A.9): it stands with the threshold of seated guardians on the same seats for the
// same epoch; a guardian that ranked differently only fails to add its signature; strangers and forgeries count for nothing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signGatewaySeating, standingSeating } from '../src/gateway-seating.js';
import { toHex } from '../src/hash.js';

const g = [1, 2, 3, 4, 5].map((n) => { const secret = new Uint8Array(32).fill(n); return { secret, hex: toHex(schnorr.getPublicKey(secret)) }; });
const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const fid = 'f1'.repeat(32), A = 'aa'.repeat(32), B = 'bb'.repeat(32), C = 'cc'.repeat(32);
const sign = (i, seats, epoch = 7) => signGatewaySeating({ federationId: fid, epoch, seats }, g[i].hex, (h) => schnorr.sign(h, g[i].secret));
const seated = g.slice(0, 4).map((x) => x.hex);

test('three of four seated guardians on the same seats: it stands; the fourth ranked otherwise and only lacks its signature', () => {
  const r = standingSeating({ signed: [sign(0, [A, B]), sign(1, [B, A]), sign(2, [A, B]), sign(3, [A, C])], federationId: fid, epoch: 7, seated, threshold: 3, verify });
  assert.deepEqual([r.ok, r.seating.seats, r.signers], [true, [A, B], 3]);
});

test('below the threshold, another epoch, a stranger or a forgery: no seating', () => {
  assert.equal(standingSeating({ signed: [sign(0, [A, B]), sign(1, [A, B]), sign(2, [A, C])], federationId: fid, epoch: 7, seated, threshold: 3, verify }).ok, false);
  assert.equal(standingSeating({ signed: [sign(0, [A], 6), sign(1, [A], 6), sign(2, [A], 6)], federationId: fid, epoch: 7, seated, threshold: 3, verify }).ok, false, 'epoch 6 signatures');
  assert.equal(standingSeating({ signed: [sign(0, [A]), sign(1, [A]), sign(4, [A])], federationId: fid, epoch: 7, seated, threshold: 3, verify }).ok, false, 'guardian 5 is not seated');
  const forged = { ...sign(2, [A]), seats: [B] };
  const r = standingSeating({ signed: [sign(0, [B]), sign(1, [B]), forged], federationId: fid, epoch: 7, seated, threshold: 3, verify });
  assert.match(r.why, /at most 2/);
});

// kanban #559/#543 (spec §23A.3a part 2): the seating carries its seats' proved peg-ins, signed; one that names none hashes as before
test('proved peg-ins in the seating: signed with the seats, the same amounts make one body, a seating naming none hashes as before', async () => {
  const { gatewaySeatingHash } = await import('../src/gateway-seating.js');
  const plain = { federationId: fid, epoch: 7, seats: [A, B] };
  assert.equal(toHex(gatewaySeatingHash(plain)), toHex(gatewaySeatingHash({ ...plain, pegIns: {} })), 'none named: the hash as before');
  assert.notEqual(toHex(gatewaySeatingHash(plain)), toHex(gatewaySeatingHash({ ...plain, pegIns: { [A]: '50000' } })));
  const withP = (i, p) => signGatewaySeating({ ...plain, pegIns: p }, g[i].hex, (h) => schnorr.sign(h, g[i].secret));
  const r = standingSeating({ signed: [withP(0, { [A]: '50000', [B]: '25000' }), withP(1, { [B]: '25000', [A]: '50000' }), withP(2, { [A]: '50000', [B]: '25000' })], federationId: fid, epoch: 7, seated, threshold: 3, verify });
  assert.deepEqual([r.ok, r.seating.pegIns], [true, { [A]: '50000', [B]: '25000' }]);
  const split = standingSeating({ signed: [withP(0, { [A]: '50000' }), withP(1, { [A]: '50000' }), withP(2, { [A]: '40000' })], federationId: fid, epoch: 7, seated, threshold: 3, verify });
  assert.equal(split.ok, false, 'another proved amount is another body');
  const forged = { ...withP(2, { [A]: '50000' }), pegIns: { [A]: '90000' } };
  assert.equal(standingSeating({ signed: [withP(0, { [A]: '90000' }), withP(1, { [A]: '90000' }), forged], federationId: fid, epoch: 7, seated, threshold: 3, verify }).ok, false, 'the amounts are signed');
});

// kanban #559 P2 (spec §23A.9: "A seat earns its share for a round only if it was eligible in that round's epoch: the seating the
// guardians sign names only eligible seats"). The whole path a seat takes, without a live seat: each guardian ranks the epoch
// (seatGateways), signs its paid seats (paidSeatsOf), a seating stands at threshold (standingSeating), and a round reads the standing
// seating of seatingEpochAt(its census height) - as server.js signerNodesFor does - into the fee table.
test('§23A.9 P2: a seat is paid in a round only if the standing seating of the round\'s epoch names it; no standing seating, no gateway', async () => {
  const { seatGateways } = await import('../src/gateway-seats.js');
  const { seatingEpochAt, paidSeatsOf } = await import('../src/gateway-seating.js');
  const { GATEWAY_EPOCH_BLOCKS } = await import('../src/gateway-seats.js');
  const { nodeFeeTable } = await import('../src/fee.js');
  const { fromHex } = await import('../src/hash.js');
  const { TEST_FEDERATION_ID } = await import('../src/test-federation.js');
  const b32 = (n) => new Uint8Array(32).fill(n);
  const E = 20000, edge = (e) => e * GATEWAY_EPOCH_BLOCKS;   // epoch e starts at block edge(e)
  // THE EPOCH A HEIGHT READS: the last whole one. A guardian at the last block of E cannot sign E yet; at the first block of E+1 it can,
  // and a round whose census height is there reads E - the same function, so a round never reads an epoch not yet signable.
  assert.equal(seatingEpochAt(edge(E + 1) - 1), E - 1, 'the last block of E: E is not whole yet');
  assert.equal(seatingEpochAt(edge(E + 1)), E, 'the first block of E+1: E is whole');
  assert.equal(seatingEpochAt(edge(E + 2) - 1), E, 'the last block of E+1 still reads E');
  assert.equal(seatingEpochAt(edge(E + 2)), E + 1, 'the next block reads E+1');

  // the gateways are seated guardians of the federation: a = guardian 0, b = guardian 1
  const a = g[0].hex, b = g[1].hex;
  const cand = (hex, over = {}) => ({ node: fromHex(hex), operatorId: hex.slice(0, 8), seatedGuardian: true, registered: true, volumeSats: 0n, inboundSats: 300_000n,
    outsideInboundSats: 150_000n, outboundSats: 150_000n, pegInSats: 60_000n, availabilityPct: 99, bondSats: 50_000n, ...over });
  const rank = (epoch, candidates, incumbents = []) => seatGateways({ candidates, beacon: b32(0xbe), epoch, incumbents, network: 'testnet4', bondMinGuardian: 50_000n });
  const fidHex = toHex(TEST_FEDERATION_ID);
  const standing = new Map();   // epoch -> the standing seating, as every seat keeps it (server.js gatewaySeatings)
  const gather = (epoch, seats, signers = [0, 1, 2, 3]) => {
    const signed = signers.map((i) => signGatewaySeating({ federationId: fidHex, epoch, seats: Array.isArray(seats) ? seats : seats[i] }, g[i].hex, (h) => schnorr.sign(h, g[i].secret)));
    const st = standingSeating({ signed, federationId: fidHex, epoch, seated, threshold: 3, verify });
    if (st.ok) standing.set(epoch, st.seating);
    return st;
  };
  const committee = [b32(0x21), b32(0x22)];
  const contract = { networkId: b32(0x4e), configHash: b32(0x43), censusConfirmations: 1, gameVerifySlots: 2, settlementSlots: 2, gameId: b32(0x47), simCoreHash: b32(1),
    startTimeMs: 60500n, entryCloseMs: 2000n, objectionWindowMs: 600000n, custody: 'FEDERATION', slashMinimumServed: 20, slashRemainder: 'SPLIT', federationId: TEST_FEDERATION_ID,
    stakeExpiryBlocks: 144, publicationRelays: [], donationSetId: b32(0xd0), censusRoot: b32(2), committeeTimeMs: 500n, randomnessRule: 'bitcoin-block-hash',
    stakeMsat: 100000n, bondMinSats: 50000n, blockTicks: 9000, exposureReference: 1000, corridorHalfWidth: 40, spawnFreeRadius: 20, timeFloor: 30, timeCeil: 150,
    minScore: 1, rankNumerator: 3, rankDenominator: 4, nodes: committee };
  const entries = [1, 2, 3].map((n) => ({ pubkey: b32(0xa0 + n), outcome: n === 1 ? 'DELIVERED' : 'FAILED', score: 1, stakeMsat: 100_003n * BigInt(n) }));
  // A ROUND: the gateway list is the standing seating of its epoch, else none (server.js signerNodesFor)
  const round = (censusHeight, { v = 15, guardian = seated } = {}) => {
    const s = standing.get(seatingEpochAt(censusHeight));
    const gateway = s ? s.seats.map(fromHex) : [];
    const pools = { gameVerify: committee, settlement: committee, guardian: guardian.map(fromHex), gateway };
    const t = nodeFeeTable({ contract: { ...contract, censusHeight, protocolVersion: v }, entries, pools,
      eligible: new Set([...committee.map(toHex), ...guardian, ...gateway.map(toHex)]) });
    assert.equal([...t.signerNodes.values()].reduce((x, y) => x + y, 0n) + t.unallocated, t.fee);
    assert.equal(t.unallocated, 0n);
    return { t, gw: (hex) => t.signerNodes.get(`gateway:${hex}`) || 0n };
  };

  // (a) EPOCH E: a is below the minimums (up 80 %), b eligible - a is not seated, and E's seating names b alone
  const rE = rank(E, [cand(a, { availabilityPct: 80 }), cand(b)]);
  assert.deepEqual([rE.seated, rE.belowMinimums], [[b], []]);
  assert.deepEqual(paidSeatsOf(rE), [b]);
  assert.equal(gather(E, paidSeatsOf(rE)).ok, true);
  for (const h of [edge(E + 1), edge(E + 2) - 1]) {   // the first and the last census height that reads E
    const { t, gw } = round(h);
    assert.equal(gw(a), 0n, `census ${h}: a, below the minimums in E, earns no gateway share`);
    assert.equal(gw(b), t.pools.gateway, `census ${h}: the other seat takes the whole gateway third (P3)`);
    assert.ok(t.signerNodes.get(`guardian:${a}`) > 0n, 'a is still paid as a guardian');
  }
  // the same, when nobody is eligible: a holds the one seat below the minimums, serves, and the signed seating names nobody
  const alone = rank(E - 1, [cand(a, { availabilityPct: 80 })]);
  assert.deepEqual([alone.seated, alone.belowMinimums], [[a], [a]]);
  assert.deepEqual(paidSeatsOf(alone), [], 'the seat held below the minimums is not signed');
  assert.equal(gather(E - 1, paidSeatsOf(alone)).ok, true, 'a seating of no paid seat stands');
  const { t: tAlone } = round(edge(E));
  assert.equal(tAlone.pools.gateway, undefined, 'no paid seat: no gateway pool, the guardians keep the custody pool');
  assert.equal(tAlone.signerNodes.has(`gateway:${a}`), false);

  // (b) EPOCH E+1: a eligible again; b held a seat in E and steps back behind it, both seated (two seats), both signed
  const rE1 = rank(E + 1, [cand(a), cand(b)], rE.seated);
  assert.deepEqual([...paidSeatsOf(rE1)].sort(), [a, b].sort());
  assert.equal(gather(E + 1, paidSeatsOf(rE1)).ok, true);
  { const { t, gw } = round(edge(E + 2));   // the first census height that reads E+1, one block after the last that reads E
    assert.ok(gw(a) > 0n && gw(b) > 0n, 'a, eligible in E+1, is paid in a round of E+1');
    assert.equal(gw(a) + gw(b), t.pools.gateway); }

  // (c) EPOCH E+2: only two of the four seated guardians (threshold 3) sign a's and b's seats, the third another body - no seating
  // stands; a round of E+2 does not fall back to E+1's seating: it pays no gateway, and the guardians keep the custody pool
  const split = gather(E + 2, { 0: [a, b], 1: [a, b], 2: [b] }, [0, 1, 2]);
  assert.equal(split.ok, false);
  assert.match(split.why, /at most 2/);
  assert.equal(standing.has(E + 2), false);
  { const { t } = round(edge(E + 3));
    assert.equal(t.pools.gateway, undefined, 'below the threshold: no gateway seats in the epoch');
    assert.equal([...t.signerNodes.keys()].some((k) => k.startsWith('gateway:')), false);
    const third = t.fee / 3n;
    assert.equal(t.pools.guardian, t.fee - 2n * third, 'the guardians keep the whole custody pool (P3, protocol 15)'); }

  // (d) EPOCH E+3: nothing signed at all - the same; and at protocol 22 with no guardian either, the custody pool to the two committees
  { const { t } = round(edge(E + 4));
    assert.equal(t.pools.gateway, undefined);
    const { t: t22 } = round(edge(E + 4), { v: 22, guardian: [] });
    assert.equal(t22.pools.gateway, undefined);
    assert.equal(t22.pools.guardian, 0n);
    assert.equal(t22.pools.gameVerify + t22.pools.settlement, t22.fee, 'protocol 22, no guardian, no standing seating: the committees take the fee');
    // and at 22 with the E+1 seating standing and no guardian, the custody pool goes to the seats (e7815f21) - the seating decides who
    const { t: s22, gw } = round(edge(E + 2), { v: 22, guardian: [] });
    assert.ok(gw(a) > 0n && gw(b) > 0n);
    assert.equal((s22.signerNodes.get(`guardian:${a}`) || 0n) + (s22.signerNodes.get(`guardian:${b}`) || 0n), s22.pools.guardian); }
});

// kanban #559/#543 (§23A.3a part 2): the peg-ins a guardian signs are those it proved - a paid seat it could not check is left out
test('the proved peg-ins a guardian signs: each checked paid seat as a decimal string; unchecked or unknown seats left out', async () => {
  const { provedPegInsOf } = await import('../src/gateway-seating.js');
  const D = 'dd'.repeat(32), E = 'ee'.repeat(32);
  const gateways = { [A]: { provedPegInSats: 60000n }, [B]: { provedPegInSats: null }, [C]: {}, [D]: { provedPegInSats: '0' } };
  assert.deepEqual(provedPegInsOf([A, B, C, D, E], gateways), { [A]: '60000', [D]: '0' },
    'A proved, B null, C no amount, E no entry at all; a proved 0 is a check, kept');
  assert.deepEqual(provedPegInsOf([B], { [A]: { provedPegInSats: 1n } }), {}, 'only paid seats are named');
  assert.deepEqual(provedPegInsOf([A], undefined), {}, 'no view: nothing proved');
  assert.deepEqual(provedPegInsOf([], gateways), {});
});

// kanban #559, the owner's ruling 1 (§23A.9, from the activation epoch SEATING_RULES_EPOCH): each guardian floors a seat's proved peg-in to
// whole 100,000 sat before it signs, so guardians reading the federation's coins minutes apart sign one body; a real disagreement (one
// sees the coin, one does not) still splits them. Decided by the seating's epoch: before the activation epoch - and at every epoch while
// it is null, as it ships until the 2.0 tag - the amounts stay exact, as 1.9.x signs them. The activation epoch is passed in here.
test('the activation epoch: a proved peg-in is signed floored to 100,000 sat in a seating of that epoch or later; null - never', async () => {
  const { provedPegInsOf, PEG_IN_FLOOR_SATS, seatingRulesActive } = await import('../src/gateway-seating.js');
  const { SEATING_RULES_EPOCH } = await import('../src/constants.js');
  assert.equal(PEG_IN_FLOOR_SATS, 100_000n);
  const signWith = (i, gateways, epoch, rulesEpoch) => signGatewaySeating({ federationId: fid, epoch, seats: [A, B],
    ...((p) => (Object.keys(p).length ? { pegIns: p } : {}))(provedPegInsOf([A, B], gateways, { epoch, rulesEpoch })) }, g[i].hex, (h) => schnorr.sign(h, g[i].secret));
  const stand = (signed, epoch) => standingSeating({ signed, federationId: fid, epoch, seated, threshold: 3, verify });
  const seen = [{ [A]: { provedPegInSats: 1_234_567n }, [B]: { provedPegInSats: 99_999n } },
    { [A]: { provedPegInSats: 1_201_000n }, [B]: { provedPegInSats: 0n } },
    { [A]: { provedPegInSats: 1_299_999n }, [B]: { provedPegInSats: 50_000n } }];
  // AS IT SHIPS: no activation epoch - off at every epoch, exact amounts, three bodies, nothing stands (a 1.9.x guardian signs the same)
  assert.equal(SEATING_RULES_EPOCH, null, 'no activation epoch until the 2.0 tag');
  for (const e of [7, 1_000_000]) {
    assert.equal(seatingRulesActive(e), false);
    assert.deepEqual(provedPegInsOf([A], seen[0], { epoch: e }), { [A]: '1234567' }, `epoch ${e}: exact`);
    const off = stand(seen.map((s, i) => signWith(i, s, e)), e);
    assert.equal(off.ok, false); assert.match(off.why, /at most 1/);
  }
  // ACTIVATION EPOCH 7: a seating of epoch 6 as 1.9.x - three bodies; one of epoch 7 - one body of 1,200,000 and 0 that stands at 3
  const at6 = stand(seen.map((s, i) => signWith(i, s, 6, 7)), 6);
  assert.equal(at6.ok, false, 'the epoch before the activation: exact, three bodies');
  assert.deepEqual(provedPegInsOf([A], seen[0], { epoch: 6, rulesEpoch: 7 }), { [A]: '1234567' });
  assert.deepEqual(provedPegInsOf([A], seen[0], { epoch: 7, rulesEpoch: 7 }), { [A]: '1200000' });
  const at7 = stand(seen.map((s, i) => signWith(i, s, 7, 7)), 7);
  assert.equal(at7.ok, true, at7.why);
  assert.deepEqual([at7.signers, at7.seating.pegIns], [3, { [A]: '1200000', [B]: '0' }]);
  // a real disagreement at 7: the third guardian could not check A - A is left out of its body, and nothing stands
  const blind = { [A]: { provedPegInSats: null }, [B]: { provedPegInSats: 50_000n } };
  const split = stand([signWith(0, seen[0], 7, 7), signWith(1, seen[1], 7, 7), signWith(2, blind, 7, 7)], 7);
  assert.equal(split.ok, false); assert.match(split.why, /at most 2/);
  assert.deepEqual(provedPegInsOf([A], seen[0]), { [A]: '1234567' }, 'no epoch named: exact');
});

// kanban #559, the owner's ruling 2 (§23A.9, from the activation epoch SEATING_RULES_EPOCH): a seating of epoch E is judged against the
// federation record in force at E's last block, height (E+1)*144 - 1 - not the record the seat holds when it gathers. The guardian set
// changes in epoch E+1 (guardian 0 leaves, guardian 4 comes in): with the rule on, E's seating signed at threshold by the old set stands
// and one signed by the new set alone does not; off (before the activation epoch, or none named), today's record judges, as 1.9.x.
test('the activation epoch: a seating of that epoch or later is judged by the record in force at its last block; before it or null - today\'s', async () => {
  const { seatingRecordFor, seatingJudgeHeight } = await import('../src/gateway-seating.js');
  const E = 1000;
  assert.equal(seatingJudgeHeight(E), 1001 * 144 - 1);
  const recordOf = (idx, height) => ({ height, threshold: 3, guardians: idx.map((i) => ({ nodePubkey: g[i].hex, peerKey: g[i].hex })), gone: [] });
  const old = recordOf([0, 1, 2, 3], E * 144 - 500), next = recordOf([1, 2, 3, 4], (E + 1) * 144 + 10);   // the change lands in E+1
  const history = [old, next];
  const recordAt = (h) => history.filter((r) => r.height <= h).sort((a, b) => b.height - a.height)[0] || null;   // as federation-records.js
  const seatedOf = (r) => r.guardians.map((x) => x.nodePubkey);
  const judge = (signers, rulesEpoch) => {
    const { record, at } = seatingRecordFor({ epoch: E, recordAt, current: next, ...(rulesEpoch === undefined ? {} : { rulesEpoch }) });
    const st = standingSeating({ signed: signers.map((i) => sign(i, [A, B], E)), federationId: fid, epoch: E, seated: seatedOf(record), threshold: record.threshold, verify });
    return [st.ok, at];
  };
  // AS IT SHIPS (no activation epoch) and with none named: today's record - guardian 0, gone today, does not count
  assert.deepEqual(judge([0, 1, 2]), [false, 'now'], 'as it ships: by the record held now');
  assert.deepEqual(judge([2, 3, 4]), [true, 'now']);
  assert.deepEqual(judge([0, 1, 2], null), [false, 'now']);
  // ACTIVATION AT E+1: E is the epoch before it - as 1.9.x
  assert.deepEqual(judge([0, 1, 2], E + 1), [false, 'now'], 'the epoch before the activation: today\'s record');
  assert.deepEqual(judge([2, 3, 4], E + 1), [true, 'now']);
  // ACTIVATION AT E: by the record of E's last block - the old set
  assert.deepEqual(judge([0, 1, 2], E), [true, 'epoch'], 'signed at threshold by the set seated in E: it stands');
  assert.deepEqual(judge([2, 3, 4], E), [false, 'epoch'], 'the new set alone: guardian 4 was not seated in E, two of three - it does not');
  // the record edge: a record signed at E's last block is E's; one a block later is not
  history.push(recordOf([1, 2, 3, 4], seatingJudgeHeight(E)));
  assert.deepEqual(judge([2, 3, 4], E), [true, 'epoch'], 'a record signed at the last block of E is in force for E');
  history.pop();
  history.push(recordOf([1, 2, 3, 4], seatingJudgeHeight(E) + 1));
  assert.deepEqual(judge([0, 1, 2], E), [true, 'epoch'], 'one signed at the first block of E+1 is not');
  // a seat that holds no record that old judges by the one it holds, as before
  const fresh = seatingRecordFor({ epoch: E, recordAt: () => null, current: next, rulesEpoch: E });
  assert.deepEqual([fresh.at, fresh.record], ['now', next]);
});
