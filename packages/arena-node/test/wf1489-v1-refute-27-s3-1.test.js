// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-27 skeptic 3: A STRANGER WHO KEEPS THE FORFEIT'S NONCE POOL FULL STOPS THE FORFEIT. Since 897c910a7 an unspent pair is
// kept for its asker for the whole hold (2 x (PEER_ASK_MS + PEER_GRACE_MS) = 126 s live) and while all PAIRS_PER_FORFEIT (4096) slots hold such a
// young unspent pair, every new /forfeit-commit is refused (503). The door answers anybody and costs only a round id and an entry id, so a stranger
// posting /forfeit-commit about 33 times a second at each seat (4096 / 126 s; no rate limit at the door) keeps every seat refusing the honest
// asker's commit: the forfeit (a winner's stake back, an ENTRY_VOID refund) never forms while he keeps doing it. Here the stranger fills the pool
// once at each seat, all within one hold, and three askers try in turn at the live bound.
// Safe behaviour: the honest seats still combine the forfeit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Forfeit, encodeCommitments, encodeShare, PAIRS_PER_FORFEIT } from '../src/forfeit.js';
import { decodeCommitments } from '../src/pool-wire.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x74);
const ENTRY = new Uint8Array(32).fill(0x75);
const MSG = new Uint8Array(32).fill(0xad);
const GROUP = evenGroupSecret(0x1074n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const PUBLIC_SHARES = new Map(DEAL.shares.map((s) => [String(s.id), curve.pointFromScalar(s.share)]));
const BOUND_MS = 400;
const GRACE_MS = 100;

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));
// A FETCH TO A PROCESS THAT TOOK THE CONNECTION AND STOPPED: it never answers, and only the caller's signal ends it, as with fetch
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

function stubRound() {
  const kept = new Map();
  return { forfeit: (key) => kept.get(toHex(key)) || null, putForfeit: (r) => { kept.set(toHex(r.entryId), r); }, entryVoid: () => null, kept };
}

/**
 * The seven seats. `misbehave(k, path, o)` answers for seat k at that door, throws as a dropped connection, or hangs; undefined is the honest door.
 * `wire` logs every request as bytes.
 */
function seven({ misbehave = () => undefined, seed = 0x74, boundMs = BOUND_MS, wire = [] } = {}) {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    // NO WRAP AT 256 DRAWS (kanban #1699): the first 256 draws hash the bytes they always did
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from(d < 256 ? [seed, k, d, n] : [seed, k, d & 255, n, (d >> 8) & 255, (d >> 16) & 255, (d >> 24) & 255])); };
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const f = new Forfeit(stubRound(), { curve, random, peersFor: () => peers, peerAskMs: boundMs, peerGraceMs: GRACE_MS,
      dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        const own = misbehave(to, url.pathname, o);
        if (own !== undefined) return own;
        const r = await serve(seats[to], url, body);
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, nodes: [], signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    f.message = async () => bytes;
    seats.push(f);
  }
  return { seats, refusals, wire };
}

// WHAT server.js ANSWERS at /forfeit-commit, /forfeit-share and /forfeit-signature
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  const eid = fromHex(url.searchParams.get('entry'));
  const kind = url.searchParams.get('lock') === 'fee' ? 'fee' : 'stake';
  if (url.pathname === '/forfeit-commit') {
    const got = await seat.commit(rid, eid, kind);
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
  }
  if (url.pathname === '/forfeit-share') {
    const got = await seat.share(rid, eid, decodeCommitments(body), kind);
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/forfeit-signature') {
    const got = await seat.take(rid, eid, body, kind);
    return got.ok ? new Response('forfeit kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const refused = () => new Response('this seat gives no share', { status: 503 });
const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));

/** The answer or, past `ms`, what it was doing: the measure works before the fix too, where the forfeit never answers. */
async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value }), (e) => ({ value: { ok: false, why: `threw: ${e.message}` } })),
    new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}


test('a stranger who fills every seat\'s forfeit nonce pool with unspent commits does not stop the forfeit', async () => {
  const w = seven({ boundMs: 60000 });
  let taken = 0, refusedAt = 0;
  for (let k = 0; k < 7; k++) {
    for (let i = 0; i < PAIRS_PER_FORFEIT; i++) {
      const r = await serve(w.seats[k], new URL(`http://seat${k}/forfeit-commit?round=${toHex(RID)}&entry=${toHex(ENTRY)}`), new Uint8Array());
      if (r.ok) taken += 1; else { refusedAt += 1; break; }
    }
  }
  let got = null;
  const asks = [];
  for (const asker of [0, 1, 2]) {
    const out = await within(w.seats[asker].forfeit(RID, ENTRY).catch((e) => ({ ok: false, why: e.message })), 30000);
    got = out.stuck ? { ok: false, why: 'stuck' } : out.value;
    asks.push(`seat ${asker}: ${got.ok ? 'forfeit made' : got.why}`);
    if (got.ok) break;
  }
  const full = w.refusals.filter((x) => /holds as many unspent/.test(x)).length;
  console.log(`  FACTS: the stranger took ${taken} commitments (${PAIRS_PER_FORFEIT} per seat); ${full} honest commit(s) refused as a full pool; ${asks.join(' | ')}`);
  assert.ok(verifies(got), `a stranger with no key held the forfeit up by filling the pool: ${asks.join(' | ')}`);
});
