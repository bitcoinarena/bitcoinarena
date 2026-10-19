// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WHAT A PLAYER WON OR LOST IN A PAYING ROUND, AS THIS NODE'S SETTLEMENT SAYS (kanban #187 item 1, plan comment 298, Go
// 2026-10-05). server.js playerBalance: a qualifier's net is its payout less the node fee and its donation; when the
// settlement paid nobody, every stake but a walk-away's comes back, so only the fee and the donation are gone; a loser or
// a walk-away loses the stake; until this node's settlement is ACCEPTED the net is pending. Only the free branch was
// asserted before (dashboard.test.js, through /api/round-result). Each branch here by its numbers, then one paying round
// and one round that paid nobody through /api/round-result itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { playerBalance, serve } from '../src/server.js';
import { openStore } from '../src/store.js';
import { contractFor, b32, opts } from './window-fixture.js';
import { encodeRoundContract, encodeEntryContract, roundId, entryId } from '../../arena-protocol/src/contracts.js';
import { encodePlayerResult, joinSignedResult } from '../../arena-protocol/src/result.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { HOSTED } from './plugins/hosted.js';

const STAKE = 100000n, FEE = 2000n, DONATION = 2000n;
const entry = (more = {}) => ({ stakeMsat: STAKE, feeMsat: FEE, donationMsat: DONATION, ...more });
const ACCEPTED = { state: 'ACCEPTED' };
const best = (outcome, score = 500) => ({ outcome, score, signers: 2 });

test('won: the payout less the fee and the donation; a DELIVERED run under min score is not won', () => {
  assert.deepEqual(playerBalance({ entry: entry(), best: best('DELIVERED', 500), won: { owedMsat: 290000n }, settled: ACCEPTED, nobodyWon: false, minScore: 100 }),
    { result: 'won', netMsat: String(290000n - FEE - DONATION) });
  assert.deepEqual(playerBalance({ entry: entry(), best: best('DELIVERED', 100), won: { owedMsat: 290000n }, settled: ACCEPTED, nobodyWon: false, minScore: 100 }),
    { result: 'won', netMsat: '286000' }, 'exactly min score qualifies');
  assert.deepEqual(playerBalance({ entry: entry(), best: best('DELIVERED', 500), won: null, settled: ACCEPTED, nobodyWon: false, minScore: 100 }),
    { result: 'won', netMsat: '-4000' }, 'qualified with no winnings row held here: the costs only');
  assert.deepEqual(playerBalance({ entry: entry(), best: best('DELIVERED', 99), won: null, settled: ACCEPTED, nobodyWon: false, minScore: 100 }),
    { result: 'lost', netMsat: '-100000' }, 'one under min score while somebody won: the stake is lost');
  assert.deepEqual(playerBalance({ entry: entry({ donationMsat: 0n }), best: best('DELIVERED'), won: { owedMsat: 150000n }, settled: ACCEPTED, nobodyWon: false, minScore: 0 }),
    { result: 'won', netMsat: '148000' }, 'no donation: the fee only');
});

test('nobody won: the stake comes back less the fee and the donation - except a walk-away\'s, which is lost', () => {
  for (const b of [best('FAILED'), best('VOID'), best('DELIVERED', 10)])
    assert.deepEqual(playerBalance({ entry: entry(), best: b, won: null, settled: ACCEPTED, nobodyWon: true, minScore: 100 }),
      { result: 'stake back', netMsat: '-4000' }, b.outcome);
  assert.deepEqual(playerBalance({ entry: entry(), best: best('FORFEIT', 0), won: null, settled: ACCEPTED, nobodyWon: true, minScore: 100 }),
    { result: 'lost', netMsat: '-100000' }, 'a walk-away loses the stake even when nobody won');
  assert.deepEqual(playerBalance({ entry: { stakeMsat: STAKE }, best: best('FAILED'), won: null, settled: ACCEPTED, nobodyWon: true, minScore: 100 }),
    { result: 'stake back', netMsat: '0' }, 'an entry naming no fee or donation: nothing gone');
});

test('somebody won: a loser and a walk-away lose the stake', () => {
  for (const b of [best('FAILED'), best('FORFEIT', 0), best('VOID')])
    assert.deepEqual(playerBalance({ entry: entry(), best: b, won: null, settled: ACCEPTED, nobodyWon: false, minScore: 100 }),
      { result: 'lost', netMsat: '-100000' }, b.outcome);
});

