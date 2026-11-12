// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute (fix:entry:1, b995ac717): "first entry naming the outpoint" is read PER ROUND (Round.firstEntryNamingLock filters
// round_id), while "one lock is one entry" (stakeLockAt) is read over every round, and a round's claim key is its seats' DKG key
// (claimKeyOf -> dkg.signerNodeFor(nodes)) - the same key for every round on the same seats. A copy of the player's entry into ANOTHER round
// on the same seats (no shares named) is the first entry naming that outpoint in its round, so the copy is staked with the player's lock and
// the player's own lock in his own round is refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, openLockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489 refute-9-2: a copy into another round on the same seats takes the player\'s stake lock', async () => {
  const w = await lockRound({});
  try {
    const w2 = await openLockRound(w, { minScore: 2 });
    assert.notEqual(toHex(w2.rid), toHex(w.rid));
    assert.equal(toHex(w2.claimPk), toHex(w.claimPk), 'the two rounds on the same seats share one claim key');
    skipTo(Math.max(Number(w.c.committeeTimeMs), Number(w2.c.committeeTimeMs)) + 20);
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true });
    const attackerSession = ed25519.utils.randomSecretKey();
    const out = {};
    for (const shares of ['none', 'same']) {
      const copy = { ...victim.entry, roundId: w2.rid, sessionPubkey: ed25519.getPublicKey(attackerSession),
        ...(shares === 'none' ? { vssSharesRef: new Uint8Array(32) } : {}) };
      const copyId = entryId(copy);
      const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(victim.entry.feePreimage) }, amountMsat: victim.entry.feeMsat,
        claimPk: victim.fields.claimPk, refundPk: victim.fields.refundPk, expiration: victim.fields.expiration };
      out[shares] = [];
      for (const d of w.nodes) {
        const base = `http://127.0.0.1:${d.port}`;
        const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) });
        const ew = (await e.text()).slice(0, 140);
        const l = await fetch(`${base}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
        const lw = (await l.text()).slice(0, 140);
        const f = await fetch(`${base}/fee-lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
        const fw = (await f.text()).slice(0, 140);
        out[shares].push({ entry: e.status, ew, lock: l.status, lw, fee: f.status, fw, copyLock: !!d.round.stakeLock(copyId) });
      }
    }
    const mine = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      mine.push({ status: r.status, why: (await r.text()).slice(0, 140) });
    }
    console.log('  FACTS refute-9-2:', JSON.stringify({ attackerNoShares: out.none, victimLock: mine }));
    for (const k of Object.keys(out)) for (const s of out[k]) assert.equal(s.copyLock, false, `(${k}) the player's stake lock backs a copy in another round`);
    for (const m of mine) assert.equal(m.status, 201, `the player's own lock was refused: ${m.why}`);
  } finally { await w.close(); }
});
