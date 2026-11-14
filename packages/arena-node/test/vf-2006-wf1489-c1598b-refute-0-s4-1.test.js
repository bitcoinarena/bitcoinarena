// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 skeptic 4 (round b) on #1598 at 7b2c7f611: THE HONEST PAGE REVEALS BY ITS OWN CLOCK, A MOMENT BEFORE THE SEATS' CLOSE.
// The page (src/arena-ui/index.html, kanban #947) fires its reveal at `row.entryCloseMs - Date.now() + 120` ms on the BROWSER's clock, with
// no server time. A browser clock a few hundred ms fast posts { move, salt } to every seat of the round before their entry close. Every
// honest seat refuses it (409 "a move is revealed only after entry close") and stores nothing - but the body went to every seat, and one seat
// of the round (the attacker's partner, the same one-seat assumption as s2/s3) reads it off its own request log. The attacker, who stood
// rock, paper and scissors under three fresh session keys with no stake lock, hands only the winner's stake lock to every seat, still before
// their close. Every #1598 check passes: before the close, no reveal held anywhere (they were all refused), every peer says held:false. The
// lock is written at the threshold of seats (2 of 2) and the honest player is beaten by a move picked after his.
// kanban #2536 (re-check on 1.9 acbc1948c): #1598 is closed by the certified lock set (protocol 28, #2561, ruling #2116 (b)); rounds
// below 28 keep the old rules byte for byte by that ruling. The test is adapted to a protocol-28 round and the page of that round
// (arena-client revealWhenCertified, as index.html calls it), its clock still 500 ms fast; the attack is the same - the partner seat
// reads every body that reaches it and the attacker locks only the winner of what it read.
// Safe behaviour: a head-to-head move is never readable by anyone while a stake lock can still seat an entry that answers it - the page does
// not send its reveal before the seats' close (or a lock new in the reveal's lead window is refused), and the honest player is not beaten.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { schnorr } from '@noble/curves/secp256k1.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
import { revealWhenCertified } from '../../arena-client/src/head-to-head.js';

// kanban #2536, 2.0: protocol 27 and up is also the Arena lock here (arena-lock.js NAMED_CLAIM_VERSION, regtest's point 0) and this fixture's locks
// are stock contracts, so its rounds sit below regtest's named-claim point by the harness switch, as h2h-lock-set-2561 does on 2.0
process.env.ARENA_DONATION_NETWORK = 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE, protocolVersion: LOCK_SET_VERSION };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0x90 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const revealTo = (w, played, move, s) => Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) })).status));

test('#1598 refute b s4: the page reveals 500 ms early by its own clock; a partner seat reads the refused body; only the winner is locked', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000, closeAtEnd: { everyMs: 250 } }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  const realFetch = globalThis.fetch;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const hs = salt();
    const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: hs }, noMarks: true });
    const moves = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      // the fee lock (2 %) for each, no stake lock anywhere: nothing seats them yet
      moves[move] = { played: await lockAndPlay(w, mk(2 + move), { hidden: { move, salt: s }, noMarks: true, only: [], feeFirst: true }), salt: s };
    }
    // SEAT 1 (the partner) sees every request body that reaches it, refused or not - its own access log
    const seen = [];
    const partner = `127.0.0.1:${w.nodes[1].port}/reveal?entry=`;
    globalThis.fetch = async (u, o) => {
      const s = String(u && u.url ? u.url : u);
      if (s.includes(partner) && o && typeof o.body === 'string') seen.push({ entry: s.slice(s.indexOf(partner) + partner.length, s.indexOf(partner) + partner.length + 64), body: JSON.parse(o.body) });
      return realFetch(u, o);
    };
    // the honest page's clock runs 500 ms fast: it starts its reveal at close - 380 ms by the seats' clock (the protocol-28 page)
    skipTo(Number(w.c.entryCloseMs) - 380);
    const page = revealWhenCertified({ roundIdHex: toHex(w.rid), entryIdHex: toHex(honest.eid), move: ROCK, salt: hs, nodes: w.nodes.map((d) => `http://127.0.0.1:${d.port}`),
      committee: w.nodes.map((d) => toHex(d.round.pubkey)), verify: (sg, m, k) => schnorr.verify(sg, m, k), entryCloseMs: Number(w.c.entryCloseMs),
      fetcher: (u, o) => globalThis.fetch(u, o), now: () => testNow() + 500 });
    await new Promise((ok) => setTimeout(ok, 400));
    const early = seen.filter((x) => x.entry === toHex(honest.eid)).length;
    const heldEarly = w.nodes.map((d) => d.round.revealsOf(w.rid).length);
    // the attacker hands only the winner's stake lock to every seat, still before their close - if it read a move
    skipTo(Number(w.c.entryCloseMs) - 300);
    const leakedBefore = seen.find((x) => x.entry === toHex(honest.eid));
    const lockWinner = async (leak) => {
      const winner = BEATS[leak.body.move], p = moves[winner].played;
      const answers = await Promise.all(w.nodes.map(async (d, i) => { const r = await realFetch(`http://127.0.0.1:${d.port}/lock?entry=${toHex(p.eid)}`, { method: 'POST', body: JSON.stringify(lockFieldsToJson(p.fields)) });
        return { seat: i, status: r.status, said: (await r.text()).slice(0, 160) }; }));
      return { winner, p, answers };
    };
    let att = leakedBefore ? await lockWinner(leakedBefore) : null;
    // the close: the page reveals once the lock set is certified; the attacker, if it has read nothing yet, locks the winner of what it reads now
    skipTo(Number(w.c.entryCloseMs) + 300);
    const late = await page;
    const leaked = seen.find((x) => x.entry === toHex(honest.eid));
    if (!att && leaked) att = await lockWinner(leaked);
    const { winner, p, answers } = att || { winner: null, p: moves[PAPER].played, answers: [] };
    if (att) await revealTo(w, p, winner, moves[winner].salt);
    const leakedAt = leakedBefore ? 'before the close' : leaked ? 'after the certificate' : 'never';
    await closeRound(w);
    await untilSettled(w, 20000).catch(() => {});
    const got = { attacker: results(w, p.eid), honest: results(w, honest.eid) };
    console.log('  FACTS (#1598 refute b s4-1):', JSON.stringify({ early, heldEarly, leakedAt, winner, answers, late: { seats: late.seats && late.seats.map((x) => x.status), certified: !!late.certified, void: late.void }, heldAt: w.nodes.map((d) => !!d.round.stakeLock(p.eid)), results: got }));
    assert.equal(early, 0, 'the page sent its move before the close');
    assert.ok(late.certified, `the honest page did not reveal after the certificate: ${JSON.stringify(late)}`);
    assert.ok(!got.attacker.some((per) => per.includes('DELIVERED 2')), `a stake lock chosen from the honest page's early reveal won: ${JSON.stringify({ answers, got })}`);
  } finally { globalThis.fetch = realFetch; await w.close(); }
});
