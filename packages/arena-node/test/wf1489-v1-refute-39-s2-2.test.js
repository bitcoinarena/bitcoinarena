// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 / #1533 refute, skeptic 2 (the resume path: announcements stopped from the owner page): a seat that starts its
// announcements at boot never makes the pull timer (`if (!announceTimer && ...)` at serve time). When the owner stops them, nothing
// reads the census for addresses again: addressCensus stays the one read last, for good. A node bonded after that - an honest census
// node - is refused (409 "not a node of this seat's census") at POST /address-announcement until the seat restarts, so the seat dials
// its stale census endpoint; before #1533 the push was taken. And a key that left the census is still taken.
process.env.ARENA_ADDRESS_ANNOUNCE_MS = '150';
const { test } = await import('node:test');
const assert = (await import('node:assert/strict')).default;
const { randomBytes } = await import('node:crypto');
const { schnorr } = await import('@noble/curves/secp256k1.js');
const { signAddressAnnouncement } = await import('../../arena-protocol/src/address-announcement.js');
const { ownerSecretFromSeed, signOwnerRequest } = await import('../src/owner.js');
const { toHex } = await import('../../arena-protocol/src/hash.js');
const { serve } = await import('../src/server.js');
const { openStore } = await import('../src/store.js');

const secret = ownerSecretFromSeed(new Uint8Array(32).fill(9));
const ownerRec = { pubkey: toHex(schnorr.getPublicKey(secret)), claimedAtMs: 1 };
const store = { read: () => ownerRec, write: (o) => Object.assign(ownerRec, o), writeCode: () => {} };
const keyPair = () => { const s = new Uint8Array(randomBytes(32)); return { s, pub: schnorr.getPublicKey(s), hex: Buffer.from(schnorr.getPublicKey(s)).toString('hex') }; };
const entry = (k) => ({ pubkey: k.pub, advert: { endpoint: 'http://127.0.0.1:9', timestamp: 0 } });

test('after the owner stops announcements, a node bonded later is still taken (the census for addresses is read again)', async () => {
  const a = keyPair(), b = keyPair(), late = keyPair();
  let census = [entry(a), entry(b)];
  let reads = 0;
  const ballot = { censusEntriesAt: async () => { reads++; return census; } };
  const seat = await serve(openStore(':memory:'), { port: 0, owner: { store }, publicEndpoint: 'ws://127.0.0.1:9/', chain: 'bitcoin-regtest', chainTip: async () => 300, ballot });
  const base = `http://127.0.0.1:${seat.port}`;
  try {
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const ask = async (action, args) => (await fetch(`${base}/owner/service`, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(signOwnerRequest({ node, action, args, secret, sign: (m, x) => schnorr.sign(m, x), pubkeyOf: (x) => schnorr.getPublicKey(x) })) })).json();
    await new Promise((r) => setTimeout(r, 6000));   // the first announce (5 s) and a few 150 ms ticks: the census is read
    const readsBefore = reads;
    const stop = await ask('service', { id: 'announcements', action: 'stop' });
    assert.equal(stop.running, false);
    census = [entry(a), entry(late)];             // `late` bonds, `b` leaves
    await new Promise((r) => setTimeout(r, 3000));
    const post = async (k, i) => {
      const x = signAddressAnnouncement({ node: k.hex, endpoint: `https://moved${i}.example`, atMs: Date.now() - 100 }, (d) => schnorr.sign(d, k.s));
      const r = await fetch(`${base}/address-announcement`, { method: 'POST', body: JSON.stringify(x) }); await r.text(); return r.status;
    };
    const lateStatus = await post(late, 1), goneStatus = await post(b, 2);
    console.log(`census reads before the stop ${readsBefore}, after ${reads - readsBefore}; the node bonded later: ${lateStatus}; the node that left: ${goneStatus}`);
    assert.equal(lateStatus, 200, `an honest census node bonded after the stop refused with ${lateStatus}`);
    assert.equal(goneStatus, 409, `a node no longer in the census taken with ${goneStatus}`);
  } finally { await seat.close(); }
});
