// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1404 (audit 5 #1399): the store is read back before the seat holds its federation records, so every kept attestation and notice went into
// the 512 bucket for unknown federations and the rest were lost for good at each restart. Now what was kept comes back whole.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { createAbsences } from '../src/absences.js';
import { signAbsence, signDeparture } from '../../arena-protocol/src/absence.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const verify = (s, m, k) => { try { return schnorr.verify(s, m, k); } catch { return false; } };
const key = (n) => { const sk = new Uint8Array(32); sk[0] = (n >> 8) & 255; sk[1] = n & 255; sk[31] = 7; return { sk, pk: schnorr.getPublicKey(sk) }; };
const peer = (n) => Uint8Array.from([2, ...new Uint8Array(32).fill(n)]);
const G = [1, 2, 3, 4, 5].map((n) => ({ ...key(1000 + n), peer: peer(n) }));
const FEDS = Array.from({ length: 30 }, (_, i) => new Uint8Array(32).fill(i + 1));   // 30 federations x 5 guardians x 5 peers = 750 attestations
const RECORD = Object.fromEntries(FEDS.map((f) => [toHex(f), G]));
const memStore = () => { let v = null; return { read: () => v, write: (x) => { v = JSON.parse(JSON.stringify(x)); } }; };
const book = (store, records) => createAbsences({ verify, max: 4096, store,
  nodeOf: (fid, p) => { if (!records.on) return null; const g = (RECORD[fid] || []).find((x) => toHex(x.peer) === p); return g ? toHex(g.pk) : null; },
  guardiansOf: (fid) => (records.on && RECORD[fid] ? RECORD[fid].map((x) => toHex(x.pk)) : null) });
const attest = (signer, federationId, peerKey, h = 900) => signAbsence({ federationId, peerKey, lastSeenHeight: h - 300, height: h, attester: signer.pk }, (m) => schnorr.sign(m, signer.sk));
const notice = (signer, federationId, peerKey, postedAt = 900) => signDeparture({ federationId, peerKey, leaveAfterHeight: postedAt + 432, postedAt, nodePubkey: signer.pk }, (m) => schnorr.sign(m, signer.sk));

test('#1404 a restart before the federation records are back keeps every attestation and notice the seat held', () => {
  const store = memStore();
  const before = book(store, { on: true });
  for (const f of FEDS) for (const g of G) { for (const p of G) assert.equal(before.offer(attest(g, f, p.peer)).ok, true); }
  for (const f of FEDS) for (const g of G) assert.equal(before.offerDeparture(notice(g, f, g.peer)).ok, true);
  const heldBefore = before.list().length, noticesBefore = before.listDepartures().length;
  const records = { on: false };   // server.js restores the records after the store is read
  const after = book(store, records);
  console.log(`  MEASURED #1404: held ${heldBefore} attestations + ${noticesBefore} notices; after a restart with no record yet: ${after.list().length} + ${after.listDepartures().length}`);
  assert.equal(after.list().length, heldBefore, 'attestations were lost at the restart');
  assert.equal(after.listDepartures().length, noticesBefore, 'departure notices were lost at the restart');
  records.on = true;
  const fresh = attest(G[0], FEDS[0], G[1].peer, 950);
  assert.deepEqual(after.offer(fresh), { ok: true, kept: true });
  assert.equal(store.read().absences.length, heldBefore, 'the next save wrote a cut set');
  assert.equal(store.read().departures.length, noticesBefore);
  assert.equal(after.heldDeparture(toHex(FEDS[29]), toHex(G[4].peer), toHex(G[4].pk)), true, 'the leaver\'s own notice was not kept');
  // the unknown bucket still bounds live junk: once loaded, an attestation about a federation no record names goes to the 512 bucket
  const junk = after.offer(attest(key(7777), new Uint8Array(32).fill(0xee), peer(9)));
  assert.equal(junk.ok, true);
});

test('#1404 a forged entry in the store is still refused when read back', () => {
  const store = memStore();
  const a = book(store, { on: true });
  a.offer(attest(G[0], FEDS[0], G[1].peer));
  const saved = store.read();
  const bad = saved.absences[0].slice(0, -2) + (saved.absences[0].slice(-2) === '00' ? '01' : '00');
  store.write({ ...saved, absences: [bad] });
  assert.equal(book(store, { on: false }).list().length, 0);
});
