// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A SEAT'S PART IN A FOUNDING (spec §23A.2): a record entering DRAINING at 200 triggers a succession; every seat reads the
// same beacon (block 201) and census and draws the same four; only nodes whose guardian waits in setup take part; a seat whose post
// was lost picks the codes up from a peer's GET /founding; the CLI setup is called with the guardian's own socket and password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { setupDigest } from '../src/founding.js';
import * as seatMod from '../src/founding-seat.js';
const { createFoundingSeat, guardingWhy, cliSetup, execCli } = seatMod;
import { drawGuardians } from '../../arena-protocol/src/guardian-founding.js';
import { execFile } from 'node:child_process';
import { mkdtempSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const key = (s) => { const secret = taggedHash('TEST/fseat', new TextEncoder().encode(s)); return { secret, pub: schnorr.getPublicKey(secret) }; };
const verify = (sig, m, k) => { try { return schnorr.verify(sig, m, k); } catch { return false; } };
const keys = Array.from({ length: 6 }, (_, i) => key(`n${i}`));
const entries = keys.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/tx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
  advert: { operatorId: `op${i}`, guardianCapable: true, guardianEndpoint: `wss://g${i}` } }));
const clocks = { abandonBlocks: 10, foundingWindow: 10 };

function world({ draining = true, lossy = new Set() } = {}) {
  const w = { tip: 200, log: [] };
  const recs = [{ federation: 'aa'.repeat(32), status: draining ? 'DRAINING' : 'OPEN', height: 200 }];
  const seats = [];
  for (let i = 0; i < 6; i++) {
    const setup = { localParams: async ({ leader }) => { w.log.push(['params', i, leader]); return `code-${i}`; }, addPeer: async (c) => { w.log.push(['add', i, c]); },
      startDkg: async () => { w.log.push(['dkg', i]); }, invite: async () => null };
    seats.push(createFoundingSeat({ records: () => recs, entriesAt: async (h) => (h === 200 ? entries : null),
      beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
      guardianInSetup: async () => true, setup, nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: keys[i].pub,
      sign: (h) => schnorr.sign(h, keys[i].secret), verify,
      post: async (m) => { for (let j = 0; j < 6; j++) if (!lossy.has(j)) seats[j].take(m); },
      peers: () => [0, 1, 2, 3, 4, 5].filter((j) => j !== i).map((j) => `seat${j}`),
      fetchJson: async (u) => seats[parseInt(u.slice(4), 10)].state() }));
  }
  return { w, seats };
}

test('no founding without a trigger, and none before the beacon after it is in the chain', async () => {
  const { seats } = world({ draining: false });
  assert.equal((await seats[0].tick()).ok, false);
  const b = world();
  const r = await b.seats[0].tick();
  assert.equal(r.ok, false); assert.match(r.why, /beacon after 200/);
});

test('a succession: every seat draws the same four on block 201; a seat that missed every post reads the codes from its peers', async () => {
  const { w, seats } = world({ lossy: new Set([2, 5]) });
  w.tip = 201;
  for (const s of seats) await s.tick();
  for (const s of seats) await s.tick();
  const st = seats.map((s) => s.state());
  for (const x of st) assert.deepEqual(x.seated.map((y) => y.node), st[0].seated.map((y) => y.node));
  assert.equal(st[0].trigger.kind, 'succession');
  const seated = st[0].seated.map((y) => keys.findIndex((k) => toHex(k.pub) === y.node));
  for (const i of seated) assert.ok(w.log.some((l) => l[0] === "dkg" && l[1] === i), `seat ${i} ran the DKG: ${JSON.stringify({ seated, codes: st[i].seated.map((y) => y.code), log: w.log.filter((l) => l[1] === i) })}`);
});

test('the CLI setup names the guardian\'s own socket and password, and the leader names the federation', async () => {
  const calls = [];
  const s = cliSetup({ run: async (a) => { calls.push(a); return '"code-x"\n'; }, apiPort: 32221, password: 'pw', guardianName: 'node-1' });
  assert.equal(await s.localParams({ leader: true, name: 'arena', size: 4 }), 'code-x');
  await s.addPeer('code-y'); await s.startDkg();
  assert.deepEqual(calls[0], ['--password', 'pw', 'admin', 'setup', 'ws://127.0.0.1:32221', 'set-local-params', 'node-1', '--federation-name', 'arena', '--federation-size', '4']);
  assert.deepEqual(calls[1].slice(5), ['add-peer', 'code-y']);
  assert.deepEqual(calls[2].slice(5), ['start-dkg']);
});

test('whether the guardian waits in setup is asked of the setup API (rehearsal 20b: a setup-mode guardian has no admin status)', async () => {
  const said = (answer) => cliSetup({ run: async (a) => { if (a.includes('status')) { if (answer instanceof Error) throw answer; return `"${answer}"\n`; } return '""'; }, apiPort: 32221, password: 'pw', guardianName: 'n' });
  assert.equal(await said('AwaitingLocalParams').inSetup(), true);
  assert.equal(await said('SharingConnectionCodes').inSetup(), true);
  assert.equal(await said('ConsensusIsRunning').inSetup(), false, 'a running federation: not in setup');
  assert.equal(await said(new Error('Method not found')).inSetup(), false, 'no answer: not taken for setup');
});

// THE GENESIS AND LOAD TRIGGERS, FROM THE HISTORY THE SEAT KEEPS AT EACH TICK
function triggerSeat({ recs, w, from = 0 }) {
  const setup = { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null };
  return createFoundingSeat({ records: () => recs(), entriesAt: async (h) => (h >= from ? entries : []),
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => true, setup, nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: keys[0].pub,
    sign: (h) => schnorr.sign(h, keys[0].secret), verify });
}

test('genesis: no federation and six guardian-capable operators in the census - the first federation is drawn on the block after', async () => {
  const w = { tip: 300 };
  const seat = triggerSeat({ recs: () => [], w, from: 300 });           // the census holds them from 300 on
  const first = await seat.tick();
  assert.equal(first.ok, false); assert.match(first.why, /beacon after 300/);
  w.tip = 301;
  const r = await seat.tick();
  assert.equal(r.ok, true, r.why); assert.deepEqual([r.trigger.kind, r.trigger.height], ['genesis', 300]);
});

test('load: every OPEN federation at or above 80 % of its cap for abandon_blocks triggers a new federation; one dip restarts the count', async () => {
  const w = { tip: 400 };
  let load = 0.85;
  const seat = triggerSeat({ recs: () => [{ federation: 'aa'.repeat(32), status: 'OPEN', height: 390, load }, { federation: 'bb'.repeat(32), status: 'OPEN', height: 390, load: 0.9 }], w });
  for (; w.tip < 405; w.tip++) assert.equal((await seat.tick()).ok, false);
  load = 0.5; await seat.tick(); load = 0.85;                       // a dip at 405
  for (w.tip = 406; w.tip < 416; w.tip++) assert.equal((await seat.tick()).ok, false, `no trigger at ${w.tip}: 10 blocks from 406 not yet complete`);
  const at416 = await seat.tick();                                  // 416 - 406 = abandon_blocks: the trigger, its beacon still to come
  assert.equal(at416.ok, false); assert.match(at416.why, /beacon after 416/);
  w.tip = 417;
  const r = await seat.tick();
  assert.equal(r.ok, true, r.why); assert.deepEqual([r.trigger.kind, r.trigger.height], ['load', 416]);
});

