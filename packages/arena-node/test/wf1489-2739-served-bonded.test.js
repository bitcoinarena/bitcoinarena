// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 round 6 (gossip): #1896 ("committee nodes only") filters the served list on the BUYER'S PAGE only. arena-client item-buy.js
// servedFromSeats merges the seats' GET /served?finals=1 answers with mergeServedRounds(held, { own: false, bonded }), so a round whose
// committee names a key no checked census bonds is dropped there. The seat that checks the purchase (server.js POST /item-purchase, and the
// funding signal's servedRoundsBetween) still merges with mergeServedRounds(held) - bonded null, "reads as before" - and keeps it.
// ONE seat of the network answers /served with one invented round: a committee of one key it made up and that key's valid FINAL inside the
// window. The page leaves it out, every honest seat counts it: the page's served root and the seat's differ, purchaseStands refuses the
// record ("the purchase paid the served list X, and the one read here is Y") at every seat that reads the lying seat - AFTER the buyer's
// federation payment went out (item-buy.js pays, then hands the record). Every item purchase of the window is paid and never kept, and a
// retry names the same window, so it is refused again. Safe behaviour: the seat that checks a purchase rebuilds the served list the page
// built - one seat's invented committee changes neither, so their roots agree.
// The seat side below is server.js's own expression at POST /item-purchase (its own record first, then each seat's answer as it maps it).
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signFinalSig } from '../../arena-protocol/src/final-sig.js';
import { servedNodes, mergeServedRounds, SERVED_WINDOW_MS } from '../../arena-protocol/src/served-nodes.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { servedFromSeats } from '../../arena-client/src/item-buy.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const verify = (sg, m, k) => { try { return schnorr.verify(sg, m, k); } catch { return false; } };

test('one seat\'s invented round of a made-up key does not make the seats\' served root differ from the buyer page\'s', async () => {
  const toMs = Date.now() - 60000, fromMs = toMs - SERVED_WINDOW_MS;
  const secrets = [b32(0x41), b32(0x42), b32(0x43)];
  const committee = secrets.map((s) => schnorr.getPublicKey(s));
  const bondedKeys = committee.map(toHex);                 // the census the page checked: the three honest seats
  const final = (secret, rid) => signFinalSig({ roundId: rid, entryId: b32(2), runId: b32(3), signerPubkey: schnorr.getPublicKey(secret),
    signedAtMs: BigInt(toMs - 3600000) }, (d) => schnorr.sign(d, secret));
  const honestRound = b32(1);
  const honestHeld = [{ roundId: honestRound, committee, finals: secrets.map((s) => final(s, honestRound)) }];
  // the lying seat: the honest round as every seat holds it, plus one invented round whose committee is one key it made up and signed for
  const madeUp = b32(0x77), madeUpKey = schnorr.getPublicKey(madeUp), invented = b32(0x99);
  const evilHeld = [...honestHeld, { roundId: invented, committee: [madeUpKey], finals: [final(madeUp, invented)] }];
  const wire = (held) => ({ held: held.map((r) => ({ roundId: toHex(r.roundId), committee: r.committee.map(toHex), finals: r.finals.map(toHex), contract: 'cc' })) });   // kanban #3867: with the round's contract, to draw it
  const answers = { 'https://honest.example': wire(honestHeld), 'https://evil.example': wire(evilHeld) };
  const fetch = async (url) => {
    const base = Object.keys(answers).find((b) => String(url).startsWith(b + '/served'));
    return base ? new Response(JSON.stringify(answers[base]), { headers: { 'content-type': 'application/json' } }) : new Response('no', { status: 404 });
  };
  // THE BUYER'S PAGE (item-buy.js): what the purchase names and pays
  // kanban #3867: page and seat both credit only the census draw - here the three honest seats, threshold 2
  const DRAW = { keys: new Set(bondedKeys), threshold: 2 };
  const page = await servedFromSeats({ seats: Object.keys(answers), toMs, fetch, verify, bondedKeys, drawnOf: async () => DRAW });
  assert.ok(page.ok, page.why);
  assert.ok(!page.served.nodes.some((n) => n.key === toHex(madeUpKey)), 'the page leaves the made-up key out (#1896)');
  // AN HONEST SEAT AT POST /item-purchase (server.js): its own record first, then every other seat's answer, merged as it merges them
  const parse = (a) => (a.held || []).map((x) => ({ roundId: fromHex(x.roundId), committee: x.committee.map(fromHex), finals: x.finals.map(fromHex), contract: fromHex(x.contract) }));
  const held = [honestHeld.map((r) => ({ ...r, contract: fromHex('cc') })), parse(answers['https://evil.example'])];
  // kanban #2739: the seat now merges with the node keys of the census of its newest round as `bonded` (server.js bondedNodeKeys) - here
  // the same three honest seats the page checked - at both merges (POST /item-purchase and the funding signal's servedRoundsBetween)
  const src = readFileSync(new URL('../src/server.js', import.meta.url), 'utf8');
  // kanban #3147: the funding signal's merge also passes the drawn committees (drawn: drawnOfServed); bonded stays at both merges
  // kanban #2912: the purchase merge runs through mergedBy (its own census first, then its recent rounds' censuses for the record's root)
  assert.equal((src.match(/mergeServedRounds\(held\.filter\(Boolean\), \{ bonded: bondedNodeKeys\(\)(, drawn: drawnOfServed)? \}\)|mergedBy\(bondedNodeKeys\(\)\)/g) || []).length, 2, 'both seat merges pass the census node keys as bonded');
  assert.match(src, /const mergedBy = \(bonded(, drawn = drawnOfServed)?\) => servedNodes\(\{ rounds: mergeServedRounds\(heldIn, \{ bonded(, drawn)? \}\)/, 'the purchase merge filters by a census (#2912)');
  const seat = servedNodes({ rounds: mergeServedRounds(held.filter(Boolean), { bonded: new Set(bondedKeys), drawn: () => DRAW }).rounds, fromMs, toMs, verify });
  console.log(`  page root ${page.served.root.slice(0, 16)} (${page.served.nodes.length} nodes), seat root ${seat.root.slice(0, 16)} (${seat.nodes.length} nodes: ${seat.nodes.map((n) => n.key.slice(0, 8)).join(' ')})`);
  assert.ok(!seat.nodes.some((n) => n.key === toHex(madeUpKey)), 'the seat counts a key no census bonds, named by one seat alone, as a served node');
  assert.equal(seat.root, page.served.root, 'the seat rebuilds another served root than the page paid: every paid purchase is refused');
});
