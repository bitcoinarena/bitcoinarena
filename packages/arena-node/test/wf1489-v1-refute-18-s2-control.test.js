// #1489 v1-refute-18 skeptic 2, finding 2 (retry path, one seat): #1507's rule is "a peer over a limit is skipped for this pass and the
// next peer is asked", so one committee seat cannot keep the honest seats from signing a head-to-head round. But a seat short of an
// entry takes it in membersKnown -> takeAcceptedEntry (server.js), and there a peer that hands over the true entry bytes and then
// fails GET /handout ends the take with `return { ok: false }` - the next peer that holds the handout is never asked. membersKnown
// retries every pass with the same peer order, so the bad seat is asked first each time, and the short seat signs NOTHING for the
// round until its result window runs out. Here the bad seat is a stub that proxies seat 0 for every path but answers 500 on
// /handout. Safe behaviour: the short seat takes the entry from the next peer and signs what the others sign (DELIVERED 2).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay, closeRound } from './lock-round-fixture.js';
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

// ONE COMMITTEE SEAT: everything as seat 0 answers it, except its handouts
function badSeat(target) {
  let handoutAsks = 0;
  const srv = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/handout')) { handoutAsks++; res.writeHead(500); return res.end('no'); }
    const up = http.request({ host: '127.0.0.1', port: target, method: req.method, path: req.url, headers: { ...req.headers, host: `127.0.0.1:${target}` } }, (u) => {
      res.writeHead(u.statusCode, u.headers); u.pipe(res);
    });
    up.on('error', () => { try { res.writeHead(502); res.end(); } catch { /* gone */ } });
    req.pipe(up);
  });
  return { srv, asks: () => handoutAsks };
}

test('#1489 v1-refute-18-s2 CONTROL (no bad seat): one seat that fails /handout keeps a short seat from taking the entry, every pass - it signs nothing', async () => {
  const w = await lockRound({ n: 7, serveOpts: { plugins: [NEXTBLOCK, RPS] }, round: ROUND, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const bad = badSeat(w.nodes[0].port);
  try {
    await new Promise((r) => bad.srv.listen(0, '127.0.0.1', r));
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = new Uint8Array(randomBytes(32)), sb = new Uint8Array(randomBytes(32));
    const a = await lockAndPlay(w, player('scissors', 0x71), { hidden: { move: SCISSORS, salt: sa }, noMarks: true, address: true });
    const short = w.nodes[6];
    shutDoor(short, b32(0x72));
    // its handout door refuses too while the entry door does (the same backup rule) - so it must take the handout from a peer
    let shut = true; const remember = short.round.rememberHandout;
    short.round.rememberHandout = function (...x) { if (shut) throw new Error('handout refused: the backup rule'); return remember.apply(this, x); };
    const b = await lockAndPlay(w, player('rock', 0x72), { hidden: { move: ROCK, salt: sb }, noMarks: true, address: true, unreached: [6] });
    await new Promise((r) => setTimeout(r, 2500));
    assert.ok(!short.round.entry(b.eid), 'the door let it in');
    shut = false;
    // the bad seat stands first in the short seat's peer list (any order the census gives may put one seat first)
    /* control: no bad seat */
    skipTo(Number(w.c.entryCloseMs) + 500);
    await reveal(w, a, SCISSORS, sa);
    await reveal(w, b, ROCK, sb, w.nodes.slice(0, 6));
    await closeRound(w);
    for (const stop = Date.now() + 30000; Date.now() < stop && !(short.round.entry(b.eid) && signed(short, w, b.eid).length);) await new Promise((r) => setTimeout(r, 250));
    const said = { held: !!short.round.entry(b.eid), a: signed(short, w, a.eid), b: signed(short, w, b.eid), handoutAsks: bad.asks(),
      others: w.nodes.slice(0, 6).map((d) => signed(d, w, b.eid).join(',')) };
    console.log('  FACTS (short seat, one bad seat first):', JSON.stringify(said));
    assert.ok(said.others.every((s) => s === 'DELIVERED 2'), 'the honest seats did not sign the entry - the test did not set up');
    assert.ok(said.held, `the short seat never took the entry: the bad seat was asked for the handout ${said.handoutAsks} times and no other peer once`);
    assert.deepEqual(said.b, ['DELIVERED 2']);
  } finally { bad.srv.closeAllConnections(); bad.srv.close(); await w.close(); }
});