// THE SUCCESSION BY NOTICE (§23A.6): federation F of four (n0..n3, 3 of 4) is OPEN; n3 posts a departure notice at 500 -
// three seated is CRITICAL at four - so the seats draw F's successor on the beacon 501: n0..n2 seated first in the record's order, each
// through its guardian-next (its own guardian runs F), and one seat drawn of the others: not n3's operator (leaving), not the decoy's
// (it guards G, OPEN). A notice that does not stand, or that leaves the federation OPEN, triggers nothing.
import { buildFederationRecord, statusFor } from '../../arena-protocol/src/federation-record.js';
import { signDeparture } from '../../arena-protocol/src/absence.js';
import { noticeTriggers, guardingOpenOf } from '../src/founding-seat.js';

const F = taggedHash('TEST/fed', Uint8Array.of(1)), G = taggedHash('TEST/fed', Uint8Array.of(2));
const sKeys = Array.from({ length: 8 }, (_, i) => key(`s${i}`));             // s0..s3 guard F, s4 'node15', s5 op5, s6 op6, s7 the decoy (guards G)
const peerKeyOf = (i) => Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i))]);
const sOps = ['op0', 'op1', 'op2', 'op3', 'node15', 'op5', 'op6', 'decoy'];
const sEntries = sKeys.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/stx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
  advert: { operatorId: sOps[i], guardianCapable: true, guardianEndpoint: `wss://s${i}/guardian`,
    guardianOf: i < 4 ? [{ federationId: F, guardianKey: peerKeyOf(i) }] : i === 7 ? [{ federationId: G, guardianKey: peerKeyOf(7) }] : [] } }));
const recordF = (nominal = 4, n = 4) => buildFederationRecord({ federationId: F, networkId: new Uint8Array(32), invite: 'fed11', nominal, height: 480,
  guardians: sKeys.slice(0, n).map((k, i) => ({ peerKey: peerKeyOf(i), nodePubkey: k.pub, operatorId: sOps[i], bondTxid: sEntries[i].txid, bondVout: 0, endpoint: `wss://s${i}/guardian`, bondSats: 1000000n })) });
const notice = (i, { postedAt = 500, leaveAfter = 520 } = {}) => signDeparture({ federationId: F, peerKey: peerKeyOf(i), leaveAfterHeight: leaveAfter, postedAt, nodePubkey: sKeys[i].pub },
  (h) => schnorr.sign(h, sKeys[i].secret));
const sClocks = { abandonBlocks: 10, foundingWindow: 10, departureNotice: 10 };

test('the notice trigger: a standing notice that leaves F CRITICAL (four) or DRAINING (seven) - not one too short, not one that leaves it OPEN', () => {
  const held = [{ federation: toHex(F), status: 'OPEN', height: 480, record: recordF() }];
  const rows = noticeTriggers({ held, notices: [notice(3)], departureNotice: 10, verify });
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0].federation, rows[0].height, rows[0].wouldBe], [toHex(F), 500, 'CRITICAL']);
  assert.deepEqual(rows[0].seatedFirst, recordF().guardians.filter((g) => toHex(g.nodePubkey) !== toHex(sKeys[3].pub)).map((g) => toHex(g.nodePubkey)), 'the record\'s order');
  assert.deepEqual(rows[0].departing, [toHex(sKeys[3].pub)]);
  assert.equal(noticeTriggers({ held, notices: [notice(3, { leaveAfter: 505 })], departureNotice: 10, verify }).length, 0, 'leave_after short of departure_notice: it does not stand');
  assert.equal(noticeTriggers({ held: [{ ...held[0], status: 'CLOSED' }], notices: [notice(3)], departureNotice: 10, verify }).length, 0, 'a CLOSED federation is not succeeded');
  const forged = { ...notice(3), signature: schnorr.sign(new Uint8Array(32), sKeys[0].secret) };
  assert.equal(noticeTriggers({ held, notices: [forged], departureNotice: 10, verify }).length, 0, 'not signed by the leaving node');
  // seven: one leaving makes it DRAINING; ten: still OPEN (statusFor), no trigger
  assert.equal(statusFor({ nominal: 7, seated: 6 }).status, 'DRAINING');
  assert.equal(statusFor({ nominal: 10, seated: 9 }).status, 'OPEN');
});

test('guardingOpenOf: an OPEN federation at load >= 1 holds nobody back (2026-10-22: "Also when federation is over loaded?")', () => {
  const both = (lf, lg) => [...guardingOpenOf({ entries: sEntries, held: [{ federation: toHex(F), status: 'OPEN', load: lf }, { federation: toHex(G), status: 'OPEN', load: lg }], except: null })].sort();
  const all = both(0.5, 0.5);
  assert.ok(all.length >= 1, 'under load: its guardians guard it');
  assert.deepEqual(both(4.33, 4.33), all, 'overloaded, but no node advertises a free founding slot: nobody is freed (kanban #599)');
  assert.deepEqual(both(0.99, 0.99), all, 'just under 1 is not overloaded');
  // WITH A FREE SLOT (kanban #599, 2026-10-23 "Nur mit freiem Slot"): every node advertising guardian_capable 2 is freed by an overloaded federation
  const slotted = sEntries.map((e) => ({ ...e, advert: { ...e.advert, foundingSlot: true } }));
  const bothSlot = (lf, lg) => [...guardingOpenOf({ entries: slotted, held: [{ federation: toHex(F), status: 'OPEN', load: lf }, { federation: toHex(G), status: 'OPEN', load: lg }], except: null })].sort();
  assert.deepEqual(bothSlot(4.33, 4.33), [], 'both overloaded and every node has a free slot: every guardian is free for a founding');
  assert.deepEqual(bothSlot(0.5, 0.5), all, 'a free slot frees nobody from a federation under load');
});

test('guardingOpenOf: operators whose adverts name a federation held OPEN, other than the one succeeded', () => {
  const held = [{ federation: toHex(F), status: 'OPEN' }, { federation: toHex(G), status: 'OPEN' }];
  assert.deepEqual([...guardingOpenOf({ entries: sEntries, held, except: toHex(F) })], ['decoy']);
  assert.deepEqual([...guardingOpenOf({ entries: sEntries, held: [{ federation: toHex(F), status: 'DRAINING' }, { federation: toHex(G), status: 'DRAINING' }], except: null })], [], 'a draining federation does not count');
  // (the owner "A"): a federation no seat holds a record of counts as guarded - its guardians are not free for a cohort
  assert.deepEqual([...guardingOpenOf({ entries: sEntries, held: [{ federation: toHex(F), status: 'DRAINING' }], except: null })], ['decoy'], 'no record of G: its guardian counts as guarding it');
  assert.deepEqual([...guardingOpenOf({ entries: sEntries, held: [], except: toHex(G) })].sort(), [...guardingOpenOf({ entries: sEntries, held: [{ federation: toHex(F), status: 'OPEN' }], except: toHex(G) })].sort(), 'unknown counts as OPEN');
});

