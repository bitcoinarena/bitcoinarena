// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r11-find-entry 1 (attack audit, P7): A PLAYER LEFT OUTSIDE THE SEATS OF A PAYING HEAD-TO-HEAD ROUND GETS HIS STAKE BACK AT
// SETTLEMENT (#1582, forfeit.js #outsideTheSeats) - BUT NOT HIS FEE LOCK. Every valid lock is kept (#1588) and the seats are the first
// entries; the last one is signed VOID and its fee lock is never claimed (lock-settlement.js: a VOID entry's fee lock is not claimed). Its
// return door (GET /forfeit?lock=fee) opens only for a cancelled order, a refunded market or a protocol-27 ENTRY_VOID - so the fee of a
// round the player never played waits for the lock's expiry (144 blocks live), while its stake came back at once.
// Safe behaviour: the fee lock of an entry that got no seat comes back with its stake, once the settlement is ACCEPTED without claiming it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const GRACE = 60000;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

const reveal = async (w, played, move, s) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });
  return r.status;
}));
const seated = (w) => w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).map(({ entryId }) => toHex(entryId).slice(0, 8)).sort());

test('#1489 r11-entry-1 the fee lock of a head-to-head entry left outside the seats comes back with its stake', { timeout: 120000 }, async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], unenteredGraceMs: GRACE }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const base = (d) => `http://127.0.0.1:${d.port}`;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const s1 = salt(), s2 = salt(), s3 = salt();
    const c = await lockAndPlay(w, mk(3), { hidden: { move: SCISSORS, salt: s3 }, noMarks: true, only: [] });
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: s1 }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: s2 }, noMarks: true });
    const feeOf = (p, who) => ({ paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(who.key), expiration: p.fields.expiration });
    await w.port.put(c.feeOutpoint, feeOf(c, mk(3)));
    for (const d of w.nodes) {
      await fetch(`${base(d)}/lock?entry=${toHex(c.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(c.fields)) });
      await fetch(`${base(d)}/fee-lock?entry=${toHex(c.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(feeOf(c, mk(3)))) });
    }
    const short = (p) => toHex(p.eid).slice(0, 8);
    // kanban #2536: 1.9 seats a paying head-to-head round's lock-backed entries with the LOWEST ENTRY IDS (#2538), not the first taken - the
    // player outside the seats is the one with the highest id of the three
    const byId = [a, b, c].sort((x, y) => (toHex(x.eid) < toHex(y.eid) ? -1 : 1));
    const out = byId[2];
    for (const per of seated(w)) assert.deepEqual(per, [short(byId[0]), short(byId[1])].sort(), 'the seats are the two lowest entry ids');
    const bFee = w.nodes.map((d) => !!(d.round.feeLock && d.round.feeLock(out.eid)));
    assert.ok(bFee.every(Boolean), `the outside player's fee lock is held at every seat: ${JSON.stringify(bFee)}`);
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, s1); await reveal(w, b, SCISSORS, s2); await reveal(w, c, SCISSORS, s3);
    await closeRound(w);
    const settled = await untilSettled(w);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    const st = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(out.eid)}`);
    const stWhy = st.status === 200 ? 'signed' : (await st.text()).slice(0, 200);
    const fe = await fetch(`${base(w.nodes[0])}/forfeit?round=${toHex(w.rid)}&entry=${toHex(out.eid)}&lock=fee`);
    const feWhy = fe.status === 200 ? 'signed' : (await fe.text()).slice(0, 300);
    console.log('  FACTS r11-entry-1:', JSON.stringify({ settled: settled.state, stake: [st.status, stWhy], fee: [fe.status, feWhy] }));
    assert.equal(st.status, 200, `the stake outside the seats comes back (#1582): ${stWhy}`);
    assert.equal(fe.status, 200, `the stake came back at settlement, but the fee lock of the round he never played waits for its expiry: ${fe.status} (${feWhy})`);
  } finally { await w.close(); }
});
