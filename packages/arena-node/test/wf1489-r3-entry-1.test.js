// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// WF1489 R3 ENTRY 1: a market's plain pick takes its stake lock at any time - after the entry close and even after the outcome is attested
// at the seat. #1260 closed the late lock for relayed (game) rounds and #1150 for orders; lockAfterCloseRefusal skips every attested round
// (relayedRound answers null for a market) and orderLockAfterClose answers only for an order. So a player enters a pick at every seat before
// the close with its locks made in the federation but handed nowhere, waits for the outcome, and hands them over only if the pick won (the
// settlement counts every stake-seen pick, settlement.js #attestedPlan); a losing pick's locks are never handed and expire back. A free option
// paid by the honest pickers. Safe: a lock new to the seat after the market's entry close is refused, as for orders and game rounds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 as b32w, LOSER } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { attestorSign } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { MARKET } from './plugins/market/index.js';
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32w(0), configHash: b32w(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32w(0x40 + n), worldSecret: b32w(0) });
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });

test('wf1489-r3-entry-1: a market pick\'s locks handed only after the outcome is attested are refused (no free option)', async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { entryCloseGraceMs: ENTRY_CLOSE_GRACE_MS, plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    // an honest pick of outcome 1, staked at both seats; the attacker's pick of outcome 0 entered at both seats, locks made but handed nowhere
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    const held = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, only: [] });
    await closeRound(w);
    const at = w.c.entryCloseMs + 1n;
    const posted = await Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(w.rid)}`,
      { method: 'POST', body: encodeAttestation(signedBy({ roundId: w.rid, outcome: 0, observedAtMs: at }, [A0, A2])) })).status));
    const attested = w.nodes.map((d) => d.round.outcomeAttestations(w.rid).length);
    // outcome 0 won: now the attacker hands the stake and fee locks over
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(held.entry.feePreimage) }, amountMsat: held.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(held.entry.playerPubkey), expiration: held.fields.expiration };
    const answers = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const s = await fetch(`${base}/lock?entry=${toHex(held.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(held.fields)) });
      const f = held.entry.feeMsat > 0n ? await fetch(`${base}/fee-lock?entry=${toHex(held.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) }) : null;
      answers.push({ stake: `${s.status} ${(await s.text()).slice(0, 140)}`, fee: f ? `${f.status} ${(await f.text()).slice(0, 140)}` : null,
        stakeSeen: !!d.round.stakeSeen(held.eid) });
    }
    console.log('  FACTS wf1489-r3-entry-1:', JSON.stringify({ nowMinusCloseMs: Number(BigInt(w.nodes[0].round.now()) - w.c.entryCloseMs), posted, attested, answers }));
    assert.ok(attested.every((n) => n > 0), 'the fixture: the outcome is attested at every seat before the locks come');
    for (const a of answers) {
      assert.match(a.stake, /^409/, `a stake lock new to the seat after the market closed and its outcome was attested was taken: ${a.stake}`);
      assert.equal(a.stakeSeen, false, 'the late pick\'s stake is counted in the market\'s pool');
    }
  } finally { await w.close(); }
});