test('a succession by notice: the remaining guardians seated first through their guardian-next, one drawn of the others, the DKG on the four', async () => {
  const w = { tip: 500, log: [] };
  const held = [{ federation: toHex(F), status: 'OPEN', height: 480, record: recordF() }, { federation: toHex(G), status: 'OPEN', height: 470 }];
  const seats = [];
  const fake = (i, which) => ({ localParams: async ({ leader }) => { w.log.push(['params', i, which, leader]); return `code-${i}`; },
    addPeer: async (c) => { w.log.push(['add', i, which, c]); }, startDkg: async () => { w.log.push(['dkg', i, which]); }, invite: async () => null });
  for (let i = 0; i < 8; i++) {
    const own = i >= 4 && i <= 6;                       // s4..s6 hold no ceremony files: their own guardian waits in setup
    seats.push(createFoundingSeat({ records: () => held, notices: () => [notice(3)], entriesAt: async (h) => (h === 500 ? sEntries : null),
      beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
      guardianInSetup: async () => own, setup: fake(i, 'guardian'),
      next: i < 3 ? { inSetup: async () => true, setup: fake(i, 'guardian-next') } : null,
      nominal: 4, bondMinGuardian: 500000n, clocks: sClocks, ownKey: sKeys[i].pub, sign: (h) => schnorr.sign(h, sKeys[i].secret), verify,
      post: async (m) => { for (const s of seats) s.take(m); },
      peers: () => [0, 1, 2, 3, 4, 5, 6, 7].filter((j) => j !== i).map((j) => `seat${j}`), fetchJson: async (u) => seats[parseInt(u.slice(4), 10)].state() }));
  }
  assert.match((await seats[0].tick()).why, /beacon after 500/);
  w.tip = 501;
  for (const s of seats) await s.tick();
  for (const s of seats) await s.tick();
  const st = seats[4].state();
  assert.deepEqual([st.trigger.kind, st.trigger.notice, st.trigger.height, st.trigger.federation], ['succession', true, 500, toHex(F)]);
  assert.equal(st.seatedFirst, 3);
  const ix = (hex) => sKeys.findIndex((k) => toHex(k.pub) === hex);
  const seated = st.seated.map((x) => ix(x.node));
  assert.deepEqual(seated.slice(0, 3), recordF().guardians.slice(0, 4).map((g) => ix(toHex(g.nodePubkey))).filter((i) => i !== 3), 'seated first in the record\'s order');
  assert.ok([4, 5, 6].includes(seated[3]), `drawn of s4..s6: ${seated[3]}`);
  assert.ok(![3, 7].some((i) => [...seated, ...st.alternates.map(ix)].includes(i)), 'neither the leaving operator nor the decoy');
  for (const i of seated.slice(0, 3)) {
    assert.equal(seats[i].state().via, 'guardian-next');
    assert.ok(w.log.some((l) => l[0] === 'dkg' && l[1] === i && l[2] === 'guardian-next'), `s${i} ran its DKG on its guardian-next`);
    assert.ok(!w.log.some((l) => l[1] === i && l[2] === 'guardian'), `s${i}'s running guardian was not touched`);
  }
  assert.equal(seats[seated[3]].state().via, 'guardian');
  assert.ok(w.log.some((l) => l[0] === 'dkg' && l[1] === seated[3] && l[2] === 'guardian'), 'the drawn node on its own setup-mode guardian');
  assert.deepEqual(w.log.filter((l) => l[0] === 'params' && l[3]).map((l) => l[1]), [seated[0]], 'the first seated-first node leads');
  assert.equal(seats[3].state().via, null, 'the leaving node takes no part');
});

test('federation B: a notice from B7 founds a successor of SEVEN (the record\'s nominal, not genesis\'s 4) - B1..B6 seated first, node15 drawn', async () => {
  const bKeys = Array.from({ length: 8 }, (_, i) => key(`b${i}`));                 // b0..b6 guard B (one operator, 2of2), b7 is node15
  const B = taggedHash('TEST/fed', Uint8Array.of(7));
  const ents = bKeys.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/btx', Uint8Array.of(i)), vout: 0, bondSats: 50000n,
    advert: { operatorId: i < 7 ? '2of2' : 'node15', guardianCapable: true, guardianEndpoint: `wss://b${i}/guardian`, guardianOf: i < 7 ? [{ federationId: B, guardianKey: peerKeyOf(20 + i) }] : [] } }));
  const rec = buildFederationRecord({ federationId: B, networkId: new Uint8Array(32), invite: 'fed11', nominal: 7, height: 700,
    guardians: bKeys.slice(0, 7).map((k, i) => ({ peerKey: peerKeyOf(20 + i), nodePubkey: k.pub, operatorId: '2of2', bondTxid: ents[i].txid, bondVout: 0, endpoint: `wss://b${i}/guardian`, bondSats: 50000n })) });
  const d = signDeparture({ federationId: B, peerKey: peerKeyOf(26), leaveAfterHeight: 730, postedAt: 710, nodePubkey: bKeys[6].pub }, (h) => schnorr.sign(h, bKeys[6].secret));
  const w = { tip: 711 };
  const seat = createFoundingSeat({ records: () => [{ federation: toHex(B), status: 'OPEN', height: 700, record: rec }], notices: () => [d], entriesAt: async () => ents,
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => false, setup: null, nominal: 4, bondMinGuardian: 50000n, clocks: { abandonBlocks: 12, foundingWindow: 18, departureNotice: 18 },
    ownKey: bKeys[7].pub, sign: (h) => schnorr.sign(h, bKeys[7].secret), verify });
  const r = await seat.tick();
  assert.equal(r.ok, true, r.why);
  assert.deepEqual([r.trigger.kind, r.trigger.height, r.trigger.nominal], ['succession', 710, 7]);
  const st = seat.state();
  assert.equal(st.seated.length, 7); assert.equal(st.seatedFirst, 6);
  const at = (hex) => bKeys.findIndex((k) => toHex(k.pub) === hex);
  assert.deepEqual(st.seated.slice(0, 6).map((x) => at(x.node)).sort(), [0, 1, 2, 3, 4, 5]);
  assert.equal(at(st.seated[6].node), 7, 'node15 drawn into the seventh seat');
  assert.deepEqual(st.alternates, []);
});

// the cohort draws fall on the multiples of founding_window + 1 (guardian-founding.js): a 9-block window draws at 290, 300, 310
const cClocks = { abandonBlocks: 10, foundingWindow: 9 };

// §23A.2 RULED 2026-11-07 (kanban #1297/#1323): a cohort seats at least f + 1 guardians of OPEN federations - before, ten new operators founded
// a federation of ten while B was OPEN and B's guardians were left out; now that founds nothing, and B's guardians with a free slot are drawn first
test('a cohort (protocol 2026.0.14) while federation B is OPEN: ten new operators alone found nothing; B\'s four guardians with a free founding slot take f + 1 = 4 seats, six new ones the rest (kanban #1323)', async () => {
  const bFed = 'bb'.repeat(32);
  const all = Array.from({ length: 14 }, (_, i) => key(`c${i}`));
  const entriesWith = (slot) => all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/ctx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `cop${i}`, guardianCapable: true, guardianEndpoint: `wss://c${i}`, ...(i < 4 && slot ? { foundingSlot: true } : {}),
      guardianOf: i < 4 ? [{ federationId: Uint8Array.from(Buffer.from(bFed, 'hex')), guardianKey: new Uint8Array(33) }] : [] } }));
  const held = [{ federation: bFed, status: 'OPEN', height: 300 }];
  const run = async (slot) => {
    const cEntries = entriesWith(slot), w = { tip: 300 };
    const s = createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? cEntries : cEntries.slice(0, 4)),
      beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
      guardianInSetup: async () => true, setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null },
      nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[5].pub, sign: (h) => schnorr.sign(h, all[5].secret), verify });
    const first = await s.tick();
    assert.match(first.why, /beacon after 300/, 'triggered at 300, drawn on block 301');
    w.tip = 301;
    return { r: await s.tick(), st: s.state() };
  };
  const alone = await run(false);
  const why = String(alone.r.why || (alone.st && alone.st.why) || '');
  console.log('  MEASURED #1323 seat, no slot:', JSON.stringify({ ok: alone.r.ok, seated: alone.st && alone.st.seated ? alone.st.seated.length : 0, why: why.slice(0, 160) }));
  assert.ok(!(alone.st && alone.st.seated && alone.st.seated.length), 'ten new operators founded alone');
  const vets = await run(true);
  assert.equal(vets.r.ok, true, vets.r.why);
  assert.deepEqual([vets.st.trigger.kind, vets.st.trigger.height, vets.st.seated.length], ['cohort', 300, 10]);
  const drawn = new Set(vets.st.seated.map((y) => y.node));
  const bDrawn = [0, 1, 2, 3].filter((i) => drawn.has(toHex(all[i].pub))).length;
  console.log('  MEASURED #1323 seat, slots:', JSON.stringify({ seated: vets.st.seated.length, ofB: bDrawn, firstFour: vets.st.seated.slice(0, 4).every((y) => [0, 1, 2, 3].some((i) => toHex(all[i].pub) === y.node)) }));
  assert.equal(bDrawn, 4, 'B\'s guardians take f + 1 seats');
});

