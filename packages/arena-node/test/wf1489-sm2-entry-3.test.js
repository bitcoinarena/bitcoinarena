// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-entry-3 (state machine audit, entry): ONE PLAYER KEY'S STAKE AND FEE LOCKS SPLIT OVER TWO ENTRIES, AND NEITHER EVER COUNTS.
// #1215 holds "one player key stakes one entry" per kind: verifyStakeLock refuses a stake lock while another entry of the key holds a STAKE lock,
// verifyFeeLock a fee lock while another holds a FEE lock - never across the kinds. A page whose first PLAY's stake lock reached a seat and whose
// fee lock did not (a reload in between; the player key is the phrase's for the round, join.js playerFor) PLAYs again: a new entry B under the
// same key with a new lock transaction. At that seat B's fee lock is taken (A holds no fee lock), B's stake lock refused (A holds a stake lock),
// and A's fee lock, resent, refused (B holds a fee lock). Entry A waits for a fee lock forever, entry B for a stake lock: neither is seen, neither
// plays, and both transactions' locks are held - and since the key entered here, /refused-lock never returns them: they wait for their expiry.
// Safe behaviour: a key's stake and fee locks stand on one entry - a lock of either kind is refused while another entry of the key holds either.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { encodeHandout } from '../../arena-protocol/src/handout.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { attempt } from './wf1489-sm2-entry-fixture.js';

const base = (d) => `http://127.0.0.1:${d.port}`;
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', body }); return [r.status, (await r.text()).slice(0, 160)]; };

test('#1489 sm2-entry-3 a player key\'s stake lock and fee lock never stand on two different entries', { timeout: 120000 }, async () => {
  const w = await lockRound({});
  try {
    const who = { name: 'reloaded', key: b32(0x73), worldSecret: b32(0), ticks: 1000 };
    const A = await attempt(w, who), B = await attempt(w, who);
    const said = [];
    for (const d of w.nodes) {
      const s = {};
      // PLAY 1: handout, entry, stake lock - the page reloads before its fee lock goes out
      s.hA = (await post(`${base(d)}/handout`, encodeHandout(A.handout)))[0];
      s.eA = (await post(`${base(d)}/entry`, encodeEntryContract(A.entry)))[0];
      s.lockA = await post(`${base(d)}/lock?entry=${toHex(A.eid)}`, JSON.stringify(lockFieldsToJson(A.fields)));
      // PLAY 2 after the reload: a new handout, entry and lock transaction under the same player key; its fee lock lands first
      s.hB = (await post(`${base(d)}/handout`, encodeHandout(B.handout)))[0];
      s.eB = (await post(`${base(d)}/entry`, encodeEntryContract(B.entry)))[0];
      s.feeB = await post(`${base(d)}/fee-lock?entry=${toHex(B.eid)}`, JSON.stringify(lockFieldsToJson(B.feeFields)));
      s.lockB = await post(`${base(d)}/lock?entry=${toHex(B.eid)}`, JSON.stringify(lockFieldsToJson(B.fields)));
      // PLAY 1's fee lock, resent
      s.feeA = await post(`${base(d)}/fee-lock?entry=${toHex(A.eid)}`, JSON.stringify(lockFieldsToJson(A.feeFields)));
      said.push(s);
    }
    const state = w.nodes.map((d) => ({ A: { stake: !!d.round.stakeLock(A.eid), fee: !!d.round.feeLock(A.eid), seen: !!d.round.stakeSeen(A.eid) },
      B: { stake: !!d.round.stakeLock(B.eid), fee: !!d.round.feeLock(B.eid), seen: !!d.round.stakeSeen(B.eid) } }));
    console.log('  FACTS sm2-entry-3:', JSON.stringify({ said, state }));
    for (const s of state) {
      const split = (s.A.stake && s.B.fee) || (s.B.stake && s.A.fee);
      assert.ok(!split, `the key's stake lock stands on one entry and its fee lock on another: ${JSON.stringify(s)} - neither entry is ever seen`);
    }
  } finally { await w.close(); }
});
