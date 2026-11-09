// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE CAPACITY BAND IN THE RECORD (§23A.3a, kanban #997), over real guardians signing real bodies: a band entered at 70 % is kept down to 60 %
// by the previous record, every guardian builds the same bytes, one behind is told the previous record, a gatherer behind signs nothing until
// it catches up, and below the point a record is what it always was.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { federationRecords, guardiansOf } from '../src/federation-records.js';
import { buildFederationRecord, encodeFederationRecord, federationRecordId, joinSignedRecord, splitSignedRecord, verifyFederationRecord, capacityBandPoint } from '../../arena-protocol/src/federation-record.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { foundingPressureReader } from '../src/founding-pressure.js';
import { networkTargetBond, guardianWeights, gatewayWeights, pegInPressure, pressureOf, bandOfRecord } from '../../arena-protocol/src/capacity.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const FED = new Uint8Array(32).fill(0x37), NET = new Uint8Array(32).fill(0x10), INVITE = `fed:${toHex(FED)}`;
const inviteFederationId = (inv) => fromHex(String(inv).split(':')[1]);

/** Four guardians (threshold 3, cap 100,000 at 50,000 sat each), at height `w.h`, reading reserve `w.reserve`. */
function net({ bandFrom = 0, bandAtSeat = () => bandFrom, censusAt = undefined, heldAt = null } = {}) {
  const w = { h: 96, reserve: 0n };
  const nodes = Array.from({ length: 4 }, (_, i) => { const secret = new Uint8Array(32).fill(i + 1); return { secret, pubkey: schnorr.getPublicKey(secret), guardianKey: Uint8Array.from([2, ...new Uint8Array(32).fill(0x60 + i)]), endpoint: `wss://seat-${i}.example` }; });
  const census = { ok: true, entries: nodes.map((n, i) => ({ pubkey: n.pubkey, txid: new Uint8Array(32).fill(0xa0 + i), vout: 0, bondSats: 50000n,
    advert: { operatorId: `op${i}`, endpoint: n.endpoint, guardianEndpoint: `wss://g${i}.example`, guardianOf: [{ federationId: FED, guardianKey: n.guardianKey }] } })) };
  const seats = nodes.map((n, i) => federationRecords({ round: { pubkey: n.pubkey, identity: { secret: n.secret } }, newest: () => ({ rid: new Uint8Array(32).fill(9), contract: { censusHeight: w.h, networkId: NET } }),
    roster: { censusFor: () => census }, inviteFor: () => (w.mirroring === i ? null : INVITE), networkId: NET, bandFrom: bandAtSeat(i), ...(censusAt ? { censusAt } : {}), reserveOf: async () => ({ ok: true, reserveSats: w.reserve }),
    ...(heldAt ? { playerHeldOf: async () => { const h = heldAt(i); return h ? { ok: true, sats: h } : { ok: false, why: 'not counted' }; } } : {}),
    successorOf: () => w.successor || null, successionReasonOf: () => w.reason || null,   // kanban #1321
    peerSeats: () => [], fetcher: async (url) => {
      const j = seats[nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:')))];
      if ((w.down || []).includes(nodes.findIndex((m) => url.startsWith(m.endpoint.replace('wss:', 'https:'))))) throw new Error('down');
      if (url.includes('/federation-records-at')) { const u = new URL(url), r = j.recordAt(toHex(FED), Number(u.searchParams.get('height'))); return new Response(JSON.stringify({ records: r ? [{ federation: toHex(FED), record: r.__hex }] : [] })); }
      if (url.endsWith('/federations')) { const held = w.serving && w.serving.recordOf(toHex(FED)); return new Response(JSON.stringify({ federations: held ? [{ federation: toHex(FED), record: toHex(held.bytes) }] : [] })); }
      const u = new URL(url); w.urls = [...(w.urls || []), url];
      const player = u.searchParams.get('player') === null ? null : BigInt(u.searchParams.get('player'));   // kanban #1322
      const body = await j.mySignature(u.searchParams.get('federation'), Number(u.searchParams.get('height')), u.searchParams.get('reserve'), { previous: u.searchParams.get('previous'), inviteFederationId, player });
      return new Response(JSON.stringify(body), { status: body.ok ? 200 : 404 });
    } }));
  // every guardian seat keeps a record its gatherer got to threshold, as the mirror does
  const step = async (h, reserve, { by = 0, to = [0, 1, 2, 3] } = {}) => {
    w.h = h; w.reserve = BigInt(reserve);
    const r = await seats[by].gather(FED, inviteFederationId);
    if (r.ok) { for (const i of to) if (i !== by) await take(i, by); }
    return r;
  };
  // a seat with no invite for a federation mirrors its record from the guardians' seats, as a pass does
  const take = async (i, from) => { w.serving = seats[from]; w.mirroring = i; const got = await seats[i].gatherAll(inviteFederationId); w.serving = null; w.mirroring = null; return got; };
  const bandAt = (i = 0) => seats[i].recordOf(toHex(FED)).record.capacityBand;
  return { w, nodes, census, seats, step, bandAt, take };
}
const signed = (n, height, reserveSats, capacityBand) => {
  const b = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 4, guardians: guardiansOf(n.census, FED), height, reserveSats });
  if (capacityBand) b.capacityBand = capacityBand;
  const id = federationRecordId(b);
  return toHex(joinSignedRecord(encodeFederationRecord(b), n.nodes.map((x) => ({ nodePubkey: x.pubkey, signature: schnorr.sign(id, x.secret) }))));
};