test('a drawn node whose guardian is not in setup (left in a failed key generation) starts it again in a fresh setup, once, and takes part (kanban #495, the installers 2026-10-22)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`f${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/ftx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `fop${i}`, guardianCapable: true, guardianEndpoint: `wss://f${i}`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 300 }];
  const w = { tip: 300 };
  const make = (i, flags) => createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? cEntries : []),
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => flags.inSetup,
    setup: { localParams: async () => `code-${i}`, addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, done: async () => flags.running,
      // the guardian exited (verified by its node: DOWN), or runs its federation (kanban #1177: a fresh setup only on a verified reading)
      status: async () => (flags.running ? 'running' : flags.inSetup ? 'setup' : 'down'),
      freshSetup: async () => { flags.fresh++; flags.inSetup = true; return { ok: true, kept: 'database.void-x' }; } },
    nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[i].pub, sign: (h) => schnorr.sign(h, all[i].secret), verify });
  // find a node the draw seats
  const probe = make(0, { inSetup: true, running: false, fresh: 0 }); await probe.tick(); w.tip = 301; await probe.tick();
  const seatedKey = probe.state().seated[0].node, i = all.findIndex((k) => toHex(k.pub) === seatedKey);
  w.tip = 300;
  const flags = { inSetup: false, running: false, fresh: 0 };
  const s = make(i, flags);
  await s.tick(); w.tip = 301; await s.tick(); await s.tick();
  assert.equal(flags.fresh, 1, 'started again once for this founding');
  assert.equal(s.state().via, 'guardian', 'and it takes part');
  // a guardian running a federation is never started again
  w.tip = 300;
  const busy = { inSetup: false, running: true, fresh: 0 };
  const b = make(i, busy); await b.tick(); w.tip = 301; await b.tick();
  assert.equal(busy.fresh, 0);
});

test('a guardian that waits in setup only after the tick that started it takes part on the next tick (kanban #577: n495-1/2 at a27706f2, asked before fedimintd answered)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`g${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/gtx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `gop${i}`, guardianCapable: true, guardianEndpoint: `wss://g${i}`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 300 }];
  const w = { tip: 300 };
  const make = (i, flags) => createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? cEntries : []),
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => flags.inSetup,
    setup: { localParams: async () => `code-${i}`, addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, done: async () => false,
      status: async () => (flags.inSetup ? 'setup' : 'down'),
      freshSetup: async () => { flags.fresh++; return { ok: true, kept: 'database.void-x' }; } },
    nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[i].pub, sign: (h) => schnorr.sign(h, all[i].secret), verify });
  const probe = make(0, { inSetup: true, fresh: 0 }); await probe.tick(); w.tip = 301; await probe.tick();
  const i = all.findIndex((k) => toHex(k.pub) === probe.state().seated[0].node);
  w.tip = 300;
  const flags = { inSetup: false, fresh: 0 };
  const s = make(i, flags);
  await s.tick(); w.tip = 301; await s.tick();
  assert.deepEqual([flags.fresh, s.state().via], [1, null], 'started again, not yet in setup when asked');
  flags.inSetup = true;   // fedimintd's setup API answers now
  await s.tick();
  assert.equal(s.state().via, 'guardian', 'the next tick joins the founding with the guardian');
  assert.ok(s.state().codes.some((c) => c.node === toHex(all[i].pub)), 'and posts its own code');
  assert.equal(flags.fresh, 1, 'not started again');
});

test('a seat that holds no record (no round) sees the federation the census names: the cohort triggers there, not a genesis (the seven new second-host seats drew genesis at 156970)', async () => {
  const bFed = 'bb'.repeat(32);
  const all = Array.from({ length: 14 }, (_, i) => key(`r${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/rtx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `rop${i}`, guardianCapable: true, guardianEndpoint: `wss://r${i}`,
      guardianOf: i < 4 ? [{ federationId: Uint8Array.from(Buffer.from(bFed, 'hex')), guardianKey: new Uint8Array(33) }] : [] } }));
  const w = { tip: 300 };
  const s = createFoundingSeat({ records: () => [], entriesAt: async (h) => (h >= 300 ? cEntries : cEntries.slice(0, 4)),
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => true, setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null },
    nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[7].pub, sign: (h) => schnorr.sign(h, all[7].secret), verify });
  await s.tick();
  w.tip = 301;
  const r = await s.tick();
  assert.equal(r.ok, true, r.why);
  const st = s.state();
  assert.deepEqual([st.trigger.kind, st.trigger.height, st.seated.length], ['cohort', 300, 10], 'the cohort of ten, not a genesis of four');
  const drawn = new Set(st.seated.map((y) => y.node));
  for (let i = 0; i < 4; i++) assert.ok(!drawn.has(toHex(all[i].pub)), `B's guardian ${i}: no record, still guarding (a')`);
});

test('seats that hold no round and name no peers read the drawn nodes\' codes at their adverts\' endpoints (kanban #495: every cohort draw went void, each seat holding only its own code)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`e${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/etx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `eop${i}`, guardianCapable: true, endpoint: `ws://10.0.0.1:${6500 + i}`, guardianEndpoint: `ws://10.0.0.1:${6500 + i}/guardian`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 300 }];
  const w = { tip: 300 };
  const seats = [];
  const byRoot = new Map();
  for (let i = 0; i < 12; i++) {
    const s = createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? cEntries : []),
      beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
      guardianInSetup: async () => true, setup: { localParams: async () => `code-${i}`, addPeer: async () => {}, startDkg: async () => {}, invite: async () => null },
      nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[i].pub, sign: (h) => schnorr.sign(h, all[i].secret), verify,
      post: async () => {},                                  // every post lost, and no configured peers: as on the seven second-host seats
      peers: () => [],
      fetchJson: async (u) => { const s2 = byRoot.get(u.replace(/\/founding$/, '')); if (!s2) throw new Error('no such seat'); return s2.state(); } });
    seats.push(s); byRoot.set(`http://10.0.0.1:${6500 + i}`, s);
  }
  for (const s of seats) await s.tick();
  w.tip = 301;
  for (const s of seats) await s.tick();                  // each makes its own code
  for (const s of seats) await s.tick();                  // and reads the others' at their endpoints
  const st = seats[0].state();
  assert.deepEqual([st.trigger.kind, st.seated.length], ['cohort', 10]);
  for (const s of seats) {
    const x = s.state();
    if (!x.seated.some((y) => y.node === toHex(all[seats.indexOf(s)].pub))) continue;   // an alternate holds no code of its own
    assert.equal(x.seated.filter((y) => y.code).length, 10, 'a drawn seat holds every drawn code');
  }
});

