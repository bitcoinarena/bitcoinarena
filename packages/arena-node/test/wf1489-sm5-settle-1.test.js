// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm5-settle-1: A SETTLED ROUND'S SENDS ARE DRIVEN AGAINST A REBUILD, NOT AGAINST THE TRANSACTION THAT LANDED.
// settlement.js sendWinnings (the winnings sweep, and settle() on an ACCEPTED row) hands winnings-send.js sendAll `this.message(rid)` - a fresh
// rebuild of the settlement from the store and this process's memory - and sendAll/contractOf take attempt 0's contract at `built.txid`. Nothing
// ties that rebuild to the txid the round's row is ACCEPTED on. A seat restarted (built, byPlan and the fee cache are memory) rebuilds under what
// it reads now - here the guardians' fee rule, read again after the restart (the case take() names: "after a fee-rule change across a restart") -
// and every later send of the round is signed and handed to the gateway for an outpoint of a transaction that never existed, or not driven at all.
// The walk-away's donation shares, still unpaid at the restart (their gateway was down), are never paid from the contracts that landed; those
// expire to the committee's key, and contractFate reads the made-up contract as NEVER, so no re-send ever starts either.
// Safe: after the restart every gateway ask names an output of the ACCEPTED txid, and every donation share is PAID once the gateway is back.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockPort, TWO_GATEWAYS } from './lock-fixture.js';
import { lockRound, lockAndPlay, closeRound, untilSettled, proposerOf } from './lock-round-fixture.js';
import { LOSER, b32, wait } from './window-fixture.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { TEST_DONATION_SET_REGTEST } from '../../arena-protocol/src/test-donation-sets.js';
import { lowestLiveGateway } from '../../arena-protocol/src/winnings-send.js';

const WALKER = { ...LOSER, name: 'walker', key: b32(0x21) };

async function restartAndPay(feeRule) {
  const port = lockPort();
  const first = lowestLiveGateway(TWO_GATEWAYS);
  port.gatewayDown = first.url;
  const w = await lockRound({ port, serveOpts: { doorSweepMs: 250, winningsEveryMs: 300, donationSets: [TEST_DONATION_SET_REGTEST] } });
  try {
    await lockAndPlay(w, WALKER, { noMarks: true });
    await closeRound(w);
    const st = await untilSettled(w, 90000);
    assert.equal(st.state, 'ACCEPTED', st.why);
    const p = proposerOf(w);
    const sends = () => p.round.sendPlansOf(w.rid).filter((r) => r.donation);
    await wait(1500);
    assert.ok(sends().length > 0 && sends().every((r) => r.state !== 'PAID'), 'the shares were paid through a gateway that is down');
    const landed = p.round.lockSettlement(w.rid);
    assert.equal(landed.state, 'ACCEPTED');
    assert.ok(port.accepted.has(landed.txid), 'the row is not ACCEPTED on a transaction the federation took');

    // THE PROPOSER RESTARTS: what LockSettlement keeps in memory only (the built settlement, the plan fingerprint, the fee rule read once per round)
    // is gone; the store - row ACCEPTED, send rows SENDING - is as it was. The guardians' fee rule is read again, and it is not the one read at the close.
    for (const m of ['built', 'byPlan', 'fees', 'summaries']) p.settlements[m].clear();
    if (feeRule) port.feeRule = feeRule;
    // the gateway answers again; every authorised ask is noted with the outpoint it is told to pay from
    const asked = [];
    const send = port.send.bind(port);
    port.send = async (a) => { if (a.auth && a.outpoint) asked.push(`${toHex(a.outpoint.txid)}:${a.outpoint.outIdx}`); return send(a); };
    port.gatewayDown = null;

    let after = [];
    for (const stop = Date.now() + 20000; Date.now() < stop; await wait(250)) {
      after = sends();
      if (after.every((r) => r.state === 'PAID')) break;
    }
    const rebuilt = await p.settlements.message(w.rid);
    console.log('  MEASURED sm5-settle-1:', JSON.stringify({ landed: landed.txid.slice(0, 12), rebuilt: rebuilt.ok ? rebuilt.txid.slice(0, 12) : rebuilt.why,
      asked: asked.map((o) => o.slice(0, 12) + o.slice(64)), held: asked.map((o) => port.locks.has(o) || port.claimedSends.has(o)),
      sends: after.map((r) => [r.attempt, r.state, String(r.txid || '').slice(0, 12)]) }));
    for (const o of asked) assert.equal(o.slice(0, 64), landed.txid, `the gateway was asked to pay from ${o.slice(0, 16)}…, an output of no transaction the federation took (the row is ACCEPTED on ${landed.txid.slice(0, 16)}…)`);
    for (const r of after) if (r.txid) assert.equal(r.txid, landed.txid, `a send row records contract txid ${String(r.txid).slice(0, 16)}…, not the landed ${landed.txid.slice(0, 16)}…`);
    assert.ok(after.every((r) => r.state === 'PAID'), `the donation shares were never paid after the restart: ${JSON.stringify(after.map((r) => r.state))}`);
  } finally { await w.close(); }
}

// THE CONTROL: the same restart with the fee rule unchanged - the rebuild is the landed txid, and the shares are paid (passes on f64efd1bb)
test('wf1489 sm5-settle-1 control: a restart that rebuilds the same bytes pays the shares', () => restartAndPay(null));

test('wf1489 sm5-settle-1: after a restart the donation sends of an ACCEPTED round are asked against the landed txid and paid', () => restartAndPay({ ppm: 1000n, baseMsat: 0n }));
