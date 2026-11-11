// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 (attack audit, entry doors): AN ENTRY IS NOT SIGNED BY ITS PLAYER AND A LOCK IS NOT BOUND TO ITS ENTRY ID. Anyone who sees a
// player's entry (any HTTP peer reading the seats, or one seat it was posted to) copies it with a session key of their own and posts that copy and
// the player's own stake lock fields (all public or derivable: stake point, net stake, claim key, refund key of the player key, expiration) to the
// seats before the player's /lock lands. The first lock wins the outpoint, so the player's real entry is never staked, and the copy - whose session
// key the attacker holds - is the entry the player's money backs: the attacker plays it and names its own payout address for it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489-1 a copy of a player\'s entry under another session key cannot take that player\'s stake lock', async () => {
  const w = await lockRound({});
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // the honest player's entry reaches every seat; its locks are on their way (not handed yet)
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true });
    // THE ATTACKER: the same entry, its own session key
    const attackerSession = ed25519.utils.randomSecretKey();
    const copy = { ...victim.entry, sessionPubkey: ed25519.getPublicKey(attackerSession) };
    const copyId = entryId(copy);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(victim.entry.feePreimage) }, amountMsat: victim.entry.feeMsat,
      claimPk: victim.fields.claimPk, refundPk: victim.fields.refundPk, expiration: victim.fields.expiration };
    const out = [];
    for (const d of w.nodes) {
      const base = `http://127.0.0.1:${d.port}`;
      const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) });
      const l = await fetch(`${base}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      const f = await fetch(`${base}/fee-lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) });
      const signed = new TextEncoder().encode('attacker@pay.example');
      const a = await fetch(`${base}/payout-address?entry=${toHex(copyId)}`, { method: 'POST', body: Buffer.concat([Buffer.from(signed), Buffer.from(ed25519.sign(signed, attackerSession))]) });
      out.push({ entry: e.status, lock: l.status, fee: f.status, address: a.status });
      await e.text(); await l.text(); await f.text(); await a.text();
    }
    // now the honest player's own lock arrives
    const mine = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      mine.push({ status: r.status, why: (await r.text()).slice(0, 160) });
    }
    const seen = w.nodes.map((d) => ({ victim: !!d.round.stakeSeen(victim.eid), copy: !!d.round.stakeSeen(copyId) }));
    console.log('  FACTS #1489-1:', JSON.stringify({ attacker: out, victimLock: mine, stakeSeen: seen }));
    for (const s of seen) assert.equal(s.copy, false, 'the player\'s stake lock now backs an entry whose session key the attacker holds (and whose payout address the attacker named)');
    for (const m of mine) assert.equal(m.status, 201, `the player's own lock was refused: ${m.why}`);
  } finally { await w.close(); }
});
