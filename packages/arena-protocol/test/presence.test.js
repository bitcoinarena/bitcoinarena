// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// ONLY NODES SEEN IN THE LAST 24 H ARE DRAWN (§5A.3, protocol 22, kanban #727). The testnet4 day of 2026-10-27 on the protocol's own
// draw: 28 bonded nodes, 20 of them stopped with their bonds still locked; a round draws 9 and needs 5 present. Before the rule most
// rounds drew too few live nodes to be seated. With it, the nodes drawn in the 24 h and seen at none of those seatings leave the next
// census, and every round of the next day draws live nodes only; a node no seating drew is kept, a reserve that was present is kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NETWORK_ID_REGTEST } from '../src/genesis-ids.js';
import { drawCommittee } from '../src/sortition.js';
import { censusRootOf } from '../src/census.js';
import { toHex } from '../src/hash.js';
import { PRESENCE_VERSION } from '../src/constants.js';
import { absentFrom, withoutAbsent, absentImplied, checkAbsent, presenceWindow, inWindow, dropsAbsent, PRESENCE_WINDOW_MS } from '../src/presence.js';
import { NEXTBLOCK_GAME_ID } from '../../nextblock/plugin/nextblock.js';

const b32 = (n) => new Uint8Array(32).fill(n);
const entry = (k) => { const txid = b32(k); txid[0] = 0x70; return { txid, vout: 0, pubkey: b32(k), bondSats: 100000n, height: 1, hostedGames: [NEXTBLOCK_GAME_ID], roles: ['game', 'settlement'], spent: false, advertId: b32(0xad) }; };
const contract = { gameVerifySlots: 7, settlementSlots: 7, bondMinSats: 100000n, networkId: NETWORK_ID_REGTEST, gameId: NEXTBLOCK_GAME_ID, protocolVersion: PRESENCE_VERSION };
const DEAD = Array.from({ length: 20 }, (_, i) => i + 1);          // 11 installer nodes, 6 on the main macOS, t-1..t-3
const LIVE = Array.from({ length: 8 }, (_, i) => i + 21);
const census = [...DEAD, ...LIVE].map(entry);
const seed = (s) => { const b = b32(0); b[0] = s & 255; b[1] = s >> 8; b[2] = 0x27; return b; };
const T = 1793145600000n;                                           // the census block's median time past (2026-10-28 00:00Z)
const w = presenceWindow(T);
const hex = (k) => toHex(b32(k));
const isLive = (h) => LIVE.some((k) => hex(k) === h);

/** One day of seatings, a round every 15 min (Up/Down), seated as §5A.7 seats: present = the live drawn, 7 of them if >= 5. */
function day(entries, from = w.fromMs) {
  const out = [];
  for (let i = 0; i < 96; i++) {
    const drawn = drawCommittee({ entries, contract, role: 'settlement', committeeSeed: seed(i + Number(from % 1000n)) }).map((e) => toHex(e.pubkey));
    const present = drawn.filter(isLive);
    out.push({ roundId: toHex(seed(1000 + i)), role: 'settlement', closeMs: from + BigInt(i + 1) * 900000n, drawn, present, seated: present.length >= 5 ? present.slice(0, 7) : null });
  }
  return out;
}

test('the 10-27 day: 7 stopped of 9 drawn leave the next census; the next day draws live nodes only and every round is seated', () => {
  const today = day(census);
  const seatedBefore = today.filter((s) => s.seated).length;
  const worst = today.find((s) => s.drawn.filter((h) => !isLive(h)).length >= 7);
  assert.ok(worst, 'the day holds a round whose 9 drawn are 7 or more stopped nodes, as every v23 round of 10-27 was');
  const claims = absentFrom({ seatings: today, seen: today.flatMap((s) => s.present), census: census.map((e) => e.pubkey), window: w });
  const out = new Set(claims.map((c) => c.node));
  for (const h of worst.drawn.filter((h) => !isLive(h))) assert.ok(out.has(h), `stopped node ${h.slice(0, 8)} was drawn and seen nowhere: it is absent`);
  assert.ok(claims.every((c) => !isLive(c.node)), 'no live node is absent');
  assert.ok(claims.every((c) => c.drawnIn.length >= 1 && c.drawnIn.length <= 3), 'each claim names the seatings it was drawn for');
  const next = withoutAbsent(census, claims);
  const tomorrow = day(next, w.toMs);
  const seatedAfter = tomorrow.filter((s) => s.seated).length;
  for (const s of tomorrow) for (const h of worst.drawn.filter((x) => !isLive(x))) assert.ok(!s.drawn.includes(h), 'an absent node is not drawn');
  console.log(`  FACTS: 28 bonded, 20 stopped; seated rounds before ${seatedBefore}/96, ${claims.length} absent, seated after ${seatedAfter}/96`);
  assert.ok(seatedBefore < 48, 'the day before the rule seats fewer than half its rounds');
  assert.equal(seatedAfter, 96, 'with the rule every round of the next day is seated');
});

