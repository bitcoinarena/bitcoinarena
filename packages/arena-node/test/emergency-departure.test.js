// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OWNER'S EMERGENCY LEAVE REQUEST AT A SEAT (spec §23A.5a, protocol 17): kept once signed by the key it names, the earliest one
// per node, across a restart; and a guardian's request starts its federation's succession at once, as a departure notice does.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createAbsences, emergencyHex, readEmergencyHex } from '../src/absences.js';
import { emergencyTriggers } from '../src/founding-seat.js';
import { emergencyCodeBytes, emergencySecret, signEmergencyDeparture } from '../../arena-protocol/src/emergency.js';
import { buildFederationRecord } from '../../arena-protocol/src/federation-record.js';
import { taggedHash, toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const secret = emergencySecret(emergencyCodeBytes(new Uint8Array(32).fill(0x51)));
const pub = schnorr.getPublicKey(secret);
const node = schnorr.getPublicKey(new Uint8Array(32).fill(0x33));
const request = (postedAt, key = secret) => signEmergencyDeparture({ nodePubkey: node, emergencyPubkey: pub, postedAt }, (m) => schnorr.sign(m, key));

test('a seat keeps the earliest leave request per node, refuses one not signed by the key it names, and reads them back after a restart', () => {
  let saved = null;
  const store = { read: () => saved, write: (v) => { saved = v; } };
  const a = createAbsences({ verify, store });
  assert.deepEqual(a.offerEmergency(request(1000)), { ok: true, kept: true });
  assert.deepEqual(a.offerEmergency(request(1005)), { ok: true, kept: false }, 'a later copy does not move it');
  assert.deepEqual(a.offerEmergency(request(990)), { ok: true, kept: true }, 'an earlier one replaces it');
  assert.match(a.offerEmergency(request(980, new Uint8Array(32).fill(7))).why, /not signed by the emergency key it names/);
  assert.equal(a.emergencyFor(node).postedAt, 990);
  assert.equal(a.emergencyFor(toHex(node)).postedAt, 990, 'by hex too');
  const back = readEmergencyHex(a.listEmergencies()[0]);
  assert.deepEqual([toHex(back.nodePubkey), toHex(back.emergencyPubkey), back.postedAt, toHex(back.signature)], [toHex(node), toHex(pub), 990, toHex(a.emergencyFor(node).signature)]);
  const again = createAbsences({ verify, store });
  assert.equal(again.emergencyFor(node).postedAt, 990, 'kept across a restart');
  assert.equal(emergencyHex(again.emergencyFor(node)), a.listEmergencies()[0]);
});

test('a guardian\'s emergency departure starts the succession at once: four guardians -> CRITICAL, seven -> DRAINING; a node that guards nothing triggers nothing', () => {
  const F = taggedHash('TEST/fed', Uint8Array.of(1));
  const keys = Array.from({ length: 7 }, (_, i) => schnorr.getPublicKey(new Uint8Array(32).fill(i + 1)));
  const record = (n) => buildFederationRecord({ federationId: F, networkId: new Uint8Array(32), invite: 'fed11', nominal: n, height: 480,
    guardians: keys.slice(0, n).map((k, i) => ({ peerKey: Uint8Array.from([2, ...taggedHash('TEST/peer', Uint8Array.of(i))]), nodePubkey: k, operatorId: `op${i}`,
      bondTxid: taggedHash('TEST/tx', Uint8Array.of(i)), bondVout: 0, endpoint: `wss://s${i}/guardian`, bondSats: 1000000n })) });
  const four = emergencyTriggers({ held: [{ federation: toHex(F), status: 'OPEN', record: record(4) }], requests: [{ nodePubkey: keys[2], postedAt: 500 }] });
  assert.deepEqual([four.length, four[0].height, four[0].wouldBe, four[0].departing], [1, 500, 'CRITICAL', [toHex(keys[2])]]);
  assert.equal(four[0].seatedFirst.includes(toHex(keys[2])), false, 'the leaving node is not seated first');
  const seven = emergencyTriggers({ held: [{ federation: toHex(F), status: 'OPEN', record: record(7) }], requests: [{ nodePubkey: keys[6], postedAt: 501 }] });
  assert.deepEqual([seven.length, seven[0].wouldBe], [1, 'DRAINING']);
  assert.equal(emergencyTriggers({ held: [{ federation: toHex(F), status: 'OPEN', record: record(4) }], requests: [{ nodePubkey: node, postedAt: 500 }] }).length, 0, 'not a guardian');
  assert.equal(emergencyTriggers({ held: [{ federation: toHex(F), status: 'CLOSED', record: record(4) }], requests: [{ nodePubkey: keys[2], postedAt: 500 }] }).length, 0, 'a CLOSED federation is not succeeded');
});

test('the page\'s own crypto (owner-client.js, the bundle /Dashboard/emergency loads): the code typed makes a request a seat reads and checks', async () => {
  const C = await import('../pages/owner-client.js');
  const code = C.emergencyCodeText(C.emergencyCodeBytes(new Uint8Array(32).fill(0x51)));
  const typed = code.toLowerCase().replace(/-/g, ' ');
  const s = C.emergencySecret(C.parseEmergencyCode(typed));
  assert.equal(C.toHex(C.pubkeyOf(s)), toHex(pub), 'the code makes the key the installer put in the advert');
  const d = C.signEmergencyDeparture({ nodePubkey: node, emergencyPubkey: C.pubkeyOf(s), postedAt: 157031 }, (m) => C.sign(m, s));
  const back = readEmergencyHex(C.toHex(C.encodeEmergencyDeparture(d)) + C.toHex(d.signature));
  assert.deepEqual(createAbsences({ verify }).offerEmergency(back), { ok: true, kept: true });
});

test('a seat\'s doors: /Dashboard/emergency is served without a login, GET /emergency-departures answers, a request at a seat with no census is refused by why', async () => {
  const { serve } = await import('../src/server.js');
  const { openStore } = await import('../src/store.js');
  const seat = await serve(openStore(), { plugins: [], port: 0 });
  try {
    const S = `http://127.0.0.1:${seat.port}`;
    const page = await fetch(`${S}/Dashboard/emergency`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /My node is offline/);
    const list = await (await fetch(`${S}/emergency-departures?key=${toHex(pub)}`)).json();
    assert.deepEqual([list.requests, list.named], [[], null]);
    assert.equal((await fetch(`${S}/emergency-departure`, { method: 'POST', body: 'zz' })).status, 400);
    const r = await fetch(`${S}/emergency-departure`, { method: 'POST', body: emergencyHex(request(1000)) });
    assert.equal(r.status, 503);
    assert.match(await r.text(), /no census|holds no round/);
  } finally { await seat.close(); }
});
