// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #3800 (RULED 2026-11-26 on the #3730 PR's open point, protocol 34; closes the limit of #3773): a seat's /identity proof is bound to
// the host it was asked at, and the page counts a key's voice for a URL of a round of 34+ only with a proof bound to that URL. A box whose path
// relays GET /identity of a round seat the link does not name proved that seat's key (one extra vote, #3730's stated limit): the relay reaches
// the seat by the seat's own name, so the seat signs its own host, never the box's. Rounds below 34 keep today's rule.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { identityProofDigest, forgetProofs, seatsOf, provenKeyAt } from '../src/seat-identity.js';
import { settlementOf } from '../src/page-lock.js';
import { identityBoundDigest, identityHostKey, bindsIdentity, IDENTITY_BOUND_VERSION } from '../../arena-protocol/src/identity-proof.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = [b32(0x41), b32(0x42), b32(0x43)];
const keys = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const honest = ['https://h1.example', 'https://h2.example', 'https://h3.example'];
const liar = ['https://liar.example/a', 'https://liar.example/b'];

// a seat's own GET /identity?nonce=, as arena-node answers it: the unbound proof and the Host it was asked at, signed
const seatIdentity = (i, nonceHex, host) => {
  const n = fromHex(nonceHex), at = identityHostKey(host);
  return Response.json({ node: keys[i], nonce: nonceHex, sig: toHex(schnorr.sign(identityProofDigest(n), secrets[i])),
    at, atSig: toHex(schnorr.sign(identityBoundDigest(n, at), secrets[i])) });
};
const rid = b32(0x61);
const settled = (payee) => Response.json({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: payee, msat: '978000' }] } });

// the link names h1 and two paths of one box; seat 2 (h3) is a seat of the round the link does not name. /a relays /identity to seat 2 by
// its public name (so the seat sees its own Host), /b proves nothing. The box answers a settlement that leaves the winner out.
const fetcher = async (u) => {
  const url = new URL(u);
  if (url.pathname.endsWith('/identity')) {
    const nonce = url.searchParams.get('nonce');
    const h = honest.findIndex((x) => u.startsWith(x + '/'));
    if (h >= 0) return seatIdentity(h, nonce, url.host);
    if (u.startsWith(liar[0] + '/')) return seatIdentity(2, nonce, new URL(honest[2]).host);
    return new Response('no', { status: 404 });
  }
  return settled(liar.some((l) => u.startsWith(l)) ? 'bb'.repeat(32) : 'aa'.repeat(32));
};
const nodes = [honest[0], ...liar];

beforeEach(() => forgetProofs());
afterEach(() => { delete globalThis.ARENA_VIA_ALT; });

test('#3773 below 34 (today\'s rule): the relaying path proves the seat the link does not name - one extra vote, the box decides', async () => {
  const s = await settlementOf({ roundId: rid, nodes, fetcher, needed: 2, keys, verify, advertised: null });
  assert.equal(s.ok, true);
  assert.equal(s.moved.payouts[0].pk, 'bb'.repeat(32), 'the limit #3730 stated, kept for rounds below 34');
});

test('#3800 from 34: a relayed proof names the seat\'s host, not the box\'s - the box is one seat and does not decide', async () => {
  const s = await settlementOf({ roundId: rid, nodes, fetcher, needed: 2, keys, verify, advertised: null, bound: true });
  assert.notEqual(s.ok && s.moved.payouts[0].pk, 'bb'.repeat(32));
  const seats = await seatsOf(nodes, { keys, verify, fetcher, advertised: null, bound: true });
  assert.deepEqual(seats.map((x) => [x.id, x.urls]), [[`key:${keys[0]}`, [honest[0]]], ['host:liar.example', liar]]);
});

test('#3800 from 34: the live layout - seats on one host, one path each - still proves each seat', async () => {
  const shared = ['https://seats.example/guardian-1', 'https://seats.example/guardian-2', 'https://seats.example/guardian-3'];
  const f = async (u) => {
    const url = new URL(u), i = shared.findIndex((x) => u.startsWith(x + '/'));
    return i >= 0 && url.pathname.endsWith('/identity') ? seatIdentity(i, url.searchParams.get('nonce'), url.host) : new Response('no', { status: 404 });
  };
  const seats = await seatsOf(shared, { keys, verify, fetcher: f, bound: true, advertised: null });
  assert.deepEqual(seats.map((x) => x.key), keys);
});

test('#3800 from 34: a seat reached through the page\'s own alt route proves at the host the route reaches', async () => {
  const named = ['https://adv.example/g1', 'https://adv.example/g2'];
  globalThis.ARENA_VIA_ALT = (u) => String(u).replace('https://adv.example', 'https://alt.example');
  // the page's fetch takes the alt route (index.html routedFetch): the seat sees alt.example
  const f = async (u) => {
    const url = new URL(u), i = named.findIndex((x) => u.startsWith(x + '/'));
    return i >= 0 && url.pathname.endsWith('/identity') ? seatIdentity(i, url.searchParams.get('nonce'), 'alt.example') : new Response('no', { status: 404 });
  };
  const seats = await seatsOf(named, { keys, verify, fetcher: f, bound: true, advertised: null });
  assert.deepEqual(seats.map((x) => x.key), [keys[0], keys[1]]);
});

test('#3800 a bound ask is not answered by an unbound proof: an old seat (no atSig), a wrong host, a kept unbound key', async () => {
  const base = honest[0];
  const old = async (u) => { const n = new URL(u).searchParams.get('nonce'); return Response.json({ node: keys[0], sig: toHex(schnorr.sign(identityProofDigest(fromHex(n)), secrets[0])) }); };
  assert.equal(await provenKeyAt(base, { fetcher: old, verify }), keys[0], 'unbound: as before');
  assert.equal(await provenKeyAt(base, { fetcher: old, verify, bound: true }), null, 'the kept unbound proof does not stand for a bound ask');
  const elsewhere = async (u) => seatIdentity(0, new URL(u).searchParams.get('nonce'), 'h9.example');
  forgetProofs();
  assert.equal(await provenKeyAt(base, { fetcher: elsewhere, verify, bound: true }), null, 'a proof bound to another host');
  const forged = async (u) => { const r = await (await seatIdentity(0, new URL(u).searchParams.get('nonce'), 'h9.example')).json(); return Response.json({ ...r, at: 'h1.example' }); };
  assert.equal(await provenKeyAt(base, { fetcher: forged, verify, bound: true }), null, 'a host renamed after the signature');
  assert.equal(await provenKeyAt(base, { fetcher, verify, bound: true }), keys[0]);
});

test('#3800 bindsIdentity and the host key', () => {
  assert.equal(IDENTITY_BOUND_VERSION, 34);
  assert.deepEqual([bindsIdentity(33), bindsIdentity(34), bindsIdentity(35), bindsIdentity(undefined), bindsIdentity(null)], [false, true, true, false, false]);
  assert.equal(identityHostKey('Seat.Example.:8443'), 'seat.example:8443');
  assert.equal(identityHostKey('seat.example.'), 'seat.example');
  assert.equal(identityHostKey('[::1]:80'), '[::1]:80');
  assert.equal(identityHostKey(new URL('https://H1.example:443/x').host), 'h1.example', 'a default port is not spelled, as a Host header does not');
  assert.throws(() => identityBoundDigest(b32(1).subarray(0, 31), 'h'), /32-byte nonce/);
});
