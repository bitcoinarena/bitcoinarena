// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #3727 (gap in #3347, ruling 2026-11-25, option 1): A NEW VIEW TRAVELS AT ONCE, A BORDERLINE ENTRY WAITS FOR IT, AND TWO VIEWS OF ONE KEY
// ARE SLASHABLE. Seven seats (threshold 5), one of them M; an entry C seen before the close by honest seats 0-3 and M (the a6-1-1 / #3257 set-up),
// A and B by every seat. A seat hands every new view on at once (a key's second one too) and signs an entry one view could tip only
// LOCK_SET_VIEW_HOLD_MS after the last new view it took (never past close + LOCK_SET_VIEW_HOLD_UNTIL_MS). Two views by one key over two sets are
// kept at every honest seat as evidence that slash.js slashHoldsOnTwoLockSetViews holds on; one view is no evidence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import * as LS from '../../arena-protocol/src/lock-set.js';
import * as SL from '../../arena-protocol/src/slash.js';

const { lockSetOf, lockSetId, lockSetViewId, lockSetSignatureId, LOCK_SET_WINDOW_MS, LOCK_SET_FINAL_AFTER_MS, LOCK_SET_VIEW_WAIT_MS,
  LOCK_SET_VIEW_HOLD_MS, LOCK_SET_VIEW_HOLD_UNTIL_MS } = LS;
const CLOSE = 1_900_000_000_000;
const LAT_MS = 20;
const hex = () => toHex(new Uint8Array(randomBytes(32)));
const tick = () => new Promise((ok) => setTimeout(ok, 5));
const verify = (sig, msg, key) => { try { return schnorr.verify(sig, msg, key); } catch { return false; } };
const ALL = [0, 1, 2, 3, 4, 5];

/**
 * `sends`: M's POSTs [{ at, withC, to, sig }] - one view each ({A,B,C} or {A,B}, signed at `at`) to the honest seats `to`; with `sig` a set
 * signature over that set instead (an honest but slow M).
 */
async function play(sends) {
  const rid = new Uint8Array(randomBytes(32));
  const A = hex(), B = hex(), C = hex();
  let now = CLOSE;
  const seat = (name) => { const secret = new Uint8Array(randomBytes(32)); return { name, secret, pubkey: schnorr.getPublicKey(secret) }; };
  const honest = ALL.map((i) => seat(`s${i}`));
  const m = seat('m');
  const committee = [...honest, m].map((s) => s.pubkey);
  const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n, protocolVersion: 33 };
  const books = new Map();
  const wire = [];
  const deliver = () => { for (let i = 0; i < wire.length;) { if (wire[i].due <= now) { const w = wire.splice(i, 1)[0]; w.run(); } else i++; } };
  const fetchFn = (u, o = {}) => new Promise((ok, no) => {
    const host = new URL(u).host;
    if (host === 'm') { ok(o.method === 'POST' ? { ok: true, body: null } : { ok: true, text: async () => JSON.stringify({ views: [], signatures: [] }), body: null }); return; }
    const b = books.get(host);
    if (!b) { no(new Error('down')); return; }
    const body = o.method === 'POST' ? o.body : null;
    wire.push({ due: now + LAT_MS, run: () => {
      if (body !== null) { b.take(rid, JSON.parse(body)); ok({ ok: true, body: null }); return; }
      const text = JSON.stringify(b.state(rid));
      ok({ ok: true, text: async () => text, body: null });
    } });
  });
  const b = honest.map((s, i) => {
    const round = { db: new DatabaseSync(':memory:'), signerNodes: () => committee, now: () => now, pubkey: s.pubkey, identity: { secret: s.secret, pubkey: s.pubkey } };
    const peers = [...honest.map((h) => h.name), 'm'].filter((n) => n !== s.name).map((n) => `http://${n}`);
    const bk = new LockSetBook({ round, peersOf: () => peers, roundOf: () => contract, viewOf: () => (i < 4 ? [A, B, C] : [A, B]), fetchFn });
    books.set(s.name, bk);
    return bk;
  });
  const view = (entries, atMs) => {
    const set = lockSetOf({ roundId: rid, entries }), setId = lockSetId(set);
    return { key: toHex(m.pubkey), atMs, entries: set.entries.map(toHex), sig: toHex(schnorr.sign(lockSetViewId({ setId, atMs }), m.secret)) };
  };
  const setSig = (entries, atMs) => {
    const set = lockSetOf({ roundId: rid, entries }), setId = lockSetId(set);
    return { key: toHex(m.pubkey), atMs, entries: set.entries.map(toHex), sig: toHex(schnorr.sign(lockSetSignatureId({ setId, atMs }), m.secret)) };
  };
  const todo = sends.map((x) => ({ ...x, done: false }));
  for (let t = CLOSE + 10; t <= CLOSE + LOCK_SET_WINDOW_MS - 10; t += 5) {
    now = t;
    for (const x of todo) {
      if (x.done || now < x.at) continue;
      const entries = x.withC ? [A, B, C] : [A, B];
      const body = x.sig ? { signatures: [setSig(entries, x.at)] } : { views: [view(entries, x.at)] };
      for (const i of x.to) b[i].take(rid, body);
      x.done = true;
    }
    deliver();
    if ((t - CLOSE) % 100 === 0) for (const bk of b) await bk.step(rid);
    if ((t - CLOSE) % 20 === 0) await tick();
    deliver();
  }
  now = CLOSE + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS + 100;
  deliver();
  const facts = b.map((bk, i) => {
    const st = bk.state(rid);
    const mine = (st.signatures || []).find((x) => x.key === toHex(honest[i].pubkey));
    return { seat: i, signed: mine ? mine.entries.length : null, signedAt: mine ? mine.atMs - CLOSE : null, certified: st.entries ? st.entries.length : null, void: st.void, evidence: bk.doubleViews(rid).length };
  });
  const played = b.filter((bk) => { const c = bk.certified(rid); return c && c.entries.includes(A) && c.entries.includes(B); }).length;
  return { facts, played, books: b, m, committee, rid };
}