test('seats started at different heights draw the same cohort, and a void one is drawn again founding_window + 1 later (kanban #495: the seven second-host seats drew at 157,178, the installers at 157,179)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`d${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/dtx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `dop${i}`, guardianCapable: true, guardianEndpoint: `wss://d${i}`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 280 }];
  const w = { tip: 293 };
  const reads = [];
  const seat = (i) => createFoundingSeat({ records: () => held, entriesAt: async (h) => { reads.push(h); return h >= 290 ? cEntries : cEntries.slice(0, 3); },
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => true, setup: { localParams: async () => `code-${i}`, addPeer: async () => {}, startDkg: async () => {}, invite: async () => null },
    nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[i].pub, sign: (h) => schnorr.sign(h, all[i].secret), verify });
  const early = seat(0);
  await early.tick();                                     // started at 293: the run began at 290, read back from the chain
  assert.equal(early.state().trigger.height, 290);
  w.tip = 296;
  const late = seat(1);
  await late.tick(); await early.tick();
  assert.equal(late.state().id, early.state().id, 'a seat started later names the same founding');
  assert.equal(late.state().trigger.height, 290);
  assert.ok(reads.includes(289) && !reads.includes(288), 'the first tick reads back to the run\'s start and one height before, no further');
  w.tip = 311;                                            // the window of 290 (beacon 291, foundingWindow 9) has passed; draws on the multiples of 10
  const fresh = seat(2);
  await fresh.tick(); await late.tick();
  assert.equal(fresh.state().trigger.height, 310, 'drawn again on the next multiple of founding_window + 1');
  assert.equal(late.state().trigger.height, 310, 'the seat that held 290 moves to the same next draw');
  assert.equal(fresh.state().id, late.state().id);
});

test('a node whose advert names a dead endpoint still seats its code: each seat sends its own code to the drawn nodes every tick (kanban #495: the installers\' adverts named old quick tunnels)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`q${i}`));
  const live = (i) => `http://10.0.0.1:${6600 + i}`;
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/qtx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `qop${i}`, guardianCapable: true, endpoint: i >= 9 ? `https://old-tunnel-${i}.example` : live(i).replace('http:', 'ws:'),
      guardianEndpoint: `wss://g${i}`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 300 }];
  const w = { tip: 300 };
  const seats = [], byRoot = new Map();
  for (let i = 0; i < 12; i++) {
    const s = createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? cEntries : []),
      beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
      guardianInSetup: async () => true, setup: { localParams: async () => `code-${i}`, addPeer: async () => {}, startDkg: async () => {}, invite: async () => null },
      nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[i].pub, sign: (h) => schnorr.sign(h, all[i].secret), verify,
      post: async () => {}, peers: () => [],
      fetchJson: async (u) => { const s2 = byRoot.get(u.replace(/\/founding$/, '')); if (!s2) throw new Error('no such seat'); return s2.state(); },
      postTo: async (root, m) => { const s2 = byRoot.get(root); if (!s2) throw new Error('no such seat'); s2.take(m); } });
    seats.push(s); byRoot.set(live(i), s);              // the old tunnels answer nothing; every seat's live root does
  }
  for (const s of seats) await s.tick();
  w.tip = 301;
  for (let n = 0; n < 3; n++) for (const s of seats) await s.tick();
  let checked = 0;
  for (const [i, s] of seats.entries()) {
    const x = s.state();
    if (!x.seated.some((y) => y.node === toHex(all[i].pub))) continue;
    assert.equal(x.seated.filter((y) => y.code).length, 10, `drawn seat ${i} holds every drawn code, the dead-advert nodes' too`);
    checked++;
  }
  assert.ok(checked >= 8);
  assert.ok(seats.slice(9).some((s, j) => s.state().seated.some((y) => y.node === toHex(all[9 + j].pub))), 'a dead-advert node is drawn');
});

// THE CLI'S REFUSAL REACHES THE FOUNDING (kanban #495, founding 53be35a3: two seated nodes never posted a code - fedimint-cli says "Local
// parameters have already been set" on stdout, the exec error's message held only "Command failed", and the fresh setup that reads the
// refusal never started). A stand-in CLI that refuses as the real one does, run as the seat runs it.
test('a refusal fedimint-cli prints on stdout is in the error the founding reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cli-'));
  const bin = join(dir, 'fedimint-cli');
  writeFileSync(bin, "#!/bin/sh\necho '{ \"error\": \"Config Gen Error: Federation rpc error { method => set_local_params, 1024 => Unspecified server error: Local parameters have already been set }\" }'\nexit 1\n");
  chmodSync(bin, 0o755);
  const setup = cliSetup({ run: (args) => execCli(execFile, bin, args), apiPort: 7551, password: 'pw-6463e63e', guardianName: 'ab'.repeat(8) });
  await assert.rejects(setup.localParams({ leader: true, name: 'arena', size: 10 }), /Local parameters have already been set/);
  // and the refusal, which the seat logs, never carries the guardian's password (measured 2026-10-26 on n495-1)
  const said = await setup.localParams({ leader: true, name: 'arena', size: 10 }).catch((e) => e);
  assert.doesNotMatch(`${said.message} ${JSON.stringify(said.cmd)}`, /pw-6463e63e/);
  assert.match(said.message, /--password <hidden>/);
  const ok = join(dir, 'ok-cli');
  writeFileSync(ok, "#!/bin/sh\necho '\"code123\"'\n");
  chmodSync(ok, 0o755);
  assert.equal(await cliSetup({ run: (a) => execCli(execFile, ok, a), apiPort: 1, password: 'p', guardianName: 'g' }).localParams({ leader: false }), 'code123');
});

test('readiness: the guardian in setup, running or none, the newest count of free operators against ten, and why no founding started (kanban #585)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`h${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/htx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `hop${i}`, guardianCapable: true, guardianEndpoint: `wss://h${i}`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 300 }];
  const w = { tip: 300 }, g = { inSetup: true, running: false };
  const s = createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? cEntries : []),
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => g.inSetup, setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, done: async () => g.running },
    nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[0].pub, sign: (h) => schnorr.sign(h, all[0].secret), verify });
  await s.tick();
  const r = await s.readiness(1000);
  assert.deepEqual(r, { guardian: 'setup', cohort: { height: 300, free: 12, needed: 10, operators: 12, nodes: all.map((k) => toHex(k.pub)),
    self: { inCensus: true, operator: 'hop0', operatorNodes: 1, free: true, bondSats: '1000000' } }, why: r.why });
  assert.match(r.why, /beacon after 300/, 'why its last tick started none');
  g.inSetup = false; g.running = true;
  assert.equal((await s.readiness(2000)).guardian, 'setup', 'asked at most every 30 s');
  assert.equal((await s.readiness(40000)).guardian, 'running');
  g.running = false;
  assert.equal((await s.readiness(80000)).guardian, 'none');
});

