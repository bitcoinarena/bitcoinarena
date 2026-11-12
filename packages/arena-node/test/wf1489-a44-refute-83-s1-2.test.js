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
import { b32, LOSER, wait, say } from './window-fixture.js';
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


// REFUTE #1793 (variant 2, another door / another party): the fix lives at POST /lock and POST /fee-lock only. A seat that holds a plain pick
// without its stake seen pulls the locks from its peers at every close, a resumed one too (pullPickLocks -> takeEntryParts, kanban #1790), and
// that path checks neither the entry close nor the outcome this seat holds. One lax or colluding seat (here: a seat run without the grace rule)
// takes the late locks after the close + grace (the price at the close public); the honest seat refuses them at its own door, then pulls them
// from that peer at the round's close and counts the late pick as staked - it is paid as a winner.
test('#1489 a44-refute-83-2 a seat does not pull a pool pick\'s late locks from a peer', { timeout: 120000 }, async () => {
  const w = await lockRound({ stakeMsat: STAKE, round: ROUND, endMs: testNow() + 900000,
    serveOpts: { plugins: [NEXTBLOCK, MARKET.registration], donationSets: [TEST_DONATION_SET_KEYS_REGTEST], entryCloseGraceMs: 15000 } });
  skipTo(Number(w.c.committeeTimeMs) + 100);
  try {
    await lockAndPlay(w, player(0), { noMarks: true, pick: 0 });
    await lockAndPlay(w, player(1), { noMarks: true, pick: 1 });
    const opt = await lockAndPlay(w, player(2), { noMarks: true, pick: 0, only: [] });
    const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(opt.entry.feePreimage) }, amountMsat: opt.entry.feeMsat, claimPk: w.claimPk,
      refundPk: refundKeyOf(opt.entry.playerPubkey), expiration: opt.fields.expiration };
    await w.port.put(opt.feeOutpoint, feeFields);
    const [lax, honest] = w.nodes;
    lax.round.entryCloseGraceMs = null;   // the lax / colluding seat: it takes a lock new to it whatever the clock says
    // 20 s past the entry close (its 15 s grace gone, the price at the close public): the locks go to the lax seat (taken) and the honest one (refused)
    skipTo(Number(w.c.entryCloseMs) + 20000);
    const said = [];
    for (const d of [lax, honest]) said.push({ lock: await hand(d, 'lock', opt.eid, opt.fields), fee: await hand(d, 'fee-lock', opt.eid, feeFields) });
    await wait(3000);
    const before = !!honest.round.stakeSeen(opt.eid);
    // the round closes (or a restarted honest seat resumes its close): it pulls the pick's locks from its peer (pullPickLocks, kanban #1790)
    await closeRound(w);
    let after = false;
    for (const stop = Date.now() + 20000; Date.now() < stop && !after; await wait(250)) after = !!honest.round.stakeSeen(opt.eid);
    const at = w.c.entryCloseMs + 1n;
    await Promise.all(w.nodes.map((d) => post(d, w.rid, signedBy({ roundId: w.rid, outcome: 0, observedAtMs: at }, [A0, A2]))));
    const o = await outcome(honest, w.rid);
    skipTo(Number(o.finalAtMs) + 100);
    let got;
    for (const stop = Date.now() + 20000; Date.now() < stop; await wait(250)) {
      got = await (await fetch(`http://127.0.0.1:${honest.port}/lock-settlement?round=${toHex(w.rid)}`)).json();
      if (got.state === 'ACCEPTED') break;
    }
    const optKey = toHex(refundKeyOf(opt.entry.playerPubkey));
    const paid = ((got.moved && got.moved.payouts) || []).filter((p) => String(p.pk) === optKey).map((p) => String(p.msat));
    console.log('  FACTS a44-refute-83-2:', JSON.stringify({ said, honestSeenBefore: before, honestSeenAfterResumedClose: after,
      settlement: got.state, paidToLatePick: paid }));
    assert.equal(after, false, `the honest seat (its door refused them) pulled a pick's locks handed after the close + grace from a peer: ${JSON.stringify(said)}; paid ${JSON.stringify(paid)}`);
  } finally { await w.close(); }
});