/** Does every honest seat hold evidence of M's two views that slashHoldsOnTwoLockSetViews holds on (and that is no TWO_LOCK_SETS proof)? */
function evidenceHolds(r) {
  const advert = { nodePubkey: r.m.pubkey, bondTxid: new Uint8Array(32).fill(5), bondVout: 0 };
  return r.books.map((bk) => {
    const ev = bk.doubleViews(r.rid);
    if (ev.length !== 1 || ev[0].key !== toHex(r.m.pubkey)) return false;
    const [a, c] = ev[0].signedViews;
    const proof = SL.twoLockSetViewsProof({ nodePubkey: r.m.pubkey, a, b: c, bondTxid: advert.bondTxid, bondVout: 0 });
    const held = SL.slashHoldsOnTwoLockSetViews({ proof, signedViews: [a, c], advert, committee: r.committee, verify });
    const asSets = SL.slashHoldsOnTwoLockSets({ proof: SL.twoLockSetsProof({ nodePubkey: r.m.pubkey, a, b: c, bondTxid: advert.bondTxid, bondVout: 0 }), signedLockSets: [a, c], advert, committee: r.committee, verify });
    return held.slashed === true && held.offence === SL.TWO_LOCK_SET_VIEWS && held.toReserves === true && asSets.slashed === false;
  });
}

test('#3727: one seat\'s two views, sent to some seats each just before close + LOCK_SET_VIEW_WAIT_MS: the pair certified, the two views slashable at every honest seat', async () => {
  const at = CLOSE + LOCK_SET_VIEW_WAIT_MS - 5;
  const r = await play([{ at, withC: true, to: [0, 1, 2] }, { at, withC: false, to: [3, 4, 5] }]);
  console.log('  TWO LATE VIEWS:', JSON.stringify(r.facts));
  assert.ok(r.played >= 5, JSON.stringify(r.facts));
  assert.deepEqual(evidenceHolds(r), ALL.map(() => true), 'every honest seat holds verifiable evidence of the two views');
});

test('#3727: ONE view taken late by some seats (a slow honest seat) reaches the others at once: every seat counts it, the set is certified, no evidence', async () => {
  // M's one view reaches seats 0-2 only, 50 ms before the view wait ends - after their last step before it, so before #3727 it went on only
  // with their step at close + 1200, after they had signed on it: seats 0-2 signed {A,B,C} and seat 3 {A,B} - with M's set signature 4 each way,
  // VOID. Now it travels at once, the seats that hold C wait for it, and M's signature makes the certificate
  const at = CLOSE + LOCK_SET_VIEW_WAIT_MS - 50;
  const r = await play([{ at, withC: true, to: [0, 1, 2] }, { at: CLOSE + LOCK_SET_VIEW_HOLD_UNTIL_MS, withC: true, sig: true, to: ALL }]);
  console.log('  ONE LATE VIEW:', JSON.stringify(r.facts));
  assert.deepEqual(r.facts.map((f) => f.signed), [3, 3, 3, 3, 2, 2], `the seats that saw C agree on it: ${JSON.stringify(r.facts)}`);
  assert.ok(r.played >= 5, JSON.stringify(r.facts));
  assert.ok(r.facts.every((f) => f.evidence === 0), 'one view is no offence');
});

test('#3727 adaptive: a first view late to some seats, the second to the others just before their hold ends: the pair certified, the views slashable', async () => {
  const first = CLOSE + LOCK_SET_VIEW_WAIT_MS - 50;
  const r = await play([{ at: first, withC: true, to: [0, 1, 2] }, { at: first + LOCK_SET_VIEW_HOLD_MS - 5, withC: false, to: [3, 4, 5] }]);
  console.log('  ADAPTIVE (hold):', JSON.stringify(r.facts));
  assert.ok(r.played >= 5, JSON.stringify(r.facts));
  assert.ok(r.facts.every((f) => f.signedAt <= LOCK_SET_VIEW_HOLD_UNTIL_MS + 100), 'the hold never runs past its bound');
  assert.deepEqual(evidenceHolds(r), ALL.map(() => true));
});