test('guardingWhy: the nodes of an operator that name a federation held OPEN or not held at all; a CLOSED or overloaded one frees them (kanban #585)', () => {
  const a = key('w0'), b = key('w1');
  const fid = (x) => Uint8Array.from(Buffer.from(x.repeat(32), 'hex'));
  const entries = [{ pubkey: a.pub, advert: { operatorId: 'opX', guardianOf: [{ federationId: fid('aa') }, { federationId: fid('cc') }] } },
    { pubkey: b.pub, advert: { operatorId: 'opX', guardianOf: [{ federationId: fid('bb') }, { federationId: fid('dd') }] } }];
  const held = [{ federation: 'aa'.repeat(32), status: 'CLOSED' }, { federation: 'bb'.repeat(32), status: 'OPEN', load: 0.3 }, { federation: 'dd'.repeat(32), status: 'OPEN', load: 4.3 }];
  assert.deepEqual(guardingWhy({ entries, held, op: 'opX' }), [{ node: toHex(a.pub), federation: 'cc'.repeat(32), status: 'not held' }, { node: toHex(b.pub), federation: 'bb'.repeat(32), status: 'OPEN' },
    { node: toHex(b.pub), federation: 'dd'.repeat(32), status: 'overloaded, no free slot' }], 'an overloaded federation holds back a node with no free slot (kanban #599)');
  const slot = entries.map((e) => ({ ...e, advert: { ...e.advert, foundingSlot: true } }));
  assert.equal(guardingWhy({ entries: slot, held, op: 'opX' }).some((x) => x.federation === 'dd'.repeat(32)), false, 'with a free slot it is freed');
  assert.deepEqual(guardingWhy({ entries, held, op: 'other' }), []);
});

test('records that arrive within a block count on the next tick of that block: a CLOSED federation frees its guardians at once (kanban #585, 7 instead of 20 at 157,300)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`k${i}`));
  const closed = Uint8Array.from(Buffer.from('89'.repeat(32), 'hex'));
  // eight of the twelve guarded a federation now CLOSED; the others guard none
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/ktx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `kop${i}`, guardianCapable: true, guardianEndpoint: `wss://k${i}`, guardianOf: i < 8 ? [{ federationId: closed }] : [] } }));
  const held = [];
  const s = createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? cEntries : []),
    beaconAt: async () => null, tip: async () => 300, guardianInSetup: async () => true,
    setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, done: async () => false },
    nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[0].pub, sign: (h) => schnorr.sign(h, all[0].secret), verify });
  await s.tick();
  assert.equal((await s.readiness(0)).cohort.free, 4, 'no record held yet: the federation the adverts name counts as OPEN');
  held.push({ federation: '89'.repeat(32), status: 'CLOSED', height: 290 }, { federation: 'aa'.repeat(32), status: 'OPEN', height: 290 });
  await s.tick();
  assert.equal((await s.readiness(60000)).cohort.free, 12, 'the CLOSED record arrived within block 300: its guardians are free at once');
});

test('members: every node that can be drawn, asked at its address - ready, founding off, an older release, no answer (kanban #585)', async () => {
  const all = Array.from({ length: 4 }, (_, i) => key(`m${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/mtx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `mop${i}`, guardianCapable: true, guardianEndpoint: `wss://m${i}/guardian`, endpoint: `wss://m${i}` } }));
  const answers = { 'https://m1': { ready: { guardian: 'setup' } }, 'https://m2': { off: true }, 'https://m3': null };
  const asked = [];
  const s = createFoundingSeat({ records: () => [], entriesAt: async (h) => (h >= 300 ? cEntries : []), beaconAt: async () => null, tip: async () => 300,
    guardianInSetup: async () => true, setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, done: async () => false },
    nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[0].pub, sign: (h) => schnorr.sign(h, all[0].secret), verify,
    endpointOf: (e) => e.advert.endpoint,
    fetchJson: async (u) => { asked.push(u); const root = u.replace(/\/founding$/, ''); if (root === 'https://m3') throw new Error('timeout'); return answers[root]; } });
  await s.tick();
  const m = await s.members(1000, { wait: true });
  assert.deepEqual(m.nodes.map((x) => x.state), ['setup', 'setup', 'off', 'no answer'], 'itself, ready, founding off, no answer');
  assert.deepEqual([m.free, m.needed, m.nodes.length], [4, 10, 4]);
  assert.deepEqual(asked, ['https://m1/founding', 'https://m2/founding', 'https://m3/founding'], 'each other node at its own address, http(s) for ws(s)');
  await s.members(30000);
  assert.equal(asked.length, 3, 'asked at most every 60 s');
});

test('a seat that first ticks long after the run of free operators began reads back only two steps, and draws the same height as a seat that saw the run (kanban #577: 15 min+ after a restart)', async () => {
  const all = Array.from({ length: 12 }, (_, i) => key(`l${i}`));
  const cEntries = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash('TEST/ltx', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `lop${i}`, guardianCapable: true, guardianEndpoint: `wss://l${i}`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 100 }];
  const make = (w, reads) => createFoundingSeat({ records: () => held, entriesAt: async (h) => { reads.push(h); return h >= 150 ? cEntries : []; },
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => true, setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, done: async () => false },
    nominal: 4, bondMinGuardian: 500000n, clocks: { abandonBlocks: 10, foundingWindow: 5 }, ownKey: all[0].pub, sign: (h) => schnorr.sign(h, all[0].secret), verify });
  // A ticks at every height from 150, B first at 301
  const wa = { tip: 150 }, ra = [], a = make(wa, ra);
  for (; wa.tip <= 301; wa.tip++) await a.tick();
  wa.tip = 301;
  const wb = { tip: 301 }, rb = [], b = make(wb, rb);
  await b.tick();
  assert.equal(b.state().trigger.height, a.state().trigger.height, 'the same draw height');
  assert.equal(b.state().id, a.state().id, 'and the same founding');
  assert.ok(rb.length <= 2 * 6 + 3, `B read ${rb.length} heights, not 288`);
});

// UNDER CAPACITY PRESSURE (§23A.3a, kanban #993): the seat asks pressureBondAt once for the draw and hands it on, to the probe too
function pressureSeat({ ents = entries, own = 0, pressureBondAt, setup: extra = {}, inSetup = true } = {}) {
  const w = { tip: 201 }, recs = [{ federation: 'aa'.repeat(32), status: 'DRAINING', height: 200 }];
  const setup = { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, ...extra };
  return createFoundingSeat({ records: () => recs, entriesAt: async (h) => (h === 200 ? ents : null), beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null),
    tip: async () => w.tip, guardianInSetup: async () => inSetup, setup, nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: ents[own].pubkey, sign: () => new Uint8Array(64), verify, ...(pressureBondAt ? { pressureBondAt } : {}) });
}
const seatedOfState = (s) => s.state().seated.map((x) => x.node);

test('capacity pressure: the seat reads B*_net at the trigger height and the census there; no reader, or one that answers null, is the plain draw', async () => {
  const bonded = entries.map((e, i) => ({ ...e, bondSats: i === 5 ? 2000000n : 1000000n }));
  const plain = pressureSeat({ ents: bonded }); await plain.tick();
  const nulled = pressureSeat({ ents: bonded, pressureBondAt: async () => null }); await nulled.tick();
  assert.deepEqual(seatedOfState(nulled), seatedOfState(plain));
  const asked = [];
  const under = pressureSeat({ ents: bonded, pressureBondAt: async ({ height, entries: e }) => { asked.push([height, e.length]); return 2000000n; } });
  const r = await under.tick();
  assert.equal(r.ok, true, r.why);
  assert.deepEqual(asked, [[200, 6]]);
  assert.equal(seatedOfState(under)[0], toHex(bonded[5].pubkey), 'the operator at B*_net sits first');
  const other = pressureSeat({ ents: bonded, own: 3, pressureBondAt: async () => 2000000n }); await other.tick();
  assert.deepEqual(seatedOfState(other), seatedOfState(under), 'the same value on two seats, the same seats');
});