test('the gap across records: PRESSURE entered at 70 %, kept at 65 %, left below 60 %; 65 % from CALM stays CALM', async () => {
  const n = net();
  assert.equal((await n.step(96, 65000)).ok, true);
  assert.equal(n.bandAt(), 'CALM', 'the first record: 65 % enters nothing');
  await n.step(102, 75000); assert.equal(n.bandAt(), 'PRESSURE');
  await n.step(108, 65000); assert.equal(n.bandAt(), 'PRESSURE', 'kept by the record before');
  await n.step(114, 59999); assert.equal(n.bandAt(), 'CALM');
  await n.step(120, 65000); assert.equal(n.bandAt(), 'CALM', 'the same load, from the other side');
  await n.step(126, 95000); assert.equal(n.bandAt(), 'CRITICAL');
  await n.step(132, 85000); assert.equal(n.bandAt(), 'CRITICAL');
  await n.step(138, 79000); assert.equal(n.bandAt(), 'PRESSURE', 'below 80 %, still above 60 %');
  await n.step(144, 100000); assert.equal(n.bandAt(), 'FULL');
  await n.step(150, 99999); assert.equal(n.bandAt(), 'CRITICAL', 'FULL leaves below 100 %');
});

test('a second record at one height keeps its gap from the height below, so a repeat cannot walk the band', async () => {
  const n = net();
  await n.step(96, 75000);
  await n.step(102, 65000); assert.equal(n.bandAt(), 'PRESSURE');
  const again = await n.step(102, 59000);
  assert.equal(again.ok, true); assert.equal(n.bandAt(), 'CALM');
  await n.step(102, 65000);
  assert.equal(n.bandAt(), 'PRESSURE', 'read against 96, not against the repeat at 102');
});

test('a guardian that missed the previous record is told it, checks it, and signs the same bytes', async () => {
  const n = net();
  await n.step(96, 75000);                                // all four
  await n.step(102, 65000, { to: [0, 1] });               // 2 and 3 never see the 102 record: for them the previous is 96, here the same band
  await n.step(108, 59000, { to: [0, 1] });               // nor this one: CALM, which they would not reach from PRESSURE at 65 %
  const r = await n.step(114, 65000);
  assert.equal(r.ok, true, r.why);
  assert.equal(r.signers, 4, 'all four, the two behind told the previous record');
  assert.equal(n.bandAt(), 'CALM');
  assert.ok(n.w.urls.some((u) => u.includes('previous=')), 'it went along');
});

