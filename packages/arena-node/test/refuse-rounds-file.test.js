// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE OPERATOR'S REFUSE-ROUNDS FILE (2026-10-06, path A): round ids, one per line, that this seat must
// refuse - read again whenever the file changes, at every door, no restart; empty in normal running. Written for the live
// measurement of the REFUSED return (a lock made, then its round refused before the entry, as at 05:31Z). Here, on a locked
// fixture round: the file empty - the round is offered and a never-entered lock is not kept as refused; its id written - the
// next ask keeps it (201) and the entry door refuses the round by name; the file emptied again - the round is offered at once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lockRound } from './lock-round-fixture.js';
import { feldmanGroup } from '../src/curve.js';
import { rand, secretScalar, b32 } from './window-fixture.js';
import { dealHandout, encodeHandout } from '../../arena-protocol/src/handout.js';
import { FIELD, scalarFrom32 } from '../../arena-protocol/src/shares.js';
import { refundKeyOf, lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex } from '../../arena-protocol/src/hash.js';

test('a round id written into the refuse-rounds file is refused at once at every door, and offered again once the file is empty', { timeout: 120000 }, async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'refuse-rounds-')), 'refuse-rounds.txt');
  writeFileSync(file, '');
  const w = await lockRound({ serveOpts: { refuseRoundsFile: file } });
  try {
    const base = (d) => `http://127.0.0.1:${d.port}`;
    const key = rand(32); const e = rand(32);
    const dealt = await dealHandout({ preimage: secretScalar(), signerNodes: w.c.nodes, roundId: w.rid, playerPubkey: key,
      ephemeralSecret: e, ephemeralPubkey: feldmanGroup.pointX(e), coefficients: Array.from({ length: w.needed - 1 }, () => scalarFrom32(rand(32)) % FIELD),
      needed: w.needed, curve: feldmanGroup });
    for (const d of w.nodes) assert.equal((await fetch(`${base(d)}/handout`, { method: 'POST', body: encodeHandout(dealt.handout) })).status, 201);
    const outpoint = { txid: rand(32), outIdx: 0n };
    const fields = { paymentImage: { kind: 'point', bytes: dealt.handout.commitments[0] }, amountMsat: 98000n, claimPk: w.claimPk,
      refundPk: refundKeyOf(key), expiration: w.port.height + 200 };
    await w.port.put(outpoint, fields);
    const hand = () => fetch(`${base(w.a)}/refused-lock?round=${toHex(w.rid)}`, { method: 'POST', body: JSON.stringify({ outpoint: `${toHex(outpoint.txid)}:0`, fields: lockFieldsToJson(fields) }) });
    const entry = encodeEntryContract({ roundId: w.rid, playerPubkey: key, sessionPubkey: b32(4), stakeMsat: w.c.stakeMsat, feeMsat: 2000n, donationMsat: 0n, joinTick: 0,
      stakeCommitment: b32(5), vssSharesRef: b32(6), worldSecret: b32(9), stakePoint: dealt.handout.commitments[0], feePreimage: b32(0),
      stakeLockOutpoint: outpoint, feeLockOutpoint: { txid: b32(0), outIdx: 0n }, claimKeyAttestationRef: b32(0) });
    const before = await hand(); const beforeWhy = await before.text();
    writeFileSync(file, `${toHex(w.rid)}\n`);
    const t0 = Date.now();
    const refused = await hand(); const refusedWhy = await refused.text();
    const ent = await fetch(`${base(w.a)}/entry`, { method: 'POST', body: entry }); const entWhy = await ent.text();
    const tookMs = Date.now() - t0;
    writeFileSync(file, '');
    const after = await hand(); const afterWhy = await after.text();
    console.log('  FACTS:', JSON.stringify({ empty: [before.status, beforeWhy.slice(0, 70)], written: [refused.status, refusedWhy.slice(0, 70)], entry: [ent.status, entWhy.slice(0, 110)], tookMs, emptiedAgain: [after.status, afterWhy.slice(0, 70)] }));
    assert.equal(before.status, 409); assert.match(beforeWhy, /offers that round/);
    assert.equal(refused.status, 201, refusedWhy);
    assert.equal(ent.status, 409); assert.match(entWhy, /entry refused: .*refuse-rounds file/);
    assert.equal(after.status, 409); assert.match(afterWhy, /offers that round/);
  } finally { await w.close(); }
});
