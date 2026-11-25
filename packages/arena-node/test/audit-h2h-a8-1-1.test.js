// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// audit h2h a8-1-1: GAP IN THE #3347 FIX - THE EQUIVOCATOR PICKS THE TIME. #3347 lets a seat that sees two views of one key count neither, and holds
// a borderline entry's signature until close + LOCK_SET_VIEW_WAIT_MS "so a second view of a seat that equivocates reaches it first". That holds
// only if the equivocator sends early. Role (b), one seat M of 7 (threshold 5), with an entry C whose stake 4 of the 6 honest seats saw before the
// close (the a6-1-1 / #3257 set-up). M stays silent through the view wait and POSTs /lock-set {A,B,C} to seats 0-2 and {A,B} to seats 3-5 a few
// ms before close + 1200. take() keeps each one, and take() does not push views: the other variant reaches a seat only by a peer's next step (up
// to 100 ms) plus one network hop, or by a pull (every 400 ms). The seats' own step at close + 1200 signs first. Seats 0-2 count C in 5 views and
// sign {A,B,C}, seats 3-5 count it in 4 and sign {A,B}. M signs nothing. No set gets 5 signatures, so there is no certificate and the honest
// pair's paid round is VOID, as in #3347.
// The network here carries every push and pull with a 20 ms delay (LAT_MS), and every seat steps on the same 100 ms beat. Control: the same
// two views sent at close + 10 ms (the a6-1-1 timing, which #3347 fixed) leave the honest pair certified.
// Safe behaviour: the honest pair A, B (seen at every seat) is certified, whenever one seat sends its two views.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LockSetBook } from '../src/lock-set-book.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import * as LS from '../../arena-protocol/src/lock-set.js';

const { lockSetOf, lockSetId, lockSetViewId, LOCK_SET_WINDOW_MS, LOCK_SET_FINAL_AFTER_MS, LOCK_SET_VIEW_WAIT_MS } = LS;
const CLOSE = 1_900_000_000_000;
const LAT_MS = 20;
const hex = () => toHex(new Uint8Array(randomBytes(32)));
const tick = () => new Promise((ok) => setTimeout(ok, 5));

async function play({ sendAt }) {
  const rid = new Uint8Array(randomBytes(32));
  const A = hex(), B = hex(), C = hex();
  let now = CLOSE;
  const seat = (name) => { const secret = new Uint8Array(randomBytes(32)); return { name, secret, pubkey: schnorr.getPublicKey(secret) }; };
  const honest = [0, 1, 2, 3, 4, 5].map((i) => seat(`s${i}`));
  const m = seat('m');
  const committee = [...honest, m].map((s) => s.pubkey);
  const contract = { entryCloseMs: BigInt(CLOSE), stakeMsat: 1000n, protocolVersion: 33 };
  const books = new Map();
  // the wire: every message is delivered LAT_MS (round clock) after it was sent
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
  // C's stake seen before the close at honest seats 0-3 only (and at M); A and B at every seat
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
  let sent = false;
  const mSends = () => {   // M's POST /lock-set to each honest seat: {A,B,C} to 0-2, {A,B} to 3-5 (two signed views, one key)
    const withC = view([A, B, C], sendAt), withoutC = view([A, B], sendAt);
    b.forEach((bk, i) => bk.take(rid, { views: [i < 3 ? withC : withoutC] }));
    sent = true;
  };
  // every seat steps on one 100 ms beat (the server's lock-set pass), the wire delivering what is due before each beat
  for (let t = CLOSE + 50; t <= CLOSE + LOCK_SET_WINDOW_MS - 10; t += (t < CLOSE + LOCK_SET_VIEW_WAIT_MS + 200 ? 10 : 100)) {
    now = t;
    if (!sent && now >= sendAt) mSends();
    deliver();
    if ((t - CLOSE) % 100 === 0 || t === CLOSE + 50) for (const bk of b) await bk.step(rid);
    await tick();
    deliver();
  }
  now = CLOSE + LOCK_SET_WINDOW_MS + LOCK_SET_FINAL_AFTER_MS + 100;
  deliver();
  const facts = b.map((bk, i) => {
    const st = bk.state(rid);
    const mine = (st.signatures || []).find((x) => x.key === toHex(honest[i].pubkey));
    return { seat: i, signed: mine ? mine.entries.length : null, certified: st.entries ? st.entries.length : null, void: st.void };
  });
  const played = b.filter((bk) => { const c = bk.certified(rid); return c && c.entries.includes(A) && c.entries.includes(B); }).length;
  return { facts, played };
}

test('audit h2h a8-1-1 (control): two views sent at the close (the #3347 timing) leave the honest pair certified', async () => {
  const r = await play({ sendAt: CLOSE + 50 });
  console.log('  CONTROL:', JSON.stringify(r.facts));
  assert.ok(r.played >= 5, `control: ${JSON.stringify(r.facts)}`);
});

test('audit h2h a8-1-1: two views sent just before the view wait ends do not void an honest pair seen at every seat', async () => {
  const r = await play({ sendAt: CLOSE + LOCK_SET_VIEW_WAIT_MS - 5 });
  console.log('  LATE:', JSON.stringify(r.facts));
  assert.ok(r.played >= 5, `one seat's two views, sent ${5} ms before close + ${LOCK_SET_VIEW_WAIT_MS}, split the honest seats' sets (gap in #3347): no certificate, the honest pair's round is VOID: ${JSON.stringify(r.facts)}`);
});