test('a guardian that cannot say does not sign this round, and the next step catches up', async () => {
  const n = net();
  await n.step(96, 75000);
  n.w.down = [1, 2, 3];
  const alone = await n.step(102, 65000);
  assert.equal(alone.ok, false); assert.match(alone.why, /1 of 4 guardians answered with their records below 102: this guardian does not sign this round/);
  n.w.down = [3];
  const three = await n.step(108, 65000);
  assert.equal(three.ok, true, three.why);
  assert.equal(three.signers, 3, 'a threshold answered, and signed');
  const unread = net({ censusAt: async () => null });
  await unread.step(96, 75000);
  const b = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 4, guardians: guardiansOf(unread.census, FED), height: 100, reserveSats: 0n });
  b.capacityBand = 'CALM';
  const other = federationRecordId(b), stranger = new Uint8Array(32).fill(0x55);
  const hex = toHex(joinSignedRecord(encodeFederationRecord(b), [{ nodePubkey: schnorr.getPublicKey(stranger), signature: schnorr.sign(other, stranger) }]));
  unread.w.h = 102; unread.w.reserve = 65000n;
  const said = await unread.seats[1].mySignature(toHex(FED), 102, '65000', { previous: hex, inviteFederationId });
  assert.equal(said.ok, false, 'a record it cannot check is not left out'); assert.match(said.why, /census at 100 is not read/);
});

test('a forged previous record is not believed, and a guardian holds to its own', async () => {
  const n = net();
  await n.step(96, 75000);
  n.w.h = 102; n.w.reserve = 65000n;
  const forgedBy = n.nodes.slice(0, 2);
  const b = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 4, guardians: guardiansOf(n.census, FED), height: 100, reserveSats: 0n });
  b.capacityBand = 'CALM';
  const id = federationRecordId(b);
  const forged = toHex(joinSignedRecord(encodeFederationRecord(b), forgedBy.map((x) => ({ nodePubkey: x.pubkey, signature: schnorr.sign(id, x.secret) }))));
  const said = await n.seats[1].mySignature(toHex(FED), 102, '65000', { previous: forged, inviteFederationId });
  assert.equal(said.ok, true, said.why);
  const body = splitSignedRecord(joinSignedRecord(fromHex(said.body), [])).record;
  assert.equal(body.capacityBand, 'PRESSURE', 'two signatures of four: its own record at 96 stands');
  const junk = await n.seats[1].mySignature(toHex(FED), 102, '65000', { previous: 'abcd', inviteFederationId });
  assert.equal(junk.ok, true);
  const later = signed(n, 200, 0n, 'CALM');
  const higher = await n.seats[1].mySignature(toHex(FED), 102, '65000', { previous: later, inviteFederationId });
  assert.equal(splitSignedRecord(joinSignedRecord(fromHex(higher.body), [])).record.capacityBand, 'PRESSURE', 'a record above this height is no previous record');
});

test('guardians agree before signing: a gatherer behind asks the others first, and builds the body they all sign', async () => {
  const n = net();
  await n.step(96, 75000);
  await n.step(102, 59000, { to: [1, 2] });               // seat 3 never holds the record at 102: for it PRESSURE still holds
  const r = await n.step(108, 65000, { by: 3, to: [] });
  assert.equal(r.ok, true, r.why);
  assert.equal(r.signers, 4);
  assert.equal(n.bandAt(3), 'CALM', 'from the record it did not hold');
});

test('below the point, and with no point, a body names no band and no previous record is sent', async () => {
  for (const bandFrom of [null, 1000]) {
    const n = net({ bandFrom });
    await n.step(96, 75000); await n.step(102, 65000);
    const k = n.seats[0].recordOf(toHex(FED));
    assert.equal('capacityBand' in k.record, false);
    assert.ok(!n.w.urls.some((u) => u.includes('previous=')));
    assert.equal(verifyFederationRecord(k.bytes, { census: n.census.entries, verify, inviteFederationId }).ok, true);
  }
  const n = net({ bandFrom: 102 });
  await n.step(96, 75000); assert.equal('capacityBand' in n.seats[0].recordOf(toHex(FED)).record, false);
  await n.step(102, 65000);
  assert.equal(n.bandAt(), 'PRESSURE', 'the first record to name one reads the band the old record\'s load enters');
  assert.deepEqual([capacityBandPoint('testnet4'), capacityBandPoint('testnet'), capacityBandPoint('regtest'), capacityBandPoint('mainnet'), capacityBandPoint(null)], [null, null, null, 0, null]);
});

