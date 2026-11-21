// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 v1-refute-53-s3 (second copy of #1550 / #1744 / #1900, outside verify.js and server.js): the settlement's
// FROST commitment gather (settlement.js #peerCommitments -> POST /settle-commit) reads each peer's answer with a bare
// arrayBuffer(), bounded only in time (peerAskMs, 60 s on a seat). An honest answer is one encoded commitment. One peer
// answering /settle-commit with 256 MiB is read whole right before the settlement is signed.
// Seven real LockSettlement instances (the harness of settlement-hung-peer.test.js), seat 6 floods.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments } from '../src/settlement.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256, toHex, fromHex } from '../../arena-protocol/src/hash.js';

const RID = new Uint8Array(32).fill(0x61);
const MSG = new Uint8Array(32).fill(0xab);
const TXID = toHex(MSG);
const GROUP = evenGroupSecret(0x1061n, curve);
const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
const BOUND_MS = 400;
const GRACE_MS = 100;

const base = (k) => `http://seat${k}`;
// A FETCH TO A PROCESS THAT TOOK THE CONNECTION AND STOPPED: it never answers, and only the caller's signal ends it, as with fetch
const hang = (o) => new Promise((_, reject) => {
  if (o && o.signal) o.signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
});

function stubRound() {
  const rows = { settlement: null };
  return {
    get: () => null, lockSettlement: () => rows.settlement, putLockSettlement: (r) => { rows.settlement = r; }, putLockSettlementMoves: () => {},
    rows,
  };
}

/** The seven seats; `hungAt(k, path)` says seat k does not answer that path; `wire` logs what is sent, as bytes. */
function seven({ answerAt = () => undefined, hungAt = () => false, wire = [], seed = 0x61, boundMs = BOUND_MS } = {}) {
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    const random = (n) => sha256(Uint8Array.from([seed, k, drawn++, n]));
    const round = stubRound();
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, peerAskMs: boundMs, peerReadMs: boundMs, peerGraceMs: GRACE_MS,
      fetcher: (u, o) => {
        const url = new URL(u);
        const to = Number(url.hostname.slice(4));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        if (hungAt(to, url.pathname)) return hang(o);
        const own = answerAt(to, url.pathname);
        if (own !== undefined) return own;
        return serve(seats[to], url, body);
      } });
    s.message = async () => ({ ok: true, txid: TXID, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, claims: [],
      plan: { payouts: [], claims: [], nonce: new Uint8Array(32), stakeShares: [] }, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } });
    seats.push(s);
  }
  return { seats, port, wire };
}

// WHAT server.js ANSWERS at /settle-commit, /settle-share and /settle-signature
async function serve(seat, url, body) {
  const rid = fromHex(url.searchParams.get('round'));
  if (url.pathname === '/settle-commit') {
    const got = await seat.commit(rid, { txid: url.searchParams.get('txid') });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: 409 });
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

const MIB = 1 << 20;
function flood(mib) {
  const meter = { pulled: 0 };
  let sent = 0;
  const body = new ReadableStream({
    pull(c) { if (sent >= mib) { c.close(); return; } sent++; meter.pulled += MIB; c.enqueue(new Uint8Array(MIB)); },
  });
  return { meter, response: new Response(body) };
}

test('#1489-v1-refute-53-s3-3: a peer answering /settle-commit with 256 MiB is not read whole before the settlement signature', async () => {
  const floods = [];
  const w = seven({ boundMs: 20000, answerAt: (k, path) => {
    if (k !== 6 || path !== '/settle-commit') return undefined;
    const f = flood(256); floods.push(f.meter); return f.response;
  } });
  const got = await w.seats[0].settle(RID);
  await new Promise((r) => setTimeout(r, 1500));
  const pulledMiB = floods.reduce((a, m) => a + m.pulled, 0) / MIB;
  const facts = { state: got.state, why: got.why, asks: floods.length, pulledMiB };
  console.log('  FACTS:', JSON.stringify(facts));
  assert.ok(floods.length >= 1, 'seat 6 was never asked (path not reached)');
  assert.equal(got.state, 'ACCEPTED', got.why);
  assert.equal(schnorr.verify(w.port.settled[0].signature, MSG, DEAL.groupPublicKey.subarray(1)), true);
  assert.ok(pulledMiB <= 4, `the settlement gather read ${pulledMiB} MiB of one peer's /settle-commit answer over ${floods.length} ask(s) (no size cap)`);
});