test('absent stays absent until seen: the day after, a stopped node drawn for nothing is carried out by the claim that left it out; a returning node signs once and is back', () => {
  const day1 = day(census);
  const claims1 = absentFrom({ seatings: day1, seen: day1.flatMap((s) => s.present), census: census.map((e) => e.pubkey), window: w });
  const root1 = 'c1'.repeat(32);
  // day 2 is drawn from the census less day 1's absent: the stopped nodes are drawn for nothing
  const w2 = presenceWindow(T + PRESENCE_WINDOW_MS);
  const day2 = day(withoutAbsent(census, claims1), w2.fromMs);
  assert.ok(day2.every((s) => s.drawn.every(isLive)));
  const without = absentFrom({ seatings: day2, seen: day2.flatMap((s) => s.present), census: census.map((e) => e.pubkey), window: w2 });
  assert.deepEqual(without, [], 'without carrying, every stopped node is back the day after - and day 3 draws dead nodes again');
  // node 4 came back on day 2 and signed a PRESENT for one seating of the window (drawn or not)
  const carried = claims1.map((c) => ({ node: c.node, root: root1 }));
  const claims2 = absentFrom({ seatings: day2, seen: [...day2.flatMap((s) => s.present), hex(4)], census: census.map((e) => e.pubkey), window: w2, carried });
  assert.deepEqual(claims2.map((c) => c.node), claims1.map((c) => c.node).filter((h) => h !== hex(4)), 'the stopped stay out; the returned node is in');
  assert.ok(claims2.every((c) => c.from === root1 && c.drawnIn.length === 0), 'each names the census that left it out');
  // a seat holding root1's claim and a window seating drawn from it agrees; one that holds another claim for root1 refutes
  const keys = census.map((e) => e.pubkey);
  assert.equal(checkAbsent(claims2, { census: keys, seen: [], drawOf: () => null, window: w2, carriedOf: (r) => (r === root1 ? claims1.map((c) => c.node) : null) }).ok, true);
  const r = checkAbsent(claims2, { census: keys, seen: [], drawOf: () => null, window: w2, carriedOf: (r) => (r === root1 ? [] : null) });
  assert.equal(r.proof, 'not-drawn');
  const fresh = checkAbsent(claims2, { census: keys, seen: [], drawOf: () => null, window: w2 });
  assert.equal(fresh.ok, true); assert.equal(fresh.unchecked.length, claims2.length, 'a seat without root1\'s claim cannot check: not refused');
  // and the census after: drawn for nothing, still carried while unseen
  const day3 = day(withoutAbsent(census, claims2), w2.toMs);
  assert.equal(day3.filter((s) => s.seated).length, 96, 'day 3 is seated in full');
});

test('a node no seating of the 24 h drew is kept; a present reserve is kept; a seating outside the window counts for nothing', () => {
  const fresh = entry(40);                       // bonded after the day's draws: in the census, drawn for nothing
  const today = day(census);
  const claims = absentFrom({ seatings: today, seen: today.flatMap((s) => s.present), census: [...census, fresh].map((e) => e.pubkey), window: w });
  assert.ok(!claims.some((c) => c.node === toHex(fresh.pubkey)), 'a node never drawn has nothing to be seen at: kept');
  // a live reserve: drawn, present, not seated (7 seats were full above it) - its PRESENT is seen
  const reserve = { roundId: toHex(seed(7)), role: 'settlement', closeMs: w.toMs - 1n, drawn: LIVE.map(hex).concat([hex(1)]), seated: LIVE.slice(0, 7).map(hex) };
  const c2 = absentFrom({ seatings: [reserve], seen: [hex(28)], census: census.map((e) => e.pubkey), window: w });
  assert.deepEqual(c2.map((c) => c.node), [hex(1)], 'the present reserve 28 is kept, the stopped node 1 is not');
  // the same seating a second past the window, or at its opening edge, is not in it
  for (const closeMs of [w.toMs + 1n, w.fromMs]) assert.deepEqual(absentFrom({ seatings: [{ ...reserve, closeMs }], seen: [], census: census.map((e) => e.pubkey), window: w }), []);
  assert.equal(inWindow(w, w.fromMs + 1n), true);
  assert.equal(w.toMs - w.fromMs, PRESENCE_WINDOW_MS);
  // seen once in the day is enough
  const once = absentFrom({ seatings: today, seen: [...today.flatMap((s) => s.present), hex(3)], census: census.map((e) => e.pubkey), window: w });
  assert.ok(!once.some((c) => c.node === hex(3)));
});

