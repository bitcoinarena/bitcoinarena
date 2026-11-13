// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 bypass of #1479 (feedback #007, "one entry per session key"): ONE PLAYER STANDS THREE TIMES IN A PAYING ROCK PAPER SCISSORS
// ROUND - ROCK, PAPER AND SCISSORS - AND LOCKS ONLY THE WINNER, AFTER THE HONEST PLAYER'S REVEAL.
// #1479 refuses a second entry of the same SESSION key. A session key is free and fresh per entry, so the attacker (one player key) posts three
// entries under three session keys, with no lock: in a paying round the door counts only lock-backed entries (#1437), so all three stand. At the
// entry close the honest player reveals (GET /reveals shows it at once); inside the 15 s lock grace (#1260, ENTRY_CLOSE_GRACE_MS) the attacker
// hands /lock and /fee-lock for the one entry whose move beats it - the lock door sees one seated entry of two and takes it - and reveals it.
// Safe behaviour: the attacker cannot choose his move after the honest reveal - either his extra entries are refused, or the late lock is.
// kanban #2633 (bypass of #1479 reported against the 1.9 tree): measured at f856e6f98 the hole is already closed by #1598/#1551/#1822 - no seat
// serves GET /reveals before entry close + H2H_REVEAL_HOLD_MS, and h2hLockRefusal refuses a stake or fee lock new to the seat from the entry close
// on (no grace in a head-to-head round). This test keeps both: the reveal is not public 500 ms after the close, and the lock handed once it is
// public is refused at every seat, so the move that beats it is never seated.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex, sha256 } from '../../arena-protocol/src/hash.js';
import { refundKeyOf } from '../../arena-protocol/src/stake-lock.js';
import { lockFieldsToJson } from '../src/stake-lock-signer-node.js';
import { ENTRY_CLOSE_GRACE_MS } from '../src/round.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1, SCISSORS = 2;
const BEATS = { [ROCK]: PAPER, [PAPER]: SCISSORS, [SCISSORS]: ROCK };
const mk = (n) => ({ name: `p${n}`, key: b32(0xa0 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));
const results = (w, eid) => w.nodes.map((d) => d.round.results(w.rid, eid).map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; }));
const post = async (d, path, body) => { const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { method: 'POST', body }); return `${r.status} ${(await r.text()).slice(0, 140)}`; };

test('#1489 bypass #1479: one player, three session keys, rock + paper + scissors lockless; the winner locked after the honest reveal', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS], entryCloseGraceMs: Number(ENTRY_CLOSE_GRACE_MS) }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 25000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    // THE ATTACKER: one player key, three entries, each under its own fresh session key (as every client makes), no lock handed anywhere
    const attacker = mk(1);
    const mine = {};
    const doors = {};
    for (const move of [ROCK, PAPER, SCISSORS]) {
      const s = salt();
      try { mine[move] = { played: await lockAndPlay(w, attacker, { hidden: { move, salt: s }, noMarks: true, only: [] }), salt: s }; doors[move] = 'taken'; }
      catch (e) { doors[move] = String(e.message).split('\n')[0].slice(0, 160); }
    }
    // THE HONEST PLAYER: entered and locked, rock
    const honestSalt = salt();
    const honest = await lockAndPlay(w, mk(2), { hidden: { move: ROCK, salt: honestSalt }, noMarks: true });
    // ENTRY CLOSE: the honest player reveals, as the page does
    skipTo(Number(w.c.entryCloseMs) + 500);
    for (const d of w.nodes) await post(d, `/reveal?entry=${toHex(honest.eid)}`, JSON.stringify({ move: ROCK, salt: toHex(honestSalt) }));
    // 500 ms after the close no seat serves the honest move yet (H2H_REVEAL_HOLD_MS, kanban #1822)
    for (const d of w.nodes) {
      const early = await (await fetch(`http://127.0.0.1:${d.port}/reveals?round=${toHex(w.rid)}`)).json();
      assert.ok(!(early.reveals || []).some((r) => r.entry === toHex(honest.eid)), `seat ${d.port} served the honest move 500 ms after the entry close`);
    }
    // GET /reveals is public from the close + H2H_REVEAL_HOLD_MS (1750 ms): the attacker reads it then
    skipTo(Number(w.c.entryCloseMs) + 1800);
    // THE ATTACKER READS THE REVEAL AND PICKS THE ENTRY THAT BEATS IT
    const seen = await (await fetch(`http://127.0.0.1:${w.nodes[0].port}/reveals?round=${toHex(w.rid)}`)).json();
    const theirs = seen.reveals.find((r) => r.entry === toHex(honest.eid));
    const pick = BEATS[theirs.move];
    const chosen = mine[pick];
    const late = [];
    if (chosen) {
      const p = chosen.played;
      const feeFields = { paymentImage: { kind: 'hash', bytes: sha256(p.entry.feePreimage) }, amountMsat: p.entry.feeMsat, claimPk: w.claimPk,
        refundPk: refundKeyOf(attacker.key), expiration: p.fields.expiration };
      for (const d of w.nodes) {
        late.push(await post(d, `/lock?entry=${toHex(p.eid)}`, JSON.stringify(lockFieldsToJson(p.fields))));
        late.push(await post(d, `/fee-lock?entry=${toHex(p.eid)}`, JSON.stringify(lockFieldsToJson(feeFields))));
      }
      for (const d of w.nodes) late.push(await post(d, `/reveal?entry=${toHex(p.eid)}`, JSON.stringify({ move: pick, salt: toHex(chosen.salt) })));
    }
    await closeRound(w);
    const got = { honest: results(w, honest.eid), chosen: chosen ? results(w, chosen.played.eid) : null };
    console.log('  FACTS (#1489 bypass #1479):', JSON.stringify({ doors, honestMove: theirs.move, pick, late, results: got }));
    const seatedChosen = chosen ? w.nodes.map((d) => d.round.seatedEntriesOf(w.rid, w.c.stakeMsat).some((x) => toHex(x.entryId) === toHex(chosen.played.eid))) : [false];
    assert.ok(!seatedChosen.some(Boolean), `the attacker's entry chosen after the honest reveal (move ${pick} beats ${theirs.move}) was seated by a lock handed after it: ${JSON.stringify(late)}`);
    assert.ok(!(got.chosen || []).flat().some((x) => /^DELIVERED/.test(x)), `the attacker won with the move picked after seeing the honest one: ${JSON.stringify(got)}`);
  } finally { await w.close(); }
});
