// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { schnorr } from '@noble/curves/secp256k1.js';

import { LockSettlement, encodeCommitments, encodeShare, decodeCommitments } from '../src/settlement.js';
import { StakeSecrets } from '../src/stake-secret.js';
import { askPeers } from '../src/peer-ask.js';
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
function seven({ hungAt = () => false, wire = [], seed = 0x61, boundMs = BOUND_MS } = {}) {
  const seats = [];
  const port = { settled: [], settle: async (x) => { port.settled.push(x); return { accepted: true, payoutsStored: [{ id: 'payout-0' }], locksAfter: [null] }; } };   // as the tool answers (kanban #1171)
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    // A FIXED STREAM PER SEAT: the same nonces whichever order the peers are asked in, so the bytes on the wire can be compared
    const random = (n) => { const d = drawn++; return sha256(Uint8Array.from([seed, k, d & 0xff, (d >> 8) & 0xff, (d >> 16) & 0xff, n])); };   // a counter that does not wrap at 256 draws
    const round = stubRound();
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const s = new LockSettlement(round, { curve, random, port, peersFor: () => peers, peerAskMs: boundMs, peerReadMs: boundMs, peerGraceMs: GRACE_MS,
      fetcher: (u, o) => {
        const url = new URL(u);
        const to = Number(url.hostname.slice(4));
        const body = o && o.body ? new Uint8Array(o.body) : new Uint8Array();
        wire.push(`${k} ${(o && o.method) || 'GET'} ${u} ${toHex(body)}`);
        if (hungAt(to, url.pathname)) return hang(o);
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

/** The answer or, past `ms`, what it was doing: the measure works before the fix too, where the settlement never answers. */
async function within(p, ms) {
  const t0 = Date.now();
  let timer;
  const out = await Promise.race([p.then((value) => ({ value })), new Promise((ok) => { timer = setTimeout(() => ok({ stuck: true }), ms); })]);
  clearTimeout(timer);
  return { ...out, ms: Date.now() - t0 };
}
// kanban #1489 attack round 4 (settlement): A STRANGER EVICTS THE ASKER'S NONCE PAIR. Since #1494 every POST /settle-commit draws a new
// pair and a seat keeps only the last PAIRS_KEPT (64) per settlement (settlement.js commit: held.slice(-PAIRS_KEPT)). /settle-commit
// answers anybody - no seat signature, no limit. A stranger who sends 64 commits to a seat between the honest asker's commit and its
// share request pushes the asker's pair out of that seat's memory: the share is refused ("that list does not carry this signer node's own
// commitment") at every seat he reaches, and the round's settlement - every winner's payout - never forms while he keeps doing it.
// Safe behaviour: the honest seats still combine and submit the settlement.
test('a stranger flooding /settle-commit between the asker\'s commit and share does not stop the settlement', async () => {
  const w = seven();
  let flooded = 0;
  // the stranger's 64 commits land right before each honest share request reaches its seat
  for (const [k, s] of w.seats.entries()) {
    const share = s.share.bind(s);
    s.share = async (rid, list, o) => { for (let i = 0; i < 64; i++) { await s.commit(rid); flooded++; } return share(rid, list, o); };
    void k;
  }
  const got = await within(w.seats[0].settle(RID), 8000);
  console.log(`  FACTS: ${flooded} stranger commits; ${got.stuck ? 'still waiting' : `${got.value.state || ''} ${got.value.why || ''}`} after ${got.ms} ms; submissions ${w.port.settled.length}`);
  assert.ok(!got.stuck, `still waiting after ${got.ms} ms`);
  assert.equal(got.value.state, 'ACCEPTED', `the settlement was not formed: ${got.value.why}`);
});
