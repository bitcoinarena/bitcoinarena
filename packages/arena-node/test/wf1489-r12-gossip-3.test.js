// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12 gossip-3: POST /funding KEEPS AND GOSSIPS UNBOUNDED STRANGER-MINTED PROPOSALS. "Anyone may propose" (funding-book.js add): a
// funding proposal, a leaderboard payout request, a fee proposal, a comment or a player name signed by any key is stored in funding_items for good and,
// fresh, forwarded to every network seat (server.js forwardFunding) - with no bound per author, per kind or in total. One stranger key mints proposals
// that differ only in their amount; every seat keeps every one, serves them all in GET /funding, and walks each one in every decide()/voteRound() pass
// (a leaderboard request reads up to 64 vote blocks a pass from the chain each) - the same shape as #1927 (referral names), on another door (P5).
// SAFE: one stranger key cannot grow a seat's kept funding proposals without bound.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeFundingProposal, fundingProposalId } from '../../arena-protocol/src/funding.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const SK = new Uint8Array(32).fill(9);
const N = 5000;

test('one stranger key cannot make a seat keep 5000 funding proposals', { timeout: 240000 }, async () => {
  const seat = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0 });
  try {
    const url = `http://127.0.0.1:${seat.http.address().port}`;
    let ok = 0;
    for (let i = 0; i < N; i++) {
      const P = { networkId: new Uint8Array(32).fill(7), author: schnorr.getPublicKey(SK), publishedHeight: 1, amountSats: BigInt(1 + i), lnurl: 'x@example.com', purpose: `spam ${i}` };
      const hex = toHex(Uint8Array.from([...encodeFundingProposal(P), ...schnorr.sign(fundingProposalId(P), SK)]));
      const r = await fetch(`${url}/funding`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'proposal', hex }) });
      if (r.status === 200) ok++;
      await r.arrayBuffer();
    }
    const kept = seat.funding.list().length;
    console.log(`  UNBOUNDED: ${ok} of ${N} stranger proposals answered 200, ${kept} kept`);
    assert.ok(kept < N, `every one of ${N} proposals from one stranger key was kept (${kept})`);
  } finally { try { await seat.close(); } catch { /* closed */ } }
});