test('capacity pressure: a reader that fails starts no founding, it does not fall back to the plain draw', async () => {
  const seat = pressureSeat({ pressureBondAt: async () => { throw new Error('no record at that height'); } });
  const r = await seat.tick();
  assert.equal(r.ok, false); assert.match(r.why, /capacity pressure at 200 could not be read: no record at that height/);
  assert.equal(seat.state(), null);
});

test('capacity pressure reaches the probe: a node named only under pressure starts its guardian again in a fresh setup', async () => {
  const many = Array.from({ length: 12 }, (_, i) => { const k = key(`p${i}`); return { pubkey: k.pub, txid: taggedHash('TEST/tx-p', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `pop${i}`, guardianCapable: true, guardianEndpoint: `wss://p${i}` } }; });
  const seed = taggedHash('TEST/block', Uint8Array.of(201));
  // a node left out of the plain draw, with the bond it needs for the pressure rule to name it
  const raised = (own) => many.map((e, i) => (i === own ? { ...e, bondSats: 2000000n } : e));
  const own = many.findIndex((e, i) => { const d = drawGuardians({ entries: raised(i), seed, height: 200, nominal: 4, bondMinGuardian: 500000n });
    return ![...d.drawn, ...d.alternates].some((x) => toHex(x.pubkey) === toHex(e.pubkey)); });
  assert.ok(own >= 0, 'such a node exists in this fixture');
  const tried = (extra) => { const log = []; return [pressureSeat({ ents: raised(own), own, inSetup: false, setup: { status: async () => 'down', freshSetup: async () => { log.push('fresh'); return { ok: false, why: 'test' }; } }, ...extra }), log]; };
  const [plain, none] = tried({}); await plain.tick();
  assert.deepEqual(none, [], 'not named in the plain draw: its guardian is left alone');
  const [under, log] = tried({ pressureBondAt: async () => 2000000n }); await under.tick();
  assert.deepEqual(log, ['fresh'], 'named under pressure');
});

test('from the point the count holds to the version too: a cohort does not trigger on nodes it cannot draw (ruling #1023)', async () => {
  const many = Array.from({ length: 11 }, (_, i) => { const k = key(`v${i}`); return { pubkey: k.pub, txid: taggedHash('TEST/tx-v', Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `vop${i}`, guardianCapable: true, guardianEndpoint: `wss://v${i}`, protocolVersions: i < 9 ? [24] : [23], guardianOf: [] } }; });
  const asOf = (candidateVersionAt) => { const w = { tip: 300 };
    return createFoundingSeat({ records: () => [{ federation: 'aa'.repeat(32), status: 'OPEN', height: 100 }], entriesAt: async () => many, beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null),
      tip: async () => w.tip, guardianInSetup: async () => true, setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null }, nominal: 4, bondMinGuardian: 500000n,
      clocks: { abandonBlocks: 1000, foundingWindow: 5 }, ownKey: many[0].pubkey, sign: () => new Uint8Array(64), verify, ...(candidateVersionAt ? { candidateVersionAt } : {}) }); };
  const before = asOf(null); const a = await before.tick();
  assert.equal(a.ok, true, a.why); assert.equal(a.trigger.kind, 'cohort');
  const after = asOf(() => 24); const b = await after.tick();
  assert.equal(b.ok, false, 'nine that speak it are not ten');
});

// VOID, NOT STUCK (kanban #1025): from the point a succession redraws by the chain, a run founding is kept, and a named successor ends it
function redrawSeat({ w, recs, setup = {}, reader = null, fetchJson = null, peers = null }) {
  const made = [];
  const s = createFoundingSeat({ records: () => recs(), entriesAt: async (h) => { made.push(h); return entries; }, beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => true, setup: { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null, ...setup }, nominal: 4, bondMinGuardian: 500000n,
    clocks: { abandonBlocks: 10, foundingWindow: 5 }, ownKey: keys[0].pub, sign: () => new Uint8Array(64), verify, redrawFrom: 0, ...(reader ? { pressureBondAt: reader } : {}),
    // each node's seat at its guardian endpoint's host (https://g<i>), as a census advert names it
    endpointOf: (e) => String(e.advert.guardianEndpoint).replace(/^wss:/, 'https:'),
    ...(fetchJson ? { fetchJson, peers: peers || (() => ['https://peer']) } : {}) });
  return s;
}
const drainingAt = (height, extra = {}) => [{ federation: 'aa'.repeat(32), status: 'DRAINING', height, ...extra }];

test('a void succession is drawn again on its own beacon, not held for ever; two seats at one tip name the same founding', async () => {
  const w = { tip: 201 };
  const a = redrawSeat({ w, recs: () => drainingAt(200) }), b = redrawSeat({ w, recs: () => drainingAt(200) });
  await a.tick();
  const first = a.state();
  assert.equal(first.void, false);
  w.tip = 206;                            // the window (beacon 201 + 5) has passed
  await a.tick();
  assert.equal(a.state().void, true, 'the first draw went void');
  w.tip = 207;
  const r = await a.tick();
  assert.equal(r.ok, true, r.why);
  assert.equal(r.trigger.height, 206); assert.equal(r.trigger.firstDraw, false);
  assert.notEqual(a.state().id, first.id, 'its own beacon');
  await b.tick();                         // b comes up late and never saw the first draw
  assert.equal(b.state().id, a.state().id, 'the same draw from the chain alone');
});

test('a draw that started nothing by its height + founding_window is void and holds nothing back', async () => {
  const w = { tip: 205 };
  const s = redrawSeat({ w, recs: () => drainingAt(200) });
  const r = await s.tick();
  assert.equal(r.ok, false); assert.match(r.why, /no founding started by 205 for the draw at 200: void, drawn again at 206/);
  assert.equal(s.state(), null);
  w.tip = 207;
  assert.equal((await s.tick()).trigger.height, 206);
});

test('a founding that runs is not drawn over at its trigger\'s next height, and a record naming the successor ends the trigger', async () => {
  const w = { tip: 201 }; let recs = drainingAt(200), s = null;
  // a threshold of the seated nodes' own seats say it runs (kanban #1161)
  s = redrawSeat({ w, recs: () => recs, fetchJson: async () => ({ id: s.state().id, codes: [], federation: true }), peers: () => entries.map((e) => String(e.advert.guardianEndpoint).replace(/^wss:/, 'https:')) });
  await s.tick();
  const id = s.state().id;
  assert.equal(s.state().federation, true, 'the seated say it runs');
  w.tip = 208;
  await s.tick();
  assert.equal(s.state().id, id, 'kept: no redraw over a federation that runs');
  recs = drainingAt(204, { record: { nominal: 4, guardians: [], gone: [], successorId: new Uint8Array(32).fill(7) } });
  const after = await s.tick();
  assert.equal(after.ok, false, 'the successor is named: the condition is over');
});

test('a made-up federation in an advert stops no founding from the point on', async () => {
  const w = { tip: 201 };
  const s = redrawSeat({ w, recs: () => drainingAt(200), reader: async () => null });
  const r = await s.tick();
  assert.equal(r.ok, true, r.why);
});