test('a band the record names reaches the founding read: 65 % kept in PRESSURE is pressure, as a load alone would not say', async () => {
  const n = net();
  const read = (hex, bandPoint = 0) => foundingPressureReader({ point: 0, bandPoint, bondMinGuardian: 50000n, inviteFederationId, networkId: NET, censusAt: async () => n.census.entries, held: () => hex })({ height: 200, entries: n.census.entries });
  assert.equal(await read(signed(n, 180, 65000n, 'PRESSURE')), networkTargetBond([{ status: 'OPEN', reserveSats: 65000n, nominal: 4 }], 50000n));
  assert.equal(await read(signed(n, 180, 65000n), null), null, 'before the band\'s point: 65 % enters nothing');
  assert.equal(await read(signed(n, 180, 75000n, 'CALM')), null, 'as it says');
});

test('a roll with the point named too early: guardians building two bodies reach no threshold, no wrong record, and the last one stands', async () => {
  const n = net({ bandAtSeat: (i) => (i < 2 ? 0 : null) });
  const r = await n.step(96, 75000);
  assert.equal(r.ok, false, 'two with a band, two without: a threshold of three signs neither');
  assert.equal(n.seats[0].recordOf(toHex(FED)), null);
  const mostly = net({ bandAtSeat: (i) => (i < 3 ? 0 : null) });
  const m = await mostly.step(96, 75000);
  assert.equal(m.ok, true, 'three of four are a threshold');
  assert.equal(m.signers, 3);
  assert.equal(mostly.bandAt(), 'PRESSURE');
});

test('the hard line: at or above the point a record must name a band, below it must not, and anything else is refused by name', () => {
  const n = net();
  const check = (hex, bandPoint) => verifyFederationRecord(fromHex(hex), { census: n.census.entries, verify, inviteFederationId, bandPoint });
  assert.equal(check(signed(n, 100, 1n, 'CALM'), 100).ok, true);
  assert.equal(check(signed(n, 99, 1n), 100).ok, true);
  assert.match(check(signed(n, 100, 1n), 100).why, /a record at 100 must name its capacity band: CAPACITY_BAND_HEIGHT is 100/);
  assert.match(check(signed(n, 99, 1n, 'CALM'), 100).why, /a record at 99 must not name a capacity band: CAPACITY_BAND_HEIGHT is 100/);
  assert.match(check(signed(n, 99, 1n, 'CALM'), null).why, /must not name a capacity band: CAPACITY_BAND_HEIGHT is not named/);
  assert.equal(check(signed(n, 99, 1n), null).ok, true, 'no point: as always');
  assert.match(check(signed(n, 99, 1n, 'CALM'), undefined).why, /must not name/, 'by default the network the record names: this one has none');
});

test('every record names a band whatever its status, and only an OPEN federation\'s has effect: a non-OPEN one pays evenly (ruling #1028)', () => {
  const n = net();
  const rec = (over) => { const b = buildFederationRecord({ federationId: FED, networkId: NET, invite: INVITE, nominal: 4, guardians: guardiansOf(n.census, FED), height: 200, reserveSats: 95000n, ...over }); b.capacityBand = 'CRITICAL'; return splitSignedRecord(joinSignedRecord(encodeFederationRecord(b), [])).record; };
  const drained = rec({ successorId: new Uint8Array(32).fill(9) }), open = rec({});
  assert.deepEqual([pressureOf(open), pressureOf(drained)], [{ band: 'CRITICAL', status: 'OPEN' }, { band: 'CRITICAL', status: 'DRAINING' }]);
  assert.equal(bandOfRecord(drained), 'CRITICAL', 'the band stays a fact about load, so the gap survives a status that can come back');
  const money = (r) => ({ reserveSats: r.reserveSats, exposureCapSats: r.exposureCapSats, ...pressureOf(r) });
  const weights = (r) => guardianWeights({ bonds: [{ node: 'a', bondSats: 50000n }, { node: 'b', bondSats: 90000n }], nominal: 4, bondMinSats: 50000n, ...money(r) });
  const pegs = { pegIns: [{ node: 'a', pegInSats: 10000n }, { node: 'b', pegInSats: 60000n }], pegInMinSats: 50000n };
  assert.notEqual(weights(open), null, 'OPEN and in the band: weighted');
  assert.equal(weights(drained), null, 'DRAINING: even');
  assert.notEqual(gatewayWeights({ ...pegs, ...money(open) }), null);
  assert.equal(gatewayWeights({ ...pegs, ...money(drained) }), null);
  assert.notEqual(pegInPressure({ ...pegs, ...money(open) }), null);
  assert.equal(pegInPressure({ ...pegs, ...money(drained) }), null);
  const halted = rec({ guardians: guardiansOf(n.census, FED).map((g, i) => ({ ...g })), gone: guardiansOf(n.census, FED).slice(0, 3).map((g) => ({ peerKey: g.peerKey, sinceHeight: 1, kind: 1, proofRef: new Uint8Array(32) })) });
  assert.equal(pressureOf(halted).status, 'HALTED'); assert.equal(weights(halted), null);
  // a record naming no band reads as it always did, so a network before its point pays the same on every signer of every release
  const before = { ...drained }; delete before.capacityBand;
  assert.deepEqual(pressureOf(before), { band: null, status: null });
  assert.notEqual(weights(before), null, 'as today');
});

