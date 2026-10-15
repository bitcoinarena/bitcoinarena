// A SEAT'S PART IN A FOUNDING (spec §23A.2, kanban #320): a record entering DRAINING at 200 triggers a succession; every seat reads the
// same beacon (block 201) and census and draws the same four; only nodes whose guardian waits in setup take part; a seat whose post
// was lost picks the codes up from a peer's GET /founding; the CLI setup is called with the guardian's own socket and password.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';
import { createFoundingSeat, cliSetup } from '../src/founding-seat.js';

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

test('whether the guardian waits in setup is asked of the setup API (kanban #320, rehearsal 20b: a setup-mode guardian has no admin status)', async () => {
  const said = (answer) => cliSetup({ run: async (a) => { if (a.includes('status')) { if (answer instanceof Error) throw answer; return `"${answer}"\n`; } return '""'; }, apiPort: 32221, password: 'pw', guardianName: 'n' });
  assert.equal(await said('AwaitingLocalParams').inSetup(), true);
  assert.equal(await said('SharingConnectionCodes').inSetup(), true);
  assert.equal(await said('ConsensusIsRunning').inSetup(), false, 'a running federation: not in setup');
  assert.equal(await said(new Error('Method not found')).inSetup(), false, 'no answer: not taken for setup');
});

// THE GENESIS AND LOAD TRIGGERS, FROM THE HISTORY THE SEAT KEEPS AT EACH TICK (kanban #320)
function triggerSeat({ recs, w }) {
  const setup = { localParams: async () => 'code', addPeer: async () => {}, startDkg: async () => {}, invite: async () => null };
  return createFoundingSeat({ records: () => recs(), entriesAt: async () => entries,
    beaconAt: async (h) => (h <= w.tip ? taggedHash('TEST/block', Uint8Array.of(h & 255)) : null), tip: async () => w.tip,
    guardianInSetup: async () => true, setup, nominal: 4, bondMinGuardian: 500000n, clocks, ownKey: keys[0].pub,
    sign: (h) => schnorr.sign(h, keys[0].secret), verify });
}

test('genesis: no federation and six guardian-capable operators in the census - the first federation is drawn on the block after', async () => {
  const w = { tip: 300 };
  const seat = triggerSeat({ recs: () => [], w });
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

// THE SUCCESSION BY NOTICE (§23A.6, kanban #326): federation F of four (n0..n3, 3 of 4) is OPEN; n3 posts a departure notice at 500 -
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

test('guardingOpenOf: operators whose adverts name a federation held OPEN, other than the one succeeded', () => {
  const held = [{ federation: toHex(F), status: 'OPEN' }, { federation: toHex(G), status: 'OPEN' }];
  assert.deepEqual([...guardingOpenOf({ entries: sEntries, held, except: toHex(F) })], ['decoy']);
  assert.deepEqual([...guardingOpenOf({ entries: sEntries, held: [{ federation: toHex(G), status: 'DRAINING' }], except: null })], [], 'a draining federation does not count');
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
