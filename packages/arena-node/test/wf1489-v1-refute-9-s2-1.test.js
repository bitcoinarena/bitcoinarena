// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #1489 refute (fix:entry:1, skeptic 2, after 05194518e): the newer fix hands a lock to the entry "any seat of the round took earliest",
// comparing joined_ms values that each seat read off ITS OWN clock (GET /lock-namer joinedMs vs this seat's local joined_ms). Two HONEST seats
// whose clocks differ by 1.5 s: the page posts to its own seat 0 first (joinOn), a stranger reads the entry there and posts a copy under his
// own session key to seat 1, whose clock is behind. Seat 1's joined_ms for the copy is EARLIER than seat 0's for the player's entry, so
// both honest seats now hand the player's lock to the copy - and refuse the player's own lock. Before 05194518e seat 0 at least kept it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { encodeEntryContract, decodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';

const player = (name, n) => ({ name, key: b32(n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });

test('#1489 refute-9-s2-1: honest seats 1.5 s apart - a stranger\'s copy at the slower seat takes the player\'s lock at every seat', async () => {
  const w = await lockRound({ endMs: Math.max(testNow(), Date.now()) + 600000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 3000);
    // seat 1's clock runs 1.5 s behind seat 0's (an honest seat, NTP off by a little)
    const base1 = w.nodes[1].round.now.bind(w.nodes[1].round);
    w.nodes[1].round.now = () => Number(base1()) - 1500;
    const victim = await lockAndPlay(w, player('victim', 0x61), { only: [], noMarks: true, unreached: [1] });
    const s0 = `http://127.0.0.1:${w.nodes[0].port}`, s1 = `http://127.0.0.1:${w.nodes[1].port}`;
    // THE STRANGER: reads seat 0's public doors only
    const bytes = new Uint8Array(await (await fetch(`${s0}/entry?id=${toHex(victim.eid)}`)).arrayBuffer());
    const seen = decodeEntryContract(bytes);
    const handout = new Uint8Array(await (await fetch(`${s0}/handout?id=${toHex(seen.vssSharesRef)}`)).arrayBuffer());
    const copy = { ...seen, sessionPubkey: ed25519.getPublicKey(ed25519.utils.randomSecretKey()) };
    const copyId = entryId(copy);
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(seen.feePreimage) }, amountMsat: seen.feeMsat,
      claimPk: victim.fields.claimPk, refundPk: victim.fields.refundPk, expiration: victim.fields.expiration };
    const attacker = [];
    for (const base of [s1, s0]) {
      if (base === s1) { const h = await fetch(`${base}/handout`, { method: 'POST', body: handout }); await h.text(); }
      const e = await fetch(`${base}/entry`, { method: 'POST', body: encodeEntryContract(copy) }); await e.text();
      const l = await fetch(`${base}/lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      const lw = (await l.text()).slice(0, 120);
      const f = await fetch(`${base}/fee-lock?entry=${toHex(copyId)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeFields)) }); await f.text();
      attacker.push({ entry: e.status, lock: l.status, lw, fee: f.status });
    }
    // the page goes on: its entry to seat 1, then its locks to every seat
    const join1 = await fetch(`${s1}/entry`, { method: 'POST', body: encodeEntryContract(victim.entry) }); await join1.text();
    const mine = [];
    for (const d of w.nodes) {
      const r = await fetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(victim.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(victim.fields)) });
      mine.push({ status: r.status, why: (await r.text()).slice(0, 140) });
    }
    const staked = w.nodes.map((d) => ({ victimLock: !!d.round.stakeLock(victim.eid), copyLock: !!d.round.stakeLock(copyId) }));
    console.log('  FACTS refute-9-s2-1:', JSON.stringify({ attacker, victimJoin1: join1.status, victimLock: mine, staked }));
    for (const [i, s] of staked.entries()) assert.equal(s.copyLock, false, `honest seat ${i} staked the stranger's copy with the player's lock`);
    for (const m of mine) assert.equal(m.status, 201, `the player's own lock was refused: ${m.why}`);
  } finally { await w.close(); }
});