test('the root commits to the census less the absent, and the absent are recovered from the root\'s entries', () => {
  const today = day(census);
  const claims = absentFrom({ seatings: today, seen: today.flatMap((s) => s.present), census: census.map((e) => e.pubkey), window: w });
  const at = { censusHeight: 10, censusConfirmations: 1 };
  const full = censusRootOf(census, at), less = censusRootOf(withoutAbsent(census, claims), at);
  assert.notEqual(toHex(full.root), toHex(less.root));
  assert.deepEqual(absentImplied(census, less.entries), claims.map((c) => c.node), 'any seat with the chain and the entries names the same absent');
  // every output of an absent node goes with it
  const second = { ...entry(1), txid: b32(0x99), vout: 1 };
  assert.equal(withoutAbsent([...census, second], claims).some((e) => toHex(e.pubkey) === hex(1)), false);
  assert.equal(dropsAbsent({ protocolVersion: 21 }), false, 'below 22 nothing is left out');
  assert.equal(dropsAbsent({ protocolVersion: 22 }), true);
});

test('a seat checks a claim one way: its signature refutes, a seating that did not draw it refutes, a seating it cannot draw does not', () => {
  const today = day(census);
  const claims = absentFrom({ seatings: today, seen: today.flatMap((s) => s.present), census: census.map((e) => e.pubkey), window: w });
  const byId = new Map(today.map((s) => [`${s.roundId}:${s.role}`, s]));
  const drawOf = (rid, role) => byId.get(`${rid}:${role}`) || null;
  const keys = census.map((e) => e.pubkey);
  assert.deepEqual(checkAbsent(claims, { census: keys, seen: [], drawOf, window: w }), { ok: true, unchecked: [] }, 'a seat that holds the day agrees');
  // fewer than the whole absent set is never refused (keeping a node in is the rule before 22)
  assert.equal(checkAbsent(claims.slice(1), { census: keys, seen: [], drawOf, window: w }).ok, true);
  // a seat holding a stopped node's window PRESENT refutes its exclusion
  const r = checkAbsent(claims, { census: keys, seen: [claims[0].node], drawOf, window: w });
  assert.equal(r.ok, false); assert.equal(r.proof, 'seen'); assert.equal(r.node, claims[0].node);
  // a claim naming a live node that a seating never drew
  const lie = [{ node: hex(21), drawnIn: [{ roundId: today.find((s) => !s.drawn.includes(hex(21))).roundId, role: 'settlement' }] }];
  assert.equal(checkAbsent(lie, { census: keys, seen: [], drawOf, window: w }).proof, 'not-drawn');
  // a fresh seat: it holds no seating of the window - it cannot prove the claim wrong, so it does not refuse it
  const fresh = checkAbsent(claims, { census: keys, seen: [], drawOf: () => null, window: w });
  assert.equal(fresh.ok, true); assert.equal(fresh.unchecked.length, claims.length);
  // shape: sorted, once each, in the chain census, naming a seating
  assert.match(checkAbsent([...claims].reverse(), { census: keys, seen: [], drawOf, window: w }).why, /not sorted/);
  assert.match(checkAbsent([{ node: hex(77), drawnIn: claims[0].drawnIn }], { census: keys, seen: [], drawOf, window: w }).why, /not in the chain census/);
  assert.match(checkAbsent([{ node: claims[0].node, drawnIn: [] }], { census: keys, seen: [], drawOf, window: w }).why, /names no seating/);
});
