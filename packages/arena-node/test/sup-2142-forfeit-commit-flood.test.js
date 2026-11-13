// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2142 (a44-refute-25 of #1611): strangers filling /forfeit-commit no longer block the forfeit. Adapted to 1.9 by #2536: the card's
// PairBook is gone - forfeit.js keeps its pairs in nonce-pool.js (#2011/#2044, per-asker pools #2386), which never refuses a commit for room.
// The same flood (PAIRS_PER_KEY + 1 stranger commits at each of three seats, more than a full pool) and the asker's forfeit after it.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { Forfeit } from '../src/forfeit.js';
import { PAIRS_PER_KEY } from '../src/nonce-pool.js';
import * as curve from '../src/curve.js';
import { evenGroupSecret } from '../../arena-protocol/src/frost-bip340.js';
import { trustedDealerSplit } from '../../arena-protocol/src/frost.js';
import { sha256 } from '../../arena-protocol/src/hash.js';

test('#2142 (1.9): PAIRS_PER_KEY + 1 stranger commits at each of three seats: the forfeit still forms, and what a commit costs the seat', async () => {
  const RID = new Uint8Array(32).fill(0x21);
  const ENTRY = new Uint8Array(32).fill(0x42);
  const MSG = new Uint8Array(32).fill(0xad);
  const GROUP = evenGroupSecret(0x2142n, curve);
  const DEAL = trustedDealerSplit({ secret: GROUP.secret, max: 7, min: 5, coefficients: [5n, 6n, 7n, 8n], curve });
  const kept = new Map();
  const round = { forfeit: () => null, putForfeit: (r) => kept.set(r.entryId, r), entryVoid: () => null };
  const seats = [];
  for (let k = 0; k < 7; k++) {
    let d = 0;
    const random = () => sha256(Uint8Array.from([k, d & 0xff, (d >> 8) & 0xff, (d++ >> 16) & 0xff]));
    const peers = [0, 1, 2, 3, 4, 5, 6].filter((j) => j !== k);
    const f = new Forfeit(round, { curve, random, peersFor: () => peers.map((j) => `http://s${j}`), peerAskMs: 400, peerGraceMs: 100,
      fetcher: async (u, o) => {
        const url = new URL(u);
        const s = seats[Number(url.hostname.slice(1))];
        const { encodeCommitments, encodeShare } = await import('../src/forfeit.js');
        const { decodeCommitments } = await import('../src/pool-wire.js');
        if (url.pathname === '/forfeit-commit') { const g = await s.commit(RID, ENTRY); return g.ok ? new Response(encodeCommitments([g.commitment])) : new Response(g.why, { status: g.status || 409 }); }
        if (url.pathname === '/forfeit-share') { const g = await s.share(RID, ENTRY, decodeCommitments(new Uint8Array(o.body))); return g.ok ? new Response(encodeShare(g.share)) : new Response(g.why, { status: 409 }); }
        const g = await s.take(RID, ENTRY, new Uint8Array(o.body)); return new Response(g.ok ? 'ok' : g.why, { status: g.ok ? 201 : 409 });
      } });
    const bytes = { ok: true, message: MSG, claimPk: DEAL.groupPublicKey, needed: 5, nodes: [], signerNode: { id: DEAL.shares[k].id, share: DEAL.shares[k].share } };
    f.message = async () => bytes;
    seats.push(f);
  }
  const t0 = process.hrtime.bigint();
  let n = 0;
  for (const k of [1, 2, 3]) for (let i = 0; i <= PAIRS_PER_KEY; i++) { const g = await seats[k].commit(RID, ENTRY); assert.equal(g.ok, true, g.why); n++; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const got = await seats[0].forfeit(RID, ENTRY);
  console.log(`  FACTS: ${n} stranger commits in ${ms.toFixed(0)} ms (${Math.round(n / (ms / 1000))}/s on one thread, the message stubbed); `
    + `pairs at seat 1: ${seats[1].pairs.count}; seat 0: ${got.ok ? 'forfeit made' : got.why}`);
  assert.equal(got.ok, true, got.why);
});
