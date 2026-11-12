// kanban #1489 #1551 refute (c1551b-0) 1: A STAKE LOCK WITH ITS FEE LOCK HELD BACK SEATS A RISK-FREE OPPONENT.
// #1551 closed the fee-lock door of a head-to-head round at its entry close (no grace). A paying RPS entry whose stake lock was verified before
// the close but whose fee lock never came is still seated (round.js seatedEntriesOf: "its stake lock verified and waiting for its fee lock")
// although no fee lock can come any more - and it has no place in the settlement (the stake counts only with its fee lock). Measured on 668e912e3:
// the attacker is played; when it loses (SCISSORS vs ROCK) the honest winner is signed DELIVERED 2 at every seat, yet the settlement claims no
// loser's lock ("no loser's lock is claimed in this round") and pays 0 - the honest player even pays its own fee - and the attacker's stake comes
// back by refund; when it wins it is signed DELIVERED 2 (score) at no risk. The same effect #1551 was about: the honest winner's round undone, the
// attacker risks nothing. Safe: such an entry is not seated once the fee door is shut (or its stake is claimed when it loses).
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
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { lockFieldsToJson, refundKeyOf } from '../../arena-protocol/src/stake-lock.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const mk = (n) => ({ name: `p${n}`, key: b32(0x50 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const post = async (d, path, eid, body) => { const r = await fetch(`http://127.0.0.1:${d.port}${path}?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify(body) }); return { s: r.status, t: (await r.text()).slice(0, 120) }; };
const reveal = (d, eid, move, s) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(s) }) });

for (const withFee of [true, false]) {
  test(`#1551 refute c1551b-0 1: the attacker locks its stake before the close ${withFee ? 'and its fee (control)' : 'but never its fee'}, and loses: the honest winner is paid`, async () => {
    const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: 15000 }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
    try {
      skipTo(Number(w.c.committeeTimeMs) + 20);
      const sp = salt(), so = salt();
      const honest = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sp }, noMarks: true });
      const a = await lockAndPlay(w, mk(2), { hidden: { move: SCISSORS, salt: so }, noMarks: true, only: [] });
      const fee = { paymentImage: { kind: 'hash', bytes: sha256(a.entry.feePreimage) }, amountMsat: a.entry.feeMsat, claimPk: w.claimPk, refundPk: refundKeyOf(mk(2).key), expiration: a.fields.expiration };
      const pre = [];
      for (const d of w.nodes) {
        pre.push(await post(d, '/lock', a.eid, lockFieldsToJson(a.fields)));
        if (withFee) pre.push(await post(d, '/fee-lock', a.eid, lockFieldsToJson(fee)));
      }
      skipTo(Number(w.c.entryCloseMs) + 1800);
      for (const d of w.nodes) { await reveal(d, honest.eid, ROCK, sp); await reveal(d, a.eid, SCISSORS, so); }
      const seated = w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).length);
      await closeRound(w);
      const settled = await untilSettled(w);
      const got = { honest: results(w, honest.eid), attacker: results(w, a.eid) };
      const moved = settled.moved || {};
      const facts = { pre: pre.map((x) => x.s), seated, got, state: settled.state, why: settled.why, paidMsat: moved.paidMsat, stakeWhy: moved.stakeWhy };
      console.log('  FACTS (c1551b-0 1):', JSON.stringify(facts));
      const played = got.attacker.some((per) => per.some((x) => !x.startsWith('VOID')));
      assert.ok(!played || BigInt(moved.paidMsat || 0) > 0n,
        `a seated opponent whose fee lock never came lost, and the honest winner was paid nothing (its stake not claimed): ${JSON.stringify(facts)}`);
    } finally { await w.close(); }
  });
}
