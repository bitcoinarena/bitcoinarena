// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm2-entry-5 (state machine audit, entry): A POOL PICK'S LOCKS ARE TAKEN AFTER ITS MARKET'S OUTCOME IS KNOWN.
// An entry of a pool market moves "entered, no lock" -> "staked" whenever its locks reach /lock and /fee-lock - with no time limit. The pick door
// closes at the entry close (round.js enter) and #1260 shut the lock doors after the close for the relayed rounds only (server.js
// lockAfterCloseRefusal: replayed and head-to-head games), #1150 for orders only (orderLockAfterClose); a plain pick of an attested round is neither.
// So a player posts his pick before the close and holds its locks back: once the outcome is attested (even final), a winning pick's locks are handed
// and verified (stake seen, counted in the settlement's table as a winner, paid out of the losers' stakes); a losing pick's are never handed, and its
// lock expires back to him. A free option on every pool market.
// Safe behaviour: a pool pick's lock new to a seat after its round's entry close is refused, as a relayed round's is.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, LOSER, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { attestorSign } from './plugins/sign.js';
import { encodeAttestation } from '../../arena-protocol/src/attested.js';
import { TEST_DONATION_SET_KEYS_REGTEST } from '../../arena-protocol/src/test-donation-set-keys-regtest.js';
import { donationSetId } from '../../arena-protocol/src/donation.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { MARKET } from './plugins/market/index.js';

const NETWORK = TEST_DONATION_SET_KEYS_REGTEST.recipients;
const STAKE = 1_000_000n;
const ROUND = { gameId: MARKET.registration.gameId, simCoreHash: b32(0), configHash: b32(0), donationSetId: donationSetId(NETWORK), entryCloseMs: 60000n };
const [A0, , A2] = MARKET.attestors;
const player = (n) => ({ ...LOSER, name: `p${n}`, key: b32(0x40 + n), worldSecret: b32(0) });
const signedBy = (body, by) => ({ ...body, signatures: by.map((a) => attestorSign(a, body)) });
const post = async (d, rid, a) => { const r = await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`, { method: 'POST', body: encodeAttestation(a) }); return r.status; };
const outcome = async (d, rid) => (await fetch(`http://127.0.0.1:${d.port}/outcome?round=${toHex(rid)}`)).json();
const hand = async (d, door, eid, fields) => { const r = await fetch(`http://127.0.0.1:${d.port}/${door}?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(fields)) });
  return `${r.status} ${(await r.text()).slice(0, 120)}`; };

test('#1489 sm2-entry-5 a pool pick\'s locks handed only after the outcome is final are not taken', { timeout: 120000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST] } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    await lockAndPlay(w, player(0), { noMarks: true, pick: 0 });
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    // the option: a pick of outcome 0 entered at both seats before the close, its locks held back
    const opt = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, only: [] });
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(opt.entry.feePreimage) }, amountMsat: opt.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(opt.entry.playerPubkey), expiration: opt.fields.expiration };
    await w.port.put(opt.feeOutpoint, feeFields);
    await closeRound(w);
    const at = w.c.entryCloseMs + 1n;
    await Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: 0, observedAtMs: at }, [A0, A2]))));
    const o = await outcome(w.a, w.rid);
    skipTo(Number(o.finalAtMs) + 100);
    // outcome 0 is final: the pick won, so now its locks go out
    const said = [];
    for (const d of w.nodes) said.push({ lock: await hand(d, 'lock', opt.eid, opt.fields), fee: await hand(d, 'fee-lock', opt.eid, feeFields) });
    await wait(500);
    const seen = w.nodes.map((d) => !!d.round.stakeSeen(opt.eid));
    // and the settlement the seats then make pays it as a winner
    let got;
    for (const stop = Date.now() + 20000; Date.now() < stop; await wait(250)) {
      got = await (await fetch(`http://127.0.0.1:${w.a.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
      if (got.state === 'ACCEPTED') break;
    }
    const optKey = toHex(refundKeyOf(opt.entry.playerPubkey));
    const paid = ((got.moved && got.moved.payouts) || []).filter((p) => String(p.pk) === optKey).map((p) => String(p.msat));
    console.log('  FACTS sm2-entry-5:', JSON.stringify({ final: (await outcome(w.a, w.rid)).final, entryCloseMs: String(w.c.entryCloseMs), said, seen,
      settlement: got.state, paidToLatePick: paid }));
    assert.deepEqual(seen, [false, false], `a pick's locks handed after its winning outcome was final were taken: ${JSON.stringify(said)}`);
  } finally { await w.close(); }
});
