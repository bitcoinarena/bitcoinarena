// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm4-find-entry 2 (state machine audit, entry): A SECOND TRY'S FEE LOCK IN A REFUSED ROUND IS NEVER RETURNED. Every join deals a
// fresh handout (join.js dealHandout, a random preimage) under the same player key - the round's key from the phrase. A player whose first try
// locked and entered nothing (seats restarting, a refused round) and who taps PLAY again holds two handouts and two lock pairs in the round.
// POST /refused-lock keeps a fee lock (image H(F)) under H(handout id || "fee") of the FIRST handout whose player's refund key it names - not of
// the try it belongs to - and, since kanban #1489, "the first kept lock stands" per handout: the second try's fee lock lands on the first try's
// slot, which holds the first fee lock, and is refused. Its stake comes back at once; its fee lock stays locked until its expiry.
// Safe behaviour: every unentered lock of a refused round is kept for its return, each try's fee lock beside its own stake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('#1489-sm4-entry-2 both tries\' fee locks of one player in a refused round are kept for their return', { timeout: 120000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const key = rand(32);
    const tryOnce = async () => {
      const e = rand(32);
      const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
        ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
        needed: w.needed, curve: feldmanGroup });
      assert.equal(dealt.ok, true, dealt.why);
      for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
      const stake = { txid: rand(32), outIdx: 0n }, fee = { txid: stake.txid, outIdx: 1n };
      const stakeFields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 95000n, claimPk: w.claimPk, refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
      const feeFields = { paymentImage: { kind: 'hash', bytes: rand(32) }, amountMsat: 2000n, claimPk: w.claimPk, refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
      await w.port.put(stake, stakeFields); await w.port.put(fee, feeFields);
      return { stake, fee, stakeFields, feeFields };
    };
    // TWO TRIES, NEITHER ENTERED
    const first = await tryOnce();
    const second = await tryOnce();
    refusing.why = 'test: this signer node refuses the round';
    const hand = (d, at, f) => fetch(`${base(d)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST', body: JSON.stringify({ outpoint: `${toHex(at.txid)}:${at.outIdx}`, fields: lockFieldsToJson(f) }) });
    const said = [];
    for (const t of [first, second]) for (const [at, f, what] of [[t.stake, t.stakeFields, 'stake'], [t.fee, t.feeFields, 'fee']]) {
      for (const d of w.nodes) { const r = await hand(d, at, f); said.push([t === first ? 'first' : 'second', what, r.status, (await r.text()).slice(0, 110)]); }
    }
    const listed = await (await fetch(`${base(w.a)}/stake-lock?round=${toHex(w.rid)}&refund=${toHex(refundKeyOf(key))}`)).json();
    const outs = listed.map((l) => l.outpoint);
    console.log('  FACTS #1489-sm4-entry-2:', JSON.stringify({ said, listed: outs.map((o) => o.slice(0, 12) + o.slice(-2)) }));
    for (const [which, what, s, why] of said) assert.equal(s, 201, `the ${which} try's ${what} lock, never entered, of a refused round is not kept for its return: ${why}`);
    assert.ok(outs.includes(`${toHex(second.fee.txid)}:1`), 'the second try\'s fee lock is not listed for its return');
  } finally { await w.close(); }
});