// KANBAN #1161: ONE PEER SAYING federation: true HOLDS NO TRIGGER. Before, a seat took any peer's GET /founding `federation: true`, kept the
// trigger over every redraw and never voided the founding: one lying node froze the succession.
test('#1161 one peer, or one drawn node, saying the federation runs does not hold the trigger: the draw voids and is drawn again', async () => {
  const run = async (peers, nodeOf = () => undefined) => {
    const w = { tip: 201 }; const recs = drainingAt(200); let s = null;
    // only the roots named say it runs; every other drawn node's seat (asked too, at its census endpoint) says it does not
    s = redrawSeat({ w, recs: () => recs, peers: () => peers, fetchJson: async (u) => ({ id: s.state().id, codes: [], federation: peers.includes(u.replace(/\/founding$/, '')), node: nodeOf(u) }) });
    await s.tick();
    const id = s.state().id, at201 = s.state().federation;
    w.tip = 206; await s.tick();
    w.tip = 208; const r = await s.tick();
    return { at201, voided: s.state().void || s.state().id !== id, redrawn: r.ok && r.trigger.height !== 200 };
  };
  const seatedRoots = (n) => entries.map((e) => String(e.advert.guardianEndpoint).replace(/^wss:/, 'https:')).slice(0, n);
  const peer = await run(['https://peer']);
  const one = await run(seatedRoots(1));
  const lying = await run(seatedRoots(6), () => toHex(keys[5].pub));
  const all = await run(seatedRoots(6));
  console.log(`#1161 measure: "federation: true" from one non-drawn peer -> runs ${peer.at201}, redrawn ${peer.redrawn}; from one drawn node -> runs ${one.at201}, redrawn ${one.redrawn}; every root answering in one node's name -> runs ${lying.at201}; from the seated nodes' own seats -> runs ${all.at201}, redrawn ${all.redrawn}`);
  assert.deepEqual([peer.at201, peer.redrawn], [false, true]);
  assert.deepEqual([one.at201, one.redrawn], [false, true]);
  assert.equal(lying.at201, false, 'a root answering in another node\'s name counts nothing');
  assert.deepEqual([all.at201, all.redrawn], [true, false]);
});

// KANBAN #1177: NO DESTRUCTIVE STEP ON AN UNKNOWN READING. A node that started in setup and finished its DKG in the same process, named in a new
// draw while its setup API timed out once, was read "not running" and its live guardian's database was set aside for a fresh setup.
function freshWorld(tag) {
  const all = Array.from({ length: 12 }, (_, i) => key(`${tag}${i}`));
  const ents = all.map((k, i) => ({ pubkey: k.pub, txid: taggedHash(`TEST/${tag}tx`, Uint8Array.of(i)), vout: 0, bondSats: 1000000n,
    advert: { operatorId: `${tag}op${i}`, guardianCapable: true, guardianEndpoint: `wss://${tag}${i}`, guardianOf: [] } }));
  const held = [{ federation: 'bb'.repeat(32), status: 'OPEN', height: 300 }];
  const w = { tip: 300 };
  const make = (i, setup, extra = {}) => createFoundingSeat({ records: () => held, entriesAt: async (h) => (h >= 300 ? ents : []),
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => setup.inSetup(), setup, nominal: 4, bondMinGuardian: 500000n, clocks: cClocks, ownKey: all[i].pub,
    sign: (h) => schnorr.sign(h, all[i].secret), verify, ...extra });
  return { all, w, make };
}
// the real CLI setup over a fedimint-cli that times out, and the node's own word on its guardian
function timingOut(g) {
  return cliSetup({ run: async (args) => { if (g.answer) return `"${g.answer}"`; throw Object.assign(new Error(`fedimint-cli ${args.slice(-1)}: timed out`), { killed: true }); },
    apiPort: 1, password: 'p', guardianName: 'n', local: async () => ({ keyed: g.keyed, alive: g.alive }),
    freshSetup: async () => { g.fresh++; g.answer = 'AwaitingLocalParams'; return { ok: true, kept: 'database.void-x' }; } });
}
async function namedNode(tag) {
  const x = freshWorld(tag);
  const probe = x.make(0, { inSetup: async () => true, localParams: async () => 'c', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null });
  await probe.tick(); x.w.tip = 301; await probe.tick();
  const i = x.all.findIndex((k) => toHex(k.pub) === probe.state().seated[0].node);
  x.w.tip = 300;
  return { ...x, i };
}

test('#1177 a live guardian (key files held) whose setup API times out is never set aside, however often it is drawn', async () => {
  const { w, make, i } = await namedNode('k');
  const g = { keyed: true, alive: true, fresh: 0, answer: null };
  const s = make(i, timingOut(g));
  await s.tick(); w.tip = 301; await s.tick(); await s.tick();
  console.log(`#1177 keyed guardian, setup API timing out, named in a new draw: fresh setups started = ${g.fresh}`);
  assert.equal(g.fresh, 0, 'its database stays where it is');
  assert.equal(await timingOut(g).status(), seatMod.GUARDIAN?.RUNNING ?? 'running');
});

test('#1177 a timeout with the guardian alive is UNKNOWN: nothing is set aside; once its node verifies it gone it starts again, once, kept across a restart', async () => {
  const { w, make, i } = await namedNode('u');
  const g = { keyed: false, alive: true, fresh: 0, answer: null };
  const dir = mkdtempSync(join(tmpdir(), 'fresh-tried-'));
  const store = () => (seatMod.fileKeySet ? seatMod.fileKeySet(join(dir, 'fresh-tried.json')) : undefined);
  const s = make(i, timingOut(g), { freshTried: store() });
  await s.tick(); w.tip = 301; await s.tick(); await s.tick();
  console.log(`#1177 no key files, process alive, setup API timing out: fresh setups started = ${g.fresh}`);
  assert.equal(g.fresh, 0, 'an unknown reading moves nothing');
  // its node verifies the process gone: DOWN - started again in a fresh setup, and it takes part
  g.alive = false;
  await s.tick();
  assert.equal(g.fresh, 1, 'a verified DOWN starts it again');
  assert.equal(s.state().via, 'guardian', 'and it takes part');
  // the seat restarts: the founding is kept as tried, the guardian is not set aside again
  g.answer = null; g.alive = false;
  w.tip = 300;
  const again = make(i, timingOut(g), { freshTried: store() });
  await again.tick(); w.tip = 301; await again.tick(); await again.tick();
  assert.equal(g.fresh, 1, 'not twice for one founding, across a restart');
});

test('#1177 freshSetupStep: only a verified DOWN of a named node not yet tried', () => {
  const { freshSetupStep, GUARDIAN } = seatMod;
  const acts = [[true, GUARDIAN.DOWN, false], [true, GUARDIAN.UNKNOWN, false], [true, GUARDIAN.RUNNING, false], [true, GUARDIAN.SETUP, false], [false, GUARDIAN.DOWN, false], [true, GUARDIAN.DOWN, true]]
    .map(([named, reading, tried]) => freshSetupStep({ named, reading, tried }).act);
  assert.deepEqual(acts, ['fresh', 'wait', 'leave', 'leave', 'leave', 'leave']);
});

test('#1177 cliSetup.status: three answers from the API, DOWN only on the node\'s own word, key files are RUNNING', async () => {
  const said = (out, l) => cliSetup({ run: async () => { if (out instanceof Error) throw out; return `"${out}"`; }, apiPort: 1, password: 'p', guardianName: 'n', local: l ? async () => l : null });
  assert.equal(await said('ConsensusIsRunning').status(), 'running');
  assert.equal(await said('SharingConnectionCodes').status(), 'setup');
  assert.equal(await said(new Error('timed out')).status(), 'unknown', 'no answer, no word from the node');
  assert.equal(await said(new Error('timed out'), { keyed: false, alive: true }).status(), 'unknown', 'no answer, the process alive');
  assert.equal(await said(new Error('connection refused'), { keyed: false, alive: false }).status(), 'down');
  assert.equal(await said(new Error('connection refused'), { keyed: true, alive: false }).status(), 'running', 'key files held: never down');
  assert.equal(await said('AwaitingLocalParams', { keyed: true, alive: true }).status(), 'running');
});
