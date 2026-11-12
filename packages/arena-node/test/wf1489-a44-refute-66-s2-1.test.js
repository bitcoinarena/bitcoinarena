// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute #1755 (skeptic 2): THE RETRY PATH SIGNS A HEAD-TO-HEAD ROUND PAST membersKnown.
// #1755 made afterClose's membersKnown answer "not known" on a throw, so a seat short of an entry never decides the round alone at its close.
// But a closed head-to-head round is also signed by verifier.retry (a fresh checkpoint receipt over /play, TYPE_CHECKPOINT_RECEIPT), which runs
// #headToHeadClose directly - no membersKnown. THE ATTACKER IS THE PLAYER (no seat): while the round is open it plays a tiny run for its own
// head-to-head entry (round.checkpoint and round.batch take it: nothing refuses a mark of a head-to-head entry) - a first mark, a batch, a
// second mark - at the short seat and at seat 0, keeps seat 0's receipt of the second mark (a later mark is not forwarded), and sends that
// receipt to the short seat over /play once the round is closed there. The short seat then signs VOID 0 for the round alone, before (and
// regardless of) learning the second entry - exactly the #1071 / #1755 effect.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { ed25519 } from '@noble/curves/ed25519.js';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
import { b32, say, GENESIS_HASH } from './window-fixture.js';
import { signedBatchOf, batchId } from '../../arena-protocol/src/batch.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { encodeCheckpoint, checkpointId, joinSigned, NO_PREVIOUS } from '../../arena-protocol/src/checkpoint.js';
import { GENESIS } from '../../arena-protocol/src/transcript.js';
import { SIGNED_RECEIPT_BYTES } from '../../arena-protocol/src/receipt.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const player = (name, k) => ({ name, key: b32(k), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const signed = (d, w, eid) => d.round.results(w.rid, eid).filter((r) => toHex(r.nodePubkey) === toHex(d.round.pubkey))
  .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
const reveal = (w, played, move, salt, seats = w.nodes) => Promise.all(seats.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then((r) => r.text())));
const shutDoor = (d, playerKey) => {
  const real = d.round.enter;
  d.round.enter = function (contract, ...more) {
    if (!more.length && toHex(contract.playerPubkey) === toHex(playerKey)) throw new Error('entry refused: the backup rule');
    return real.call(this, contract, ...more);
  };
};

const run = (attack) => async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const session = ed25519.utils.randomSecretKey();
    const a = await lockAndPlay(w, player('scissors', 0x71), { session, hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const short = w.nodes[6];
    shutDoor(short, b32(0x72));
    const b = await lockAndPlay(w, player('rock', 0x72), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!short.round.entry(b.eid), 'the door let it in');
    // THE PLAYER'S RUN, while the round is open: a first mark (forwarded among the seats with their receipts), one batch of one tick and a
    // second mark after it, at the short seat and at seat 0 only. A later mark is not forwarded: seat 0's receipt of it is the player's alone.
    let receipt = null;
    if (attack) {
      const pk = ed25519.getPublicKey(session), sign = (m) => joinSigned(encodeCheckpoint(m), ed25519.sign(checkpointId(m), session));
      const m1 = { roundId: w.rid, entryId: a.eid, tick: 0, stateHash: new Uint8Array(32).fill(7), inputChainHash: GENESIS, previousHash: NO_PREVIOUS, sessionPubkey: pk };
      const b1 = { roundId: w.rid, entryId: a.eid, previousHash: GENESIS_HASH, firstTick: 0, ticks: [[0, 0, 0, 0, 0]], liquidations: [], loads: [] };
      const m2 = { roundId: w.rid, entryId: a.eid, tick: 1, stateHash: new Uint8Array(32).fill(8), inputChainHash: batchId(b1), previousHash: checkpointId(m1), sessionPubkey: pk };
      const said = [];
      for (const d of [short, w.nodes[0]]) {
        said.push(await say(d.port, sign(m1)), await say(d.port, signedBatchOf(b1, (id) => ed25519.sign(id, session))), await say(d.port, sign(m2)));
      }
      console.log('  the player\'s run at the short seat and seat 0:', said.map((x) => (typeof x === 'string' ? x.slice(0, 90) : `receipt ${x.length} B`)).join(' | '));
      assert.equal(said[2].length, SIGNED_RECEIPT_BYTES, `the short seat refused the second mark: ${said[2]}`);
      assert.equal(said[5].length, SIGNED_RECEIPT_BYTES, `seat 0 refused the second mark: ${said[5]}`);
      receipt = said[5];
      assert.ok(!short.round.holdsReceipt(receipt), 'the short seat already holds seat 0\'s receipt of the second mark');
    }
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 6));
    // THE SHORT SEAT CLOSES FIRST, and the player hands it seat 0's receipt at once
    console.log('  close at the short seat:', await say(short.port, `close ${toHex(w.rid)}`), 'state', short.round.get(w.rid).state);
    if (attack) console.log('  receipt at the short seat after its close:', String(await say(short.port, receipt)).slice(0, 80));
    for (const stop = Date.now() + 6000; Date.now() < stop && !signed(short, w, a.eid).length;) await new Promise((r) => setTimeout(r, 100));
    const early = { a: signed(short, w, a.eid), held: !!short.round.entry(b.eid) };
    console.log('  FACTS (short seat, up to 6 s after its close, before the others close):', JSON.stringify(early));
    assert.notDeepEqual(early.a, ['VOID 0'], 'a checkpoint receipt made the short seat decide a two-player round alone (retry -> #headToHeadClose, no membersKnown): VOID 0');
    await closeRound(w).catch(() => null);
  } finally { await w.close(); }
};

test('control: the short seat signs nothing for the round before it knows who is in it', run(false));
test('a player\'s own checkpoint receipt does not make the short seat decide a head-to-head round alone', run(true));