test('kanban #1322: the seats write the player reserve (reserve less the gateways\' proved e-cash) with the fee cap, each signing only its own same sum; the band reads it', async () => {
  const { GATEWAY_FEE_MAX_REFERENCE } = await import('../../arena-protocol/src/federation-record.js');
  // every seat counts the two gateways' held locks: 30,000 + 20,000 of a 65,000 reserve
  const n = net({ heldAt: () => [30000n, 20000n] });
  const r = await n.step(96, 65000);
  assert.equal(r.ok, true, r.why);
  const rec = n.seats[0].recordOf(toHex(FED)).record;
  console.log('  MEASURED #1322:', JSON.stringify({ reserve: String(rec.reserveSats), player: String(rec.playerReserveSats), cap: String(rec.exposureCapSats), band: rec.capacityBand, signers: r.signers }));
  assert.equal(rec.playerReserveSats, 15000n);
  assert.deepEqual(rec.gatewayFeeMax, GATEWAY_FEE_MAX_REFERENCE);
  // a 75 % reserve is PRESSURE by the reserve - by the players' money (45 %) it is CALM
  assert.equal((await n.step(102, 95000)).ok, true);
  assert.equal(n.bandAt(), 'CALM', 'the band read the whole reserve, not the players\' money');
  // one seat counts another sum: it does not sign that body, and says why
  const odd = net({ heldAt: (i) => (i === 2 ? [30000n] : [30000n, 20000n]) });
  const ro = await odd.step(96, 65000);
  assert.equal(ro.ok, true, ro.why);
  const said = await odd.seats[2].mySignature(toHex(FED), 96, '65000', { inviteFederationId, player: 15000n });
  assert.equal(said.ok, false);
  assert.match(said.why, /player reserve of 35000 sat, not 15000/);
  // no seat counts held e-cash: the record as before - no cap, no player reserve
  const none = net();
  assert.equal((await none.step(96, 65000)).ok, true);
  const plain = none.seats[0].recordOf(toHex(FED)).record;
  assert.deepEqual([plain.gatewayFeeMax, plain.playerReserveSats], [undefined, undefined]);
});

test('kanban #1321: a guardian-called succession signs its reason after the player reserve, and pays drain shares only with it', async () => {
  const NEW = 'cd'.repeat(32);
  for (const reason of [null, { kind: 'NOMINAL_CHANGE', ref: new Uint8Array(32) }, { kind: 'LISTED_UPGRADE', ref: new Uint8Array(32).fill(0xab) }]) {
    const n = net({ heldAt: () => [30000n, 20000n] });
    n.w.successor = NEW; n.w.reason = reason;
    const r = await n.step(96, 65000);
    assert.equal(r.ok, true, r.why);
    const rec = n.seats[0].recordOf(toHex(FED)).record;
    const paid = n.seats[0].predecessorGuardians(NEW).length;
    console.log(`  MEASURED #1321 reason ${reason ? reason.kind : 'none'}: status ${n.seats[0].list()[0].status}, reason in record ${rec.successionReason ? rec.successionReason.kind : 'none'}, ${r.signers} signers, drain shares to ${paid}`);
    assert.equal(n.seats[0].list()[0].status, 'DRAINING');
    assert.equal(rec.successionReason ? rec.successionReason.kind : null, reason ? reason.kind : null);
    if (reason && reason.kind === 'LISTED_UPGRADE') assert.deepEqual([...rec.successionReason.ref], [...reason.ref]);
    assert.equal(paid, reason ? 4 : 0);
  }
});
