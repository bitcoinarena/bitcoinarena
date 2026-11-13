// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r12 gossip-1: ONE PEER SEAT'S PADDED GET /funding-items ANSWER CROWDS OUT EVERY OTHER SEAT'S SIGNALS. Before a seat decides a funding
// or fee proposal's signal it pulls GET /funding-items from every network seat (server.js fundingBook pull, kanban #1231: "seats decide from the same
// set"). The answers are flattened in seat order and cut at 4096 items in total - so one seat listed before the others that answers 4096 junk items
// (any hex) fills the whole budget, and the signals and fee approvals the honest seats hold are never read. This seat decides on its own rows only:
// two outcomes for one signal period (P4 one of n blocks all, P5).
// SAFE: one peer's answer cannot keep another peer's verifying signal out of the pull.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { schnorr } from '@noble/curves/secp256k1.js';
import { openStore } from '../src/store.js';
import { serve } from '../src/server.js';
import { encodeFundingProposal, fundingProposalId, encodeFundingSignal, fundingSignalId } from '../../arena-protocol/src/funding.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const sk = (n) => { const b = new Uint8Array(32); b[0] = 1; b[30] = n >> 8; b[31] = n & 255; return b; };
const pk = (n) => schnorr.getPublicKey(sk(n));
const hexOf = (bytes, id, n) => toHex(Uint8Array.from([...bytes, ...schnorr.sign(id, sk(n))]));
const P = { networkId: new Uint8Array(32).fill(7), author: pk(1), publishedHeight: 156800, amountSats: 250000n, lnurl: 'dev@bitcoin-arena.io', purpose: 'A second relay' };
const PID = toHex(fundingProposalId(P));
const signalHex = (n) => { const s = { proposalId: fundingProposalId(P), node: pk(n), atHeight: 156850 }; return hexOf(encodeFundingSignal(s), fundingSignalId(s), n); };
const listen = (handler) => new Promise((r) => { const s = http.createServer(handler); s.listen(0, '127.0.0.1', () => r(s)); });

test('one peer seat answering 4096 junk funding items does not keep the honest seats\' signals out of the pull before a decision', async () => {
  const honest = signalHex(5);
  let askedM = 0, askedH = 0;
  // THE ATTACKER'S SEAT M (listed first): 4096 items that only look like signals
  const M = await listen((req, res) => { if (req.url.startsWith('/funding-items')) { askedM++; res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ proposal: PID, items: Array.from({ length: 4096 }, () => ({ kind: 'signal', hex: '00', atMs: '1' })) })); } res.statusCode = 404; res.end(); });
  // AN HONEST SEAT H: the one signal it holds
  const H = await listen((req, res) => { if (req.url.startsWith('/funding-items')) { askedH++; res.setHeader('content-type', 'application/json');
    return res.end(JSON.stringify({ proposal: PID, items: [{ kind: 'signal', hex: honest, atMs: '1' }] })); } res.statusCode = 404; res.end(); });
  const tip = P.publishedHeight + 1008 + 20;
  const seat = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, chainTip: async () => tip,
    peers: [`http://127.0.0.1:${M.address().port}`, `http://127.0.0.1:${H.address().port}`] });
  try {
    assert.ok(seat.funding, 'the seat keeps funding proposals');
    const r = await seat.funding.add('proposal', hexOf(encodeFundingProposal(P), fundingProposalId(P), 1));
    assert.ok(r.ok, `the proposal is taken: ${r.why}`);
    await seat.funding.decide();
    assert.ok(askedM > 0 && askedH > 0, 'both seats were asked');
    const held = seat.funding.itemsOf(PID).map((x) => x.hex);
    console.log(`  CROWDED OUT: M asked ${askedM}x, H asked ${askedH}x; this seat holds ${held.length} signal(s) after the pull`);
    assert.ok(held.includes(honest), 'the honest seat\'s signal was dropped: one peer\'s 4096 junk items used the whole pull budget');
  } finally {
    try { seat.http.close(); seat.wss && seat.wss.close(); } catch { /* closed */ }
    M.close(); H.close();
  }
});
