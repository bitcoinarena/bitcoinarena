// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 (attacker review, head-to-head): ONE SEAT FLIPS WHAT A HEAD-TO-HEAD ROUND TELLS ITS PLAYERS.
// verify.js #keepPeerResult stores any peer result whose signature verifies under the key IT names - never checking that key is
// one of the round's signer nodes (the postings beside it are checked against signerNodes). /api/round-result (outcome, score,
// signedBy, the won/lost balance line) and match.js agreedResult (the score across rounds) take the plurality over every stored
// result. One committee seat answers GET /results with results signed by throwaway keys: rock's win FAILED, scissors' loss
// DELIVERED 2 - honest seats store them at their gather and show the loser as the winner. The safe behaviour: a result signed
// by a key outside the round's committee is not stored, and the shown outcome stays the committee's.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { schnorr } from '@noble/curves/secp256k1.js';
import { lockRound, lockAndPlay, closeRound, untilSettled } from './lock-round-fixture.js';
import { b32 } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, encodePlayerResult, splitSignedResult, joinSignedResult, resultId } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, SCISSORS = 2;
const reveal = async (w, played, move, salt) => Promise.all(w.nodes.map(async (d) => {
  const r = await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(played.eid)}`, { method: 'POST', body: JSON.stringify({ move, salt: toHex(salt) }) });
  return r.status;
}));
// N results for one entry, each signed by a fresh key that is no signer node of the round, saying `outcome` / `score`
const forged = (honestBytes, outcome, score, n) => Buffer.concat(Array.from({ length: n }, () => {
  const sk = schnorr.utils.randomSecretKey();
  const body = { ...decodePlayerResult(splitSignedResult(honestBytes).body), outcome, score, nodePubkey: schnorr.getPublicKey(sk) };
  return Buffer.from(joinSignedResult(encodePlayerResult(body), schnorr.sign(resultId(body), sk)));
}));

test('#1489-h2h-1 results signed by keys outside the committee are not stored and do not flip the round result shown to the players', async () => {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  let evil = null;
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const P = (k) => ({ name: `p${k}`, key: b32(k), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
    const a = await lockAndPlay(w, P(0x71), { hidden: { move: ROCK, salt: sa }, noMarks: true, address: true });
    const b = await lockAndPlay(w, P(0x72), { hidden: { move: SCISSORS, salt: sb }, noMarks: true, address: true });
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, ROCK, sa);
    await reveal(w, b, SCISSORS, sb);
    await closeRound(w);
    const settled = await untilSettled(w);
    assert.equal(settled.state, 'ACCEPTED', settled.why);
    const seat = w.nodes[0];
    const show = async () => (await (await fetch(`http://127.0.0.1:${seat.port}/api/round-result?round=${toHex(w.rid)}`)).json()).players
      .map((p) => ({ entry: p.entry.slice(0, 8), outcome: p.outcome, score: p.score, signedBy: p.signedBy }));
    const before = await show();
    // THE ATTACKING SEAT: its GET /results answers four throwaway-key results per entry, the outcomes swapped
    const bodies = new Map([
      [toHex(a.eid), forged(seat.round.results(w.rid, a.eid)[0].bytes, 'FAILED', 0, 4)],
      [toHex(b.eid), forged(seat.round.results(w.rid, b.eid)[0].bytes, 'DELIVERED', 2, 4)],
    ]);
    evil = await new Promise((ok) => { const s = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://x');
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(u.pathname === '/results' ? bodies.get(u.searchParams.get('entry')) || Buffer.alloc(0) : Buffer.alloc(0));
    }); s.listen(0, '127.0.0.1', () => ok(s)); });
    seat.verifier.peers = [...seat.verifier.peers, `http://127.0.0.1:${evil.address().port}`];
    await seat.verifier.gather(w.rid, a.eid);
    await seat.verifier.gather(w.rid, b.eid);
    const committee = new Set(seat.round.signerNodes(w.rid).map(toHex));
    const outsiders = [a.eid, b.eid].flatMap((e) => seat.round.results(w.rid, e)).filter((r) => !committee.has(toHex(r.nodePubkey))).length;
    const after = await show();
    console.log('  FACTS (#1489-h2h-1):', JSON.stringify({ before, after, outsiders }));
    assert.equal(outsiders, 0, `${outsiders} results signed by keys outside the round's committee were stored`);
    assert.deepEqual(after, before, 'the round result shown to the players changed after one seat answered forged results');
  } finally { if (evil) { evil.closeAllConnections(); evil.close(); } await w.close(); }
});
