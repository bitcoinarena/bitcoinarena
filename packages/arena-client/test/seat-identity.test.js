// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONE SEAT, ONE VOTE (kanban #3574): the URLs of one host are one seat unless each proves a distinct node key of the round at
// GET /identity?nonce= - so seven seats behind one public host (/guardian-1 .. /guardian-7) stay seven, and one box under three paths is one.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { seatsOf, seatVoice, identityProofDigest, forgetProofs, noteAdverts, forgetAdverts } from '../src/seat-identity.js';
import { settlementOf } from '../src/page-lock.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const secrets = Array.from({ length: 7 }, (_, i) => b32(0x41 + i));
const keys = secrets.map((s) => toHex(schnorr.getPublicKey(s)));
const verify = (sig, msg, key) => schnorr.verify(sig, msg, key);
const guardians = secrets.map((_, i) => `https://seats.example/guardian-${i + 1}`);
const liar = ['https://liar.example/a', 'https://liar.example/b', 'https://liar.example/c'];

// GET /identity?nonce=: a guardian signs with its own key; `claim` makes a box answer for a key it does not hold (a replayed or made-up sig)
const identity = (url, { claim = null } = {}) => {
  const nonce = fromHex(new URL(url).searchParams.get('nonce'));
  const i = guardians.findIndex((g) => url.startsWith(g + '/'));
  if (i >= 0) return Response.json({ node: keys[i], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[i])) });
  if (claim !== null) return Response.json({ node: keys[claim], sig: toHex(schnorr.sign(identityProofDigest(nonce), b32(0x99))) });
  return new Response('no', { status: 404 });
};
beforeEach(() => forgetProofs());

test('seven seats behind one host that each prove a round key are seven seats', async () => {
  const seats = await seatsOf(guardians, { keys, verify, fetcher: async (u) => identity(u) });
  assert.equal(seats.length, 7);
  assert.deepEqual(seats.map((s) => s.urls), guardians.map((g) => [g]));
  assert.deepEqual(seats.map((s) => s.key), keys);
});

test('one box under three paths that proves nothing is one seat; claiming a round key without its signature does not help', async () => {
  for (const claim of [null, 0]) {
    forgetProofs();
    const seats = await seatsOf([...guardians, ...liar], { keys, verify, fetcher: async (u) => identity(u, { claim }) });
    assert.equal(seats.length, 8, `claim ${claim}`);
    assert.deepEqual(seats[7].urls, liar);
    assert.equal(seats[7].key, null);
  }
});

test('without the round keys a host is one seat; a URL alone on its host is a seat and is not asked who it is', async () => {
  const asked = [];
  const seats = await seatsOf(['https://a.example', 'https://b.example/x', ...guardians], { fetcher: async (u) => { asked.push(u); return identity(u); } });
  assert.deepEqual(seats.map((s) => s.urls.length), [1, 1, 7]);
  assert.deepEqual(asked, []);
});

test('a key the round did not draw does not make a seat of its own', async () => {
  const seats = await seatsOf(guardians, { keys: keys.slice(0, 5), verify, fetcher: async (u) => identity(u) });
  assert.deepEqual(seats.map((s) => s.urls.length), [1, 1, 1, 1, 1, 2]);
  assert.equal(seats[5].key, null);
});

test('a seat whose URLs disagree has no voice', () => {
  const k = (a) => a.k;
  assert.equal(seatVoice([{ k: 'x' }, { k: null }, { k: 'x' }], k).k, 'x');
  assert.equal(seatVoice([{ k: 'x' }, { k: 'y' }], k), null);
  assert.equal(seatVoice([{ k: null }], k), null);
});

test('settlement: the live layout (seven seats on one host) agrees 5 of 7, and three paths of one box do not outvote it', async () => {
  const rid = b32(0x61);
  const settled = (payee) => Response.json({ state: 'ACCEPTED', txid: 'ef'.repeat(32), moved: { payouts: [{ kind: 'qualifier', pk: payee, msat: '978000' }] } });
  const fetcher = async (u) => {
    if (u.includes('/identity')) return identity(u);
    return settled(liar.some((l) => u.startsWith(l)) ? 'bb'.repeat(32) : 'aa'.repeat(32));
  };
  const s = await settlementOf({ roundId: rid, nodes: [...liar, ...guardians.slice(0, 5)], fetcher, needed: 5, keys, verify });
  assert.equal(s.ok, true);
  assert.equal(s.agreeing, 5);
  assert.equal(s.moved.payouts[0].pk, 'aa'.repeat(32));
  // without the proofs the host of the seven seats is one seat, and the box's one seat ties with it - the threshold is never met by URLs
  forgetProofs();
  const t = await settlementOf({ roundId: rid, nodes: [...liar, ...guardians.slice(0, 5)], fetcher, needed: 5 });
  assert.equal(t.needed, 2, 'the threshold is capped by seats, not URLs');
  assert.equal(t.ok, false, 'one seat against one seat agrees on nothing');
});

// A RELAYED PROOF (kanban #3730, audit client-a8-1-1): a box that passes GET /identity?nonce= on to a seat's own door hands back that seat's
// real signature. The proof names no address, so the page believes it only where it meets the seat's own (one key, one seat) and, where the
// round's census adverts are known, only at the address the key's advert names.
const own = ['https://h1.example', 'https://h2.example', 'https://h3.example'];
const relayTo = new Map([[liar[0], 0], [liar[1], 1], [liar[2], 2]]);
const relaying = (u) => {
  const nonce = fromHex(new URL(u).searchParams.get('nonce'));
  const i = own.findIndex((o) => u.startsWith(o + '/'));
  const l = [...relayTo.keys()].find((x) => u.startsWith(x + '/'));
  const at = i >= 0 ? i : l ? relayTo.get(l) : -1;
  if (at < 0) return identity(u);
  return Response.json({ node: keys[at], sig: toHex(schnorr.sign(identityProofDigest(nonce), secrets[at])) });
};
const adverts = new Map(own.map((o, i) => [keys[i], [o]]));
const settledBy = (u) => Response.json({ state: 'ACCEPTED', txid: 'ef'.repeat(32),
  moved: { payouts: [{ kind: 'qualifier', pk: liar.some((l) => u.startsWith(l)) ? 'bb'.repeat(32) : 'aa'.repeat(32), msat: '978000' }] } });

