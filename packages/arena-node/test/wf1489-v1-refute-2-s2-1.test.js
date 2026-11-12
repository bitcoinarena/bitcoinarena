// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 wf1489-v1-refute-2-s2-1: GET /forfeit is public and Forfeit.forfeit has no one-at-a-time guard. Since the #1667/#1731 slot per seat,
// two passes of the SAME seat get the SAME pair at every peer (its signed ask is "a replay": the slot hands back the unspent pair), while each pass
// draws its own SELF commitment - so the two lists differ and each peer signs whichever share reaches it first and refuses the other ("keeps no
// second pair"). Before the slot (a pair per ask) the two passes were independent. A stranger only has to ask GET /forfeit twice at once.
// (fixture from forfeit-withheld-hung.test.js, with signed asks as server.js hands them on)
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
const SECRETS = [0, 1, 2, 3, 4, 5, 6].map((k) => sha256(Uint8Array.from([0x68, k])));
const NODES = SECRETS.map((s) => schnorr.getPublicKey(s));

const base = (k) => `http://seat${k}`;
const seatOf = (u) => Number(new URL(u).hostname.slice(4));

function stubRound(k) {
  const kept = new Map();
  return { identity: { secret: SECRETS[k] }, pubkey: NODES[k],
    forfeit: (key) => kept.get(toHex(key)) || null, putForfeit: (r) => { kept.set(toHex(r.entryId), r); }, entryVoid: () => null, kept };
}

function seven() {
  const seats = [];
  const refusals = [];
  for (let k = 0; k < 7; k++) {
    let drawn = 0;
    const random = (n) => sha256(Uint8Array.from([0x74, k, drawn & 0xff, (drawn++ >> 8) & 0xff, n]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k).map(base);
    const f = new Forfeit(stubRound(k), { curve, random, peersFor: () => peers, peerAskMs: 2000, peerGraceMs: 100,
      dkg: { publicSharesFor: () => ({ ok: true, shares: PUBLIC_SHARES }) },
      fetcher: async (u, o) => {
        const url = new URL(u);
        const to = seatOf(u);
        // the network: each request takes a little while, as on the wire
        await new Promise((ok) => setTimeout(ok, 1 + ((k * 7 + to * 3 + drawn) % 5)));
        const r = await serve(seats[to], url, o && o.body ? new Uint8Array(o.body) : new Uint8Array(), (o && o.headers) || {});
        if (!r.ok) refusals.push(`${k}->${to} ${url.pathname}: ${await r.clone().text()}`);
        return r;
      } });
    const bytes = { ok: true, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, nodes: NODES, signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    f.message = async () => bytes;
    seats.push(f);
  }
  return { seats, refusals };
}

// WHAT server.js ANSWERS at /forfeit-commit, /forfeit-share and /forfeit-signature (the x-send-plan-ask header handed on)
async function serve(seat, url, body, headers) {
  const rid = fromHex(url.searchParams.get('round'));
  const eid = fromHex(url.searchParams.get('entry'));
  const kind = url.searchParams.get('lock') === 'fee' ? 'fee' : 'stake';
  const ask = headers['x-send-plan-ask'];
  if (url.pathname === '/forfeit-commit') {
    const got = await seat.commit(rid, eid, kind, { ask });
    return got.ok ? new Response(encodeCommitments([got.commitment])) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/forfeit-share') {
    const got = await seat.share(rid, eid, decodeCommitments(body), kind, { ask });
    return got.ok ? new Response(encodeShare(got.share)) : new Response(got.why, { status: got.status || 409 });
  }
  if (url.pathname === '/forfeit-signature') {
    const got = await seat.take(rid, eid, body, kind);
    return got.ok ? new Response('forfeit kept', { status: 201 }) : new Response(got.why, { status: 409 });
  }
  throw new Error(`no such door ${url.pathname}`);
}

const verifies = (got) => !!(got && got.ok && schnorr.verify(got.signature, MSG, DEAL.groupPublicKey.subarray(1)));

test('#1489 refute s2-1: two GET /forfeit at once at one seat - both answer the forfeit, neither is refused by the other pass', async () => {
  const w = seven();
  // THE STRANGER: asks the public door GET /forfeit of seat 0 twice at the same moment (no seat, no key needed)
  const got = await Promise.all([w.seats[0].forfeit(RID, ENTRY), w.seats[0].forfeit(RID, ENTRY)]);
  const second = w.refusals.filter((x) => /second pair/.test(x));
  console.log(`  FACTS: answers ${got.map((g) => (verifies(g) ? 'signed' : `refused: ${String(g.why).slice(0, 140)}`)).join(' | ')}; "no second pair" refusals ${second.length}, e.g. ${second.slice(0, 2).join(' / ')}`);
  assert.deepEqual(got.map(verifies), [true, true], `a concurrent pass of the same seat spoiled the other: ${got.map((g) => g.why || 'ok').join(' | ')}`);
});
