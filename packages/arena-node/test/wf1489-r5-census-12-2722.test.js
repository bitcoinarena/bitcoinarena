// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 census-12 (P5, bypass of the #2522 fix of r12 gossip-3): a seat now keeps at most FUNDING_PER_AUTHOR_MAX (32) funding / fee /
// leaderboard proposals of ONE author key - but "anyone may propose" and an author key costs nothing: the stranger signs each proposal with a fresh
// key. Every one is kept for good in funding_items, forwarded fresh to every network seat (forwardFunding), listed in GET /funding (each one's
// signature checked again on every list()) and walked in every decide()/voteRound() pass - exactly what #2522 meant to stop, by one stranger.
// SAFE: one stranger cannot grow a seat's kept funding proposals without bound by signing each with a new key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeFundingProposal, fundingProposalId } from '../../arena-protocol/src/funding.js';
import { FUNDING_UNSIGNALED_MAX as FUNDING_PER_AUTHOR_MAX } from '../src/funding-book.js';   // 2.0: no #2522 per-author bound; the #2722 unsignalled bound
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const N = 2000;

test('wf1489 r5 census-12: one stranger signing each funding proposal with a fresh key cannot make a seat keep 2000 of them', { timeout: 240000 }, async () => {
  const seat = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0 });
  try {
    const url = `http://127.0.0.1:${seat.http.address().port}`;
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const sk = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey();   // a fresh author key per proposal
      const P = { networkId: new Uint8Array(32).fill(7), author: schnorr.getPublicKey(sk), publishedHeight: 1, amountSats: 1n, lnurl: 'x@example.com', purpose: `spam ${i}` };
      const hex = toHex(Uint8Array.from([...encodeFundingProposal(P), ...schnorr.sign(fundingProposalId(P), sk)]));
      const r = await fetch(`${url}/funding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'proposal', hex }) });
      if (r.status === 200) ok++;
      await r.arrayBuffer();
    }
    const kept = seat.funding.list().length;
    console.log(`  FRESH KEYS: ${ok} of ${N} stranger proposals answered 200, ${kept} kept (per-author bound ${FUNDING_PER_AUTHOR_MAX})`);
    assert.ok(kept < N, `every one of ${N} proposals from one stranger (a fresh key each) was kept (${kept})`);
  } finally { try { await seat.close(); } catch { /* closed */ } }
});