test('a relayed key meets the seat\'s own URL and is one seat with it; a URL alone on its host is asked once any host has several', async () => {
  const asked = [];
  const seats = await seatsOf([own[0], own[1], ...liar], { keys: keys.slice(0, 3), verify, fetcher: async (u) => { asked.push(u.split('/identity')[0]); return relaying(u); } });
  assert.ok(asked.includes(own[0]) && asked.includes(own[1]), 'the seats alone on their hosts are asked too');
  assert.deepEqual(seats.map((s) => s.urls), [[own[0], liar[0]], [own[1], liar[1]], [liar[2]]]);
  // no host with several URLs: nothing is asked, as before
  forgetProofs(); asked.length = 0;
  await seatsOf(own, { keys: keys.slice(0, 3), verify, fetcher: async (u) => { asked.push(u); return relaying(u); } });
  assert.deepEqual(asked, []);
});

test('with the round\'s adverts a relaying path proves nothing: the box is one seat, the seats keep their voices, the winner is paid', async () => {
  const fetcher = async (u) => (u.includes('/identity') ? relaying(u) : settledBy(u));
  // the box relays /a and /b to the two seats the link names
  const nodes = [own[0], own[1], liar[0], liar[1]];
  const s = await settlementOf({ roundId: b32(0x61), nodes, fetcher, needed: 2, keys: keys.slice(0, 3), verify, advertised: adverts });
  assert.equal(s.ok, true);
  assert.equal(s.short, undefined);
  assert.equal(s.moved.payouts[0].pk, 'aa'.repeat(32));
  assert.deepEqual(s.seats, [own[0], own[1]]);
  const seats = await seatsOf(nodes, { keys: keys.slice(0, 3), verify, fetcher, advertised: adverts });
  assert.deepEqual(seats.map((x) => x.urls), [[own[0]], [own[1]], [liar[0], liar[1]]]);
  assert.equal(seats[2].key, null);
  // without the adverts the relayed seats' URLs disagree: no vote is cast for the box, the honest ones stall (no settlement, no "none")
  forgetProofs();
  const t = await settlementOf({ roundId: b32(0x61), nodes, fetcher, needed: 2, keys: keys.slice(0, 3), verify, advertised: null });
  assert.equal(t.ok, false);
});

test('an advert reached through the page\'s alt routes keeps its key; an advert matching none of a key\'s URLs takes it from none', async () => {
  // the live seats advertise one host and the page reaches them at another (window.ARENA_VIA_ALT, daily.json's routes)
  const advertsAt = new Map(own.map((o, i) => [keys[i], [o.replace('.example', '.funnel.example')]]));
  const fetcher = async (u) => (u.includes('/identity') ? relaying(u) : settledBy(u));
  globalThis.ARENA_VIA_ALT = (u) => String(u).replace('.funnel.example', '.example');
  try {
    const seats = await seatsOf([own[0], own[1], ...liar], { keys: keys.slice(0, 3), verify, fetcher, advertised: advertsAt });
    // /c relays the seat the link does not name: nothing it meets tells it apart (the limit seat-identity.js states)
    assert.deepEqual(seats.map((x) => x.urls), [[own[0]], [own[1]], [liar[0], liar[1]], [liar[2]]]);
  } finally { delete globalThis.ARENA_VIA_ALT; }
  // without the route no URL is the advert's: each key stays one seat with all its URLs (stalled where they disagree, never cast by the box)
  forgetProofs();
  const seats = await seatsOf([own[0], own[1], ...liar], { keys: keys.slice(0, 3), verify, fetcher, advertised: advertsAt });
  assert.deepEqual(seats.map((x) => x.urls), [[own[0], liar[0]], [own[1], liar[1]], [liar[2]]]);
  // the seats behind the live layout's one host keep their own keys where their adverts name them (a function works as well as a map)
  forgetProofs();
  const at = (k) => { const i = keys.indexOf(k); return i >= 0 ? [guardians[i]] : null; };
  const g = await seatsOf(guardians, { keys, verify, fetcher: async (u) => identity(u), advertised: at });
  assert.deepEqual(g.map((x) => x.key), keys);
});

test('the adverts of a census the page checked are read by default (noteAdverts)', async () => {
  forgetAdverts();
  noteAdverts(own.map((o, i) => ({ pubkey: fromHex(keys[i]), advert: { endpoint: o.replace('https://', 'wss://') } })));
  try {
    const fetcher = async (u) => (u.includes('/identity') ? relaying(u) : settledBy(u));
    const s = await settlementOf({ roundId: b32(0x61), nodes: [own[0], own[1], liar[0], liar[1]], fetcher, needed: 2, keys: keys.slice(0, 3), verify });
    assert.equal(s.ok, true);
    assert.equal(s.moved.payouts[0].pk, 'aa'.repeat(32));
    forgetProofs();
    const none = await seatsOf([own[0], own[1], ...liar], { keys: keys.slice(0, 3), verify, fetcher, advertised: null });
    assert.equal(none.length, 3, 'advertised: null reads no adverts');
  } finally { forgetAdverts(); }
});