test('pending until this node\'s settlement is ACCEPTED and the run has a result; free is free', () => {
  for (const settled of [null, undefined, { state: 'SUBMITTED' }, { state: 'REFUSED' }, { state: 'accepted' }])
    assert.deepEqual(playerBalance({ entry: entry(), best: best('DELIVERED'), won: { owedMsat: 290000n }, settled, nobodyWon: false, minScore: 0 }),
      { result: 'pending', netMsat: null }, JSON.stringify(settled));
  assert.deepEqual(playerBalance({ entry: entry(), best: null, won: null, settled: ACCEPTED, nobodyWon: false, minScore: 0 }),
    { result: 'pending', netMsat: null }, 'no signed result yet');
  assert.deepEqual(playerBalance({ entry: entry({ stakeMsat: 0n }), best: null, won: null, settled: null, nobodyWon: false, minScore: 0 }),
    { result: 'free', netMsat: '0' });
});

// /api/round-result, the same nets: a round where one player won, and a round whose settlement paid nobody
test('/api/round-result shows each player\'s net as the settlement decided it', async () => {
  const d = await serve(openStore(':memory:'), { plugins: HOSTED, port: 0, ...opts });
  try {
    const round = d.round, db = round.db, me = round.pubkey;
    const make = (n, outcomes, { shares, winner = null }) => {
      const contract = { ...contractFor([me, b32(0x44)], 3000n, ['wss://r.example']), stakeMsat: STAKE, minScore: 100, censusHeight: 900000 + n };
      const rid = roundId(contract);
      db.prepare('INSERT INTO rounds (round_id, contract, state, opened_ms) VALUES (?, ?, 0, ?)').run(rid, encodeRoundContract(contract), 1);
      const eids = outcomes.map(([outcome, score], i) => {
        const e = { roundId: rid, playerPubkey: b32(0x50 + i), sessionPubkey: b32(0x60 + i), stakeCommitment: b32(0x70 + i), stakeMsat: STAKE, feeMsat: FEE,
          donationMsat: DONATION, joinTick: 0, worldSecret: b32(0), vssSharesRef: b32(0x80 + i), stakePoint: Uint8Array.from([2, ...b32(0x90 + i)]),
          feePreimage: b32(0), stakeLockOutpoint: { txid: b32(0xa0 + i), outIdx: 0n }, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) };
        const eid = entryId(e);
        db.prepare('INSERT INTO entries (entry_id, round_id, contract, joined_ms) VALUES (?, ?, ?, ?)').run(eid, rid, encodeEntryContract(e), 1 + i);
        for (const signer of [me, b32(0x44)])
          db.prepare('INSERT INTO results (round_id, entry_id, node_pubkey, result_id, bytes, seen_ms) VALUES (?, ?, ?, ?, ?, ?)').run(rid, eid, signer, b32(0xc0 + i),
            joinSignedResult(encodePlayerResult({ roundId: rid, playerPubkey: e.playerPubkey, outcome, score, transcriptHash: b32(0xb0 + i),
              simCoreHash: contract.simCoreHash, nodePubkey: signer }), new Uint8Array(64)), 2);
        return eid;
      });
      round.putLockSettlement({ roundId: rid, txid: 'ab'.repeat(32), message: b32(1), signature: new Uint8Array(64), state: 'ACCEPTED', why: '' });
      round.putLockSettlementShares(rid, shares);
      if (winner !== null) round.putWinnings({ entryId: eids[winner], roundId: rid, owedMsat: 290000n, state: 'PAID', why: 'paid' });
      return toHex(rid);
    };
    const get = async (rid) => (await (await fetch(`http://127.0.0.1:${d.port}/api/round-result?round=${rid}`)).json()).players
      .map((p) => [p.outcome, p.result, p.netMsat, p.wonMsat]).sort((x, y) => (x[0] < y[0] ? -1 : 1));   // the store's order, not the join's
    const won = make(1, [['DELIVERED', 500], ['FAILED', 200], ['FORFEIT', 0]], { shares: [{ pubkey: b32(0x50), msat: 290000n }], winner: 0 });
    assert.deepEqual(await get(won), [['DELIVERED', 'won', '286000', '290000'], ['FAILED', 'lost', '-100000', '0'], ['FORFEIT', 'lost', '-100000', '0']]);
    const nobody = make(2, [['FAILED', 200], ['DELIVERED', 50], ['FORFEIT', 0]], { shares: [] });
    assert.deepEqual(await get(nobody), [['DELIVERED', 'stake back', '-4000', '0'], ['FAILED', 'stake back', '-4000', '0'], ['FORFEIT', 'lost', '-100000', '0']]);
  } finally { await d.close(); }
});
