// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-53-s3 (second copy of #1550 / #1744 / #1900, outside verify.js and server.js): the FROST gathers
// before a forfeit signature (forfeit.js forfeit -> /forfeit-commit, #gatherShares -> /forfeit-share) and before a
// settlement signature (settlement.js #peerCommitments -> /settle-commit) read each peer's answer with a bare
// arrayBuffer() (and text() when it is not 200), bounded only in time (peerAskMs, 60 s on a seat). An honest answer is
// one encoded commitment (a few hundred bytes). One peer answering /forfeit-commit with 256 MiB is read whole.
// Seven real Forfeit instances (the harness of forfeit-withheld-hung.test.js), seat 6 floods.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { Forfeit, encodeCommitments, encodeShare } from '../src/forfeit.js';
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
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
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

const MIB = 1 << 20;
/** An answer whose body is `mib` MiB, made only as fast as it is read; `pulled` counts what the reader took. */
function flood(mib, status = 200) {
  const meter = { pulled: 0 };
  let sent = 0;
  const body = new ReadableStream({
    pull(c) { if (sent >= mib) { c.close(); return; } sent++; meter.pulled += MIB; c.enqueue(new Uint8Array(MIB)); },
  });
  return { meter, response: new Response(body, { status }) };
}

for (const status of [200, 409]) {
  test(`#1489-v1-refute-53-s3-2: a peer answering /forfeit-commit (${status}) with 256 MiB is not read whole before the forfeit signature`, async () => {
    const floods = [];
    const w = seven({ boundMs: 20000, misbehave: (k, path) => {
      if (k !== 6 || path !== '/forfeit-commit') return undefined;
      const f = flood(256, status); floods.push(f.meter); return f.response;
    } });
    const rss0 = process.memoryUsage().rss; let peak = rss0;
    const memT = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 10);
    try {
      const got = await w.seats[0].forfeit(RID, ENTRY);
      await new Promise((r) => setTimeout(r, 1500));
      const pulledMiB = floods.reduce((a, m) => a + m.pulled, 0) / MIB;
      const facts = { ok: got.ok, why: got.why, asks: floods.length, pulledMiB, peakRssDeltaMiB: Math.round((peak - rss0) / MIB) };
      console.log('  FACTS:', JSON.stringify(facts));
      assert.ok(floods.length >= 1, 'seat 6 was never asked (path not reached)');
      assert.ok(got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)), `the honest forfeit broke: ${got.why}`);
      assert.ok(pulledMiB <= 4, `the forfeit gather read ${pulledMiB} MiB of one peer's /forfeit-commit answer over ${floods.length} ask(s) (no size cap)`);
    } finally { clearInterval(memT); }
  });
}