test('#3727 adaptive: both views to every seat early, the second again to a subset just before the hold ends: the pair certified, the views slashable', async () => {
  const r = await play([{ at: CLOSE + 10, withC: true, to: ALL }, { at: CLOSE + 20, withC: false, to: ALL }, { at: CLOSE + LOCK_SET_VIEW_WAIT_MS - 5, withC: false, to: [3, 4, 5] }]);
  console.log('  ADAPTIVE (early):', JSON.stringify(r.facts));
  assert.ok(r.played >= 5, JSON.stringify(r.facts));
  assert.deepEqual(evidenceHolds(r), ALL.map(() => true));
});

test('#3727: a second view sent after the seats signed (to some seats only) is still slashable at every honest seat', async () => {
  const r = await play([{ at: CLOSE + 10, withC: true, to: ALL }, { at: CLOSE + LOCK_SET_WINDOW_MS - 500, withC: false, to: [3] }]);
  console.log('  AFTER SIGNING:', JSON.stringify(r.facts), 'played', r.played);
  assert.ok(r.facts.every((f) => f.signedAt < LOCK_SET_WINDOW_MS - 500), 'every seat had signed before the second view');
  assert.deepEqual(evidenceHolds(r), ALL.map(() => true), 'a split the second view could still make costs its sender the bond');
});

test('#3727: the two-views proof holds only on two views over different sets by the accused, named in one order, with its own commitment', () => {
  const rid = new Uint8Array(randomBytes(32));
  const mk = () => { const secret = new Uint8Array(randomBytes(32)); return { secret, pubkey: schnorr.getPublicKey(secret) }; };
  const x = mk(), y = mk(), committee = [x.pubkey, y.pubkey];
  const A = hex(), E = hex();
  const sv = (s, entries, atMs, idOf = lockSetViewId) => { const set = lockSetOf({ roundId: rid, entries }), setId = lockSetId(set);
    return LS.encodeSignedLockSetView({ set, atMs: BigInt(atMs), sig: schnorr.sign(idOf({ setId, atMs: BigInt(atMs) }), s.secret) }); };
  const advert = { nodePubkey: x.pubkey, bondTxid: new Uint8Array(32).fill(9), bondVout: 0 };
  const holds = (pair, who = x) => SL.slashHoldsOnTwoLockSetViews({ proof: SL.twoLockSetViewsProof({ nodePubkey: who.pubkey, a: pair[0], b: pair[1], bondTxid: advert.bondTxid, bondVout: 0 }),
    signedViews: pair, advert: { ...advert, nodePubkey: who.pubkey }, committee, verify });
  const one = sv(x, [A], CLOSE + 10), two = sv(x, [A, E], CLOSE + 20);
  assert.equal(holds([one, two]).slashed, true);
  assert.equal(toHex(holds([one, two]).commitment), toHex(holds([two, one]).commitment), 'either order, one commitment');
  assert.equal(holds([one, sv(x, [A], CLOSE + 30)]).slashed, false, 'the same set twice is no offence');
  assert.equal(holds([one, sv(x, [A, E], CLOSE + 20, lockSetSignatureId)]).slashed, false, 'a set signature is not a view');
  assert.equal(holds([one, sv(y, [A, E], CLOSE + 20)]).slashed, false, 'another seat\'s view is not the accused\'s');
  const p = SL.twoLockSetViewsProof({ nodePubkey: x.pubkey, a: one, b: two, bondTxid: advert.bondTxid, bondVout: 0 });
  assert.equal(SL.slashHoldsOnTwoLockSetViews({ proof: { ...p, signedResultId: p.transcriptHash, transcriptHash: p.signedResultId }, signedViews: [one, two], advert, committee, verify }).slashed, false, 'named in the wrong order');
  // two set signatures over the same two sets: another offence, another commitment
  const s1 = sv(x, [A], CLOSE + 10, lockSetSignatureId), s2 = sv(x, [A, E], CLOSE + 20, lockSetSignatureId);
  const setsProof = SL.twoLockSetsProof({ nodePubkey: x.pubkey, a: s1, b: s2, bondTxid: advert.bondTxid, bondVout: 0 });
  assert.notEqual(toHex(SL.slashCommitment(setsProof)), toHex(holds([one, two]).commitment));
  assert.equal(SL.slashHoldsOnTwoLockSetViews({ proof: setsProof, signedViews: [one, two], advert, committee, verify }).slashed, false, 'a TWO_LOCK_SETS proof body is not this offence\'s');
  assert.ok(SL.LOCK_SET_OFFENCES.includes(SL.TWO_LOCK_SET_VIEWS));
});
