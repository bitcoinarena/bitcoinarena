// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments, PAIRS_KEPT } from '../src/settlement.js';
import { PAIRS_ALL } from '../src/nonce-pool.js';
import * as curve from '../src/curve.js';
const realCurve = curve;
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

// kanban #2536 (1.9 merge triage): the ring and PAIRS_BUDGET are gone - nonce-pool.js keeps PAIRS_PER_KEY (= PAIRS_KEPT) per signing and
// asker and PAIRS_ALL over all signings, and past PAIRS_ALL drops ONE young unspent pair at random (never the oldest quarter of its pool,
// never the seat's own). The same attack, adapted: the stranger fills the seat's whole budget (PAIRS_ALL) with other rounds' pairs
// beforehand, then sends commits in the window between the asker's commit and its share ask, at 3 of 7 peers. Every commit uses fresh
// random bytes (a repeated draw is refused, kanban #1699), so the prefill is real curve work. The hold is set past the prefill's length, so
// none of the stranger's pairs is old when the window opens (the strongest case: the default hold sweeps an older prefill away first).
// kanban #1489 a44 refute 9, skeptic 2 (fix #1610 + #2128): the door keeps pairs in a ring of PAIRS_KEPT per settlement, but past PAIRS_BUDGET
// slots over ALL settlements the least recently asked settlements give up their rings. A stranger fills the rings of 8 other settled-or-settling
// rounds at a seat beforehand (no time pressure: rings never shrink), grows the honest round's ring past RING_FIRST (65 commits), and then,
// in the 3 s between an asker's commit and its share ask, sends 8 commits: one to each other round (so the honest round is the least
// recently asked) and one that grows a ring. The budget evicts the honest round's ring - the asker's door pair - and its share is refused.
// Done at 3 of 7 peers, no pass of a 5-of-7 reaches the threshold. Same effect as #1610, with 8 requests in the window instead of 64.
//
const RID = new Uint8Array(32).fill(0x61);
const OTHERS = PAIRS_ALL / PAIRS_KEPT;   // 16 other rounds fill the budget
const OTHER = Array.from({ length: OTHERS }, (_, i) => { const b = new Uint8Array(32).fill(0x71); b[0] = i; b[1] = 0x99; return b; });
const msgOf = (rid) => sha256(rid);
const GROUP = evenGroupSecret(0x1061n, realCurve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve: realCurve });
const base = (k) => `http://seat${k}`;

function stubRound() {
  const rows = { settlement: null };
  return { get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {}, lockSettlementMoves: () => null, rows };
}

function seven({ beforeShare = async () => {} } = {}) {
  const seats = [];
  const flooding = [];
  const shareWhy = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    flooding.push(false);
    const random = (n) => sha256(Uint8Array.from([0x62, k, drawn & 0xff, (drawn >> 8) & 0xff, (drawn >> 16) & 0xff, (drawn++ >> 24) & 0xff, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(stubRound(), { curve, random, port, peersFor: () => peers, peerAskMs: 400, peerReadMs: 400, peerGraceMs: 100, now: () => 1_000_000,
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = Number(url.hostname.slice(4));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        if (url.pathname === '/settle-share') await beforeShare(to, seats[to]);
        const r = await serve(seats[to], url, body);
        if (url.pathname === '/settle-share' && !r.ok) shareWhy.push(`${to}: ${await r.clone().text()}`);
        return r;
      } });
    s.message = async (rid) => ({ ok: true, txid: toHex(msgOf(rid)), message: msgOf(rid), claimPk: DEAL.groupPublicKey, needed: 5, claims: [],
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } });
    seats.push(s);
  }
  return { seats, port, flooding, shareWhy };
}

async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid') });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/settle-share') {
    const got = await seat.share(rid, decodeCommitments(body));
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/settle-signature') {
    const got = await seat.take(rid, body);
    return got.ok ? new Response('kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

// what a stranger sends to /settle-commit?round=<rid>&txid=<its bytes> - the door answers anyone
const door = (seat, rid) => seat.commit(rid, { txid: toHex(msgOf(rid)) });

/** BEFOREHAND, no time pressure: the honest round's pool grown by 65, every other round's pool full - the seat's whole PAIRS_ALL. */
async function prefill(w, k) {
  const s = w.seats[k];
  s.pairHoldMs = 3_600_000;   // the strongest stranger: his whole prefill is still young (inside the hold) when the asker asks
  for (let i = 0; i < 65; i++) await door(s, RID);
  for (let r = 0; r < OTHERS; r++) for (let i = 0; i < PAIRS_KEPT; i++) await door(s, OTHER[r]);
}

/** IN THE WINDOW between the asker's commit and its share ask: WINDOW commits, each one past the budget. */
const WINDOW = 8;
async function inWindow(s) {
  for (let i = 0; i < WINDOW; i++) await door(s, OTHER[i % OTHERS]);
}

const ATTACKED = [1, 2, 3];

test('#2396: a stranger who filled the seats\' whole pair budget and commits in the window does not push the asker\'s pair out at 3 of 7 peers', { timeout: 600000 }, async () => {
  const fired = new Set();
  const w = seven({ beforeShare: async (to, seat) => { if (ATTACKED.includes(to) && !fired.has(to)) { fired.add(to); await inWindow(seat); } } });
  const t0 = Date.now();
  for (const k of ATTACKED) await prefill(w, k);
  const prefillMs = Date.now() - t0;
  const got = await w.seats[0].settle(RID);
  console.log(`  FACTS: PAIRS_KEPT ${PAIRS_KEPT}, PAIRS_ALL ${PAIRS_ALL}; pairs held ${ATTACKED.map((k) => w.seats[k].pairs.count).join(',')}; prefill ${prefillMs} ms; window commits per seat ${WINDOW} at ${[...fired].join(',')}; state ${got.state || ''} ${got.why || ''}; share refusals ${JSON.stringify(w.shareWhy)}; submissions ${w.port.settled.length}`);
  assert.equal(got.state, 'ACCEPTED', `the settlement was not formed: ${got.why}`);
  for (const k of ATTACKED) assert.ok(w.seats[k].pairs.count <= PAIRS_ALL, 'the budget still bounds memory');
});
