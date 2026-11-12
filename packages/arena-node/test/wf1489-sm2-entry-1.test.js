// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-find-entry 1 (state machine audit, entry): A LOCK WHOSE RETURN THE SEATS SIGNED STILL STAKES AN ENTRY. A round a seat refuses
// (a paused market waiting for its reserve key, the operator's refuse-rounds file, a config not live) flips back to offered by itself. A player
// who dealt the handout while it was offered, locked, and was refused at /entry hands the lock to /refused-lock; the committee signs its forfeit
// (lock fate RETURNING at every seat) and the player holds a Cancel signature for it. When the refusal lifts, the page's lock record is still
// "accepted" and it is reused: the same entry posted again is taken and POST /lock verifies the very lock the seats signed back - verifyStakeLock
// reads neither refused_locks, nor forfeits, nor lock_fates. The entry plays with a stake its player can take back at any moment: a loser cancels
// the lock before the settlement (whose transaction then spends a gone input - every player's payout waits), and every seat that signed the forfeit
// refuses to CLAIM it anyway (fate RETURNING), so the round's settlement never forms.
// Safe behaviour: a lock this seat holds a forfeit of (or kept as refused / fated RETURNING) never stakes an entry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { encodeHandout } from '../../arena-protocol/src/handout.js';
import { lockFieldsToJson } from '../../arena-protocol/src/stake-lock.js';
import { encodeEntryContract } from '../../arena-protocol/src/contracts.js';
import { toHex, fromHex } from '../../arena-protocol/src/hash.js';
import { attempt } from './wf1489-sm2-entry-fixture.js';

const base = (d) => `http://127.0.0.1:${d.port}`;
const post = async (url, body) => { const r = await fetch(url, { method: 'POST', body }); return [r.status, (await r.text()).slice(0, 140)]; };

test('#1489 sm2-entry-1 a stake lock whose forfeit the seats signed (refused round) does not stake the entry once the round is offered again', { timeout: 120000 }, async () => {
  const refusing = { why: null };
  const w = await lockRound({ serveOpts: { refusedFor: () => refusing.why, unenteredGraceMs: 1e12 } });
  try {
    const who = { name: 'returned', key: b32(0x71), worldSecret: b32(0), ticks: 1000 };
    const a = await attempt(w, who);
    // 1. THE ROUND OFFERED: the page is dealt its handout and locks
    for (const d of w.nodes) assert.deepEqual((await post(`${base(d)}/handout`, encodeHandout(a.handout)))[0], 201);
    // 2. THE SEATS PAUSE IT (e.g. its federation's reserve key not found yet): the entry is refused, the page hands the lock back
    refusing.why = 'test: paused - this market pays the protocol reserve and its federation has no reserve key yet';
    const refusedEntry = [];
    for (const d of w.nodes) refusedEntry.push(await post(`${base(d)}/entry`, encodeEntryContract(a.entry)));
    const kept = [];
    for (const d of w.nodes) kept.push(await post(`${base(d)}/refused-lock?round=${toHex(w.rid)}`,
      JSON.stringify({ outpoint: `${toHex(a.outpoint.txid)}:0`, fields: lockFieldsToJson(a.fields) })));
    const f = await fetch(`${base(w.a)}/forfeit?round=${toHex(w.rid)}&entry=${toHex(a.hid)}`);
    const fj = f.status === 200 ? await f.json() : { why: await f.text() };
    const verifies = !!fj.signature && schnorr.verify(fromHex(fj.signature), fromHex(fj.contractId), w.claimPk.subarray(1));
    // 3. THE PAUSE LIFTS (the reserve key stands): the page's lock record is accepted, so the same entry and the same locks go out again
    refusing.why = null;
    const again = [];
    for (const d of w.nodes) {
      const e = await post(`${base(d)}/entry`, encodeEntryContract(a.entry));
      const l = await post(`${base(d)}/lock?entry=${toHex(a.eid)}`, JSON.stringify(lockFieldsToJson(a.fields)));
      const fl = await post(`${base(d)}/fee-lock?entry=${toHex(a.eid)}`, JSON.stringify(lockFieldsToJson(a.feeFields)));
      again.push({ entry: e, lock: l, fee: fl });
    }
    const op = `${toHex(a.outpoint.txid)}:0`;
    const state = w.nodes.map((d) => ({ forfeitKept: !!d.round.forfeit(a.hid), fate: d.round.lockFate(op) && d.round.lockFate(op).state,
      stakeLock: !!d.round.stakeLock(a.eid), stakeSeen: !!d.round.stakeSeen(a.eid) }));
    console.log('  FACTS sm2-entry-1:', JSON.stringify({ refusedEntry, kept, forfeit: [f.status, verifies, String(fj.why || '').slice(0, 100)], again, state }));
    for (const [s, why] of kept) assert.equal(s, 201, why);
    assert.equal(f.status, 200, fj.why);
    assert.equal(verifies, true, 'the forfeit does not verify');
    for (const s of state)
      assert.ok(!(s.stakeSeen || s.stakeLock) || !(s.forfeitKept || s.fate === 'RETURNING'),
        `a seat stakes the entry on a lock whose return it signed (fate ${s.fate}, forfeit kept ${s.forfeitKept}): the player holds a Cancel of a stake that is playing`);
  } finally { await w.close(); }
});
