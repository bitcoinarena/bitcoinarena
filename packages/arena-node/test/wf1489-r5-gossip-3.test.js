// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r5 (gossip): ONE PEER'S MALFORMED GET /handout ANSWER MUST NOT MAKE A SHORT SEAT DECIDE A HEAD-TO-HEAD ROUND ALONE.
// takeAcceptedEntry (server.js) decodes a peer's handout outside any try: one peer that serves junk bytes at GET /handout makes it throw,
// lookAtMembers and membersKnown reject, afterClose's catch answers `true` ("members known"), and the seat settles the round without the
// entry it lacked: it signs VOID for the other player instead of taking the entry from the next peer that holds it (entry-relay.js: "It never
// decides the round alone"). Safe: a bad peer answer is passed over like a 404 and the next holder's copy is taken.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
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

const run = (junk) => async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  let stub;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x71), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const short = w.nodes[6];
    shutDoor(short, b32(0x72));
    const keep = short.round.rememberHandout;
    short.round.rememberHandout = () => {};      // the short seat lacks the second entry's handout too (its copy, and the relay's, lost)
    const b = await lockAndPlay(w, player('rock', 0x72), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!short.round.entry(b.eid), 'the door let it in');
    short.round.rememberHandout = keep;
    // THE ATTACKER: seat 0 as the short seat sees it - every answer seat 0's own, except GET /handout, which is 200 with junk bytes
    const real = `http://127.0.0.1:${w.nodes[0].port}`;
    stub = createServer(async (req, res) => {
      if (junk && req.method === 'GET' && req.url.startsWith('/handout')) { res.writeHead(200, { 'content-type': 'application/octet-stream' }); return res.end(Buffer.from('junk')); }
      const chunks = []; for await (const c of req) chunks.push(c);
      try {
        const r = await fetch(real + req.url, { method: req.method, body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks), headers: { ...(req.headers['x-arena-relayed'] ? { 'x-arena-relayed': '1' } : {}) } });
        res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
        res.end(Buffer.from(await r.arrayBuffer()));
      } catch { res.writeHead(502); res.end(); }
    });
    await new Promise((r) => stub.listen(0, '127.0.0.1', r));
    short.verifier.peers = short.verifier.peers.map((p) => (p === real ? `http://127.0.0.1:${stub.address().port}` : p));
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 6));
    await closeRound(w);
    await untilSettled(w, 45000).catch(() => null);
    for (const stop = Date.now() + 10000; Date.now() < stop && !signed(short, w, a.eid).length;) await new Promise((r) => setTimeout(r, 250));
    const said = { a: signed(short, w, a.eid), b: signed(short, w, b.eid), held: !!short.round.entry(b.eid) };
    console.log('  FACTS (short seat, one peer with a junk handout):', JSON.stringify(said));
    assert.notDeepEqual(said.a, ['VOID 0'], 'one peer\'s junk handout made the short seat decide the round alone: it signed VOID for a two-player round');
    assert.ok(said.held, 'the short seat never took the entry from the honest holders after one peer\'s junk handout');
  } finally { if (stub) stub.close(); await w.close(); }
};

test('control: the same short seat behind a faithful proxy of seat 0 takes the entry and its handout', run(false));
test('one peer serving junk at GET /handout does not make the short seat sign VOID: it takes the entry from the next holder', run(true));
