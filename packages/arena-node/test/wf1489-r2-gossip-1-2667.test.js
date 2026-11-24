// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 audit r2 (gossip): ONE seat out of seven must not decide what a seat short of an entry does when it takes that entry
// past its door (kanban #1071, server.js takeAcceptedEntry / takeEntryParts). The short seat must still take the entry, its handout
// and its locks from the honest seats, and sign what they sign.
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

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
// THE ENTRY CLOSE LIES 12 s PAST THE TEST'S START (kanban #3071): seven seats boot first, and since #2688 (38abec6c5) each loads its cores itself
// (about 3 s for seven), so the old 4 s closed the round before the first handout, which is then refused. The skip past the close costs no wall time
const SEVEN_SEAT_LEAD_MS = 12000;
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
// the network between the seats: `rule(url, init)` answers a Response for a request it takes over, or null to let it through
const network = (rule) => {
  const real = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => { const u = typeof input === 'string' ? input : String(input.url || input); const x = await rule(u, init); return x || real(input, init); };
  return () => { globalThis.fetch = real; };
};

async function shortSeatRound(tag, liar) {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + SEVEN_SEAT_LEAD_MS });
  const short = w.nodes[6], evil = `http://127.0.0.1:${w.nodes[0].port}`, shortUrl = `http://127.0.0.1:${short.port}`;
  let restore = () => {};
  try {
    assert.equal(short.verifier.peersOf(w.rid)[0], evil, 'the lying seat is the first peer the short seat asks');
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', tag), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    shutDoor(short, b32(tag + 1));
    // the honest seats' relay posts of handout and locks to the short seat are lost (the case #1068 measured: 18 of 114 rounds)
    restore = network((u, init) => {
      const m = String((init && init.method) || 'GET').toUpperCase();
      if (m === 'POST' && u.startsWith(shortUrl) && /\/(handout|lock|fee-lock)(\?|$)/.test(u.slice(shortUrl.length))) return new Response('lost', { status: 503 });
      return liar(u, m, evil);
    });
    const b = await lockAndPlay(w, player('rock', tag + 1), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!short.round.entry(b.eid), 'the door let it in');
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 6));
    await closeRound(w);
    await untilSettled(w, 45000).catch(() => null);
    const said = { a: signed(short, w, a.eid), b: signed(short, w, b.eid), held: !!short.round.entry(b.eid),
      stake: !!short.round.stakeLock(b.eid), fee: !!short.round.feeLock(b.eid) };
    console.log('  FACTS (short seat, one lying peer):', JSON.stringify(said));
    return said;
  } finally { restore(); await w.close(); }
}

test('#1489 r2-gossip-1: one seat answering its /handout with garbage does not make a short seat sign the round without the entry', async () => {
  const said = await shortSeatRound(0x71, (u, m, evil) => (m === 'GET' && u.startsWith(`${evil}/handout?`) ? new Response(new Uint8Array([1, 2, 3]), { status: 200 }) : null));
  assert.ok(said.held, `the short seat never took the entry the threshold signed: ${JSON.stringify(said)}`);
  assert.deepEqual(said.a, ['FAILED 0'], `the short seat signed ${said.a} for the entry it held`);
  assert.deepEqual(said.b, ['DELIVERED 2'], `the short seat signed ${said.b} for the winner`);
});

test('#1489 r2-gossip-1b: one seat answering /order-locks with {} does not stop a short seat from taking the locks the honest seats hold', async () => {
  const said = await shortSeatRound(0x73, (u, m, evil) => (m === 'GET' && u.startsWith(`${evil}/order-locks?`) ? Response.json({}) : null));
  assert.ok(said.held, `the short seat never took the entry the threshold signed: ${JSON.stringify(said)}`);
  assert.ok(said.stake && said.fee, `the short seat took the entry without its locks: ${JSON.stringify(said)}`);
});

test('#1489 r2-gossip-1 control: with every peer honest the short seat takes the entry, its locks, and signs what the others sign', async () => {
  const said = await shortSeatRound(0x75, () => null);
  assert.ok(said.held && said.stake && said.fee, JSON.stringify(said));
  assert.deepEqual(said.b, ['DELIVERED 2']);
});
