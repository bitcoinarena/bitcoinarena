// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489, refute of #1603 / #2001 (skeptic 4: honest path, edge values, restarts between two writes).
//
// THE SIGNATURES ARE OUTSIDE THE ID, SO BYTES THAT HASH TO THE ID ARE NO LONGER ALWAYS A TAKEABLE ENTRY. takeAcceptedEntry (server.js, §17, kanban #1071)
// asks the peers that hold an entry one after another and `continue`s past a peer whose bytes do not hash to the id - before #1603 that was the
// whole check, since the id is the hash of every byte. Since #1603 an entry's player and session signatures ride outside the id, and Round.enter
// refuses an entry whose signatures do not verify. takeAcceptedEntry answers { ok: false } on that refusal and does NOT go on to the next peer.
// So the first peer in the list that serves the entry with a broken (or missing) signature - one bad seat, or a seat whose row was written before
// the roll and restarted on the new build - keeps a short seat from ever taking an entry the threshold signed results for: it waits, signs
// nothing for the round, and its own settlement never stands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
// kanban #2536 (re-check on 1.9 acbc1948c): #1603's signatures outside the entry id (fc66bff0b) are not on the 1.9 line - there the
// entry id hashes every byte of the entry (contracts.js entryId), so a peer cannot serve other bytes under the same id; the players are
// named by their bare b32 key (no fixtureKey). The test is adapted: the first peer serves the entry with a byte changed (the nearest the
// attack gets on 1.9), and the short seat must still take the entry from the five good peers.
import { b32 } from './window-fixture.js';
const fixtureKey = (n) => b32(n);
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { decodeEntryContract, encodeEntryContract, entryId } from '../../arena-protocol/src/contracts.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const player = (name, k) => ({ name, key: b32(k), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const reveal = (w, played, move, salt, seats = w.nodes) => Promise.all(seats.map((d) => fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`,
  { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) }).then((r) => r.text())));
const shutDoor = (d, playerKey) => {
  const real = d.round.enter;
  d.round.enter = function (contract, ...more) {
    if (!more.length && toHex(contract.playerPubkey) === toHex(playerKey)) throw new Error('entry refused: the backup rule');
    return real.call(this, contract, ...more);
  };
};

const run = async (label, rewrite) => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x71), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const short = w.nodes[6];
    shutDoor(short, fixtureKey(0x72));
    const b = await lockAndPlay(w, player('rock', 0x72), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!short.round.entry(b.eid), 'the short seat\'s door let the entry in');
    // THE FIRST PEER THE SHORT SEAT ASKS (its peers list, in order) serves the entry's bytes with its signatures changed; the id is unchanged
    const first = short.verifier.peersOf(w.rid)[0];
    const bad = w.nodes.find((d) => `http://127.0.0.1:${d.port}` === first);
    const held = decodeEntryContract(new Uint8Array(bad.round.entry(b.eid)));
    const served = rewrite(held);
    const sameId = toHex(entryId(served)) === toHex(b.eid);
    console.log(`  FACTS (${label}): the rewritten bytes hash to the entry id: ${sameId}`);
    assert.equal(sameId, false, '1.9: the entry id covers every byte (precondition of the adapted test)');
    bad.round.db.prepare('UPDATE entries SET contract = ? WHERE entry_id = ?').run(encodeEntryContract(served), b.eid);
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 6));
    await closeRound(w);
    await untilSettled(w, 45000);
    for (const stop = Date.now() + 10000; Date.now() < stop && !short.round.entry(b.eid);) await new Promise((r) => setTimeout(r, 250));
    console.log(`  FACTS (${label}): short seat holds the entry: ${!!short.round.entry(b.eid)}; five good peers hold it: ${w.nodes.slice(0, 6).filter((d) => d !== bad && d.round.entry(b.eid)).length}`);
    assert.ok(short.round.entry(b.eid), `${label}: one peer's bytes with bad signatures kept the short seat from taking an entry five good peers hold and the threshold signed`);
  } finally { await w.close(); }
};

test('#1489-c1603-refute-0-s4-1 a peer serving an accepted entry with a broken player signature (same id) keeps a short seat from ever taking it', async () => {
  await run('broken signature', (e) => { const sessionPubkey = Uint8Array.from(e.sessionPubkey); sessionPubkey[31] ^= 1; return { ...e, sessionPubkey }; });
});

test('#1489-c1603-refute-0-s4-1 a peer whose row was written before the roll (no signatures, same id) keeps a short seat from ever taking it', async () => {
  await run('row from before the roll', (e) => { const worldSecret = Uint8Array.from(e.worldSecret); worldSecret[0] ^= 0x80; return { ...e, worldSecret }; });
});
