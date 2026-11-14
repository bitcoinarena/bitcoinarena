// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 attack audit r4-h2h-1: ONE COMMITTEE SEAT THAT ANSWERS 503 ON GET /reveals HOLDS EVERY HONEST SEAT'S HEAD-TO-HEAD VERDICT.
// verify.js #headToHeadClose waits ("reveals not settled") while a seated entry has no reveal and any peer of the round did not answer its
// /reveals pull (kanban #1589). A peer that answers 503 (or anything but 200/404) counts as not answered - forever, by its own choice. So one
// dishonest seat of the committee makes every round with a walk-away (a player who never reveals: a closed tab, a loser who stays away) wait
// at every honest seat until the result window has passed - the round's end + 600 s + 5 s - and only then sign.
// Safe behaviour: with the 2-of-3 honest seats up and agreeing, the lone revealer's WIN is signed inside the result window and the round settles.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomBytes } from 'node:crypto';
import { lockRound, lockAndPlay } from './lock-round-fixture.js';
import { b32, say, wait } from './window-fixture.js';
import { skipTo, testNow } from './test-clock.js';
import { NEXTBLOCK } from '../../nextblock/plugin/nextblock.js';
import { RPS, RPS_CORE_HASH, RPS_CONFIG_HASH, RPS_GAME_ID } from './plugins/rps/index.js';
import { decodePlayerResult, splitSignedResult } from '../../arena-protocol/src/result.js';
import { msForTicks } from '../../arena-protocol/src/tick.js';
import { toHex } from '../../arena-protocol/src/hash.js';
import { LOCK_SET_VERSION } from '../../arena-protocol/src/constants.js';
// 2.0 (kanban #2708 port): a protocol-28 round names its claims (Arena lock); the fixture's federation answers no LNv2 version, so the
// named-claim height is put past every test round, as h2h-lock-set-2561.test.js does
process.env.ARENA_DONATION_NETWORK = process.env.ARENA_DONATION_NETWORK || 'regtest'; process.env.ARENA_TEST_NAMED_CLAIM_HEIGHT = '999999999';

const START_DEADLINE = 300, BLOCK_TICKS = 600;
const SPAN_MS = Number(msForTicks(2 * START_DEADLINE + BLOCK_TICKS).ms);
const ROUND = { gameId: RPS_GAME_ID, simCoreHash: RPS_CORE_HASH, configHash: RPS_CONFIG_HASH, blockTicks: BLOCK_TICKS, startDeadlineTicks: START_DEADLINE };
const ROCK = 0, PAPER = 1;
const mk = (n) => ({ name: `p${n}`, key: b32(0x40 + n), worldSecret: new Uint8Array(32), ticks: 0, words: () => [0, 0, 0, 0, 0] });
const salt = () => new Uint8Array(randomBytes(32));

// the dishonest seat as its peers see it: every door passed through to the real seat, GET /reveals answered 503
function liar(target) {
  const srv = http.createServer(async (req, res) => {
    if (req.url.startsWith('/reveals')) { res.writeHead(503); return res.end('busy'); }
    const chunks = []; for await (const c of req) chunks.push(c);
    try {
      const r = await fetch(`${target}${req.url}`, { method: req.method, headers: { 'content-type': req.headers['content-type'] || 'application/octet-stream' },
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : Buffer.concat(chunks) });
      res.writeHead(r.status, { 'content-type': r.headers.get('content-type') || 'application/octet-stream' });
      res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(502); res.end(); }
  });
  return new Promise((ok) => srv.listen(0, '127.0.0.1', () => ok(srv)));
}

async function attack(round, p28) {
  const w = await lockRound({ serveOpts: { plugins: [NEXTBLOCK, RPS] }, n: 3, round, minScore: 2, endMs: testNow() + SPAN_MS + 4000 });
  const [s0, s1, s2] = w.nodes;
  const proxy = await liar(`http://127.0.0.1:${s2.port}`);
  try {
    skipTo(Number(w.c.committeeTimeMs) + 20);
    const sa = salt(), sb = salt();
    const a = await lockAndPlay(w, mk(1), { hidden: { move: ROCK, salt: sa }, noMarks: true });
    const b = await lockAndPlay(w, mk(2), { hidden: { move: PAPER, salt: sb }, noMarks: true });
    skipTo(Number(w.c.entryCloseMs) + (p28 ? 50 : 500));
    // protocol 28: the reveal waits for the certified lock set (the liar takes part in it honestly)
    if (p28) for (const stop = Date.now() + 6000; Date.now() < stop; await wait(50)) {
      const sets = await Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/lock-set?round=${toHex(w.rid)}`)).json()));
      if (sets.every((x) => x.certificate)) break;
    }
    // A reveals at every seat; B walks away (never reveals)
    const said = await Promise.all(w.nodes.map(async (d) => (await fetch(`http://127.0.0.1:${d.port}/reveal?entry=${toHex(a.eid)}`, { method: 'POST', body: JSON.stringify({ move: ROCK, salt: toHex(sa) }) })).status));
    // seat 2 is the dishonest one: seats 0 and 1 reach it through the liar
    const real = `http://127.0.0.1:${s2.port}`, fake = `http://127.0.0.1:${proxy.address().port}`;
    for (const d of [s0, s1]) d.verifier.peers = d.verifier.peers.map((p) => (p === real ? fake : p));
    // the round's end: every seat closes; give them a few seconds of real time, still inside the result window
    skipTo(Number(w.c.entryCloseMs) + SPAN_MS + 4500);
    await Promise.all(w.nodes.map((d) => say(d.port, `close ${toHex(w.rid)}`)));
    for (const d of w.nodes) for (const p of d.verifier.done || []) { try { await p; } catch { /* said itself */ } }
    await wait(3000);
    const own = (d, eid) => d.round.results(w.rid, eid).filter((r) => toHex(decodePlayerResult(splitSignedResult(r.bytes).body).nodePubkey) === toHex(d.round.pubkey))
      .map((r) => { const p = decodePlayerResult(splitSignedResult(r.bytes).body); return `${p.outcome} ${p.score}`; });
    const got = { said, a: w.nodes.map((d) => own(d, a.eid)), b: w.nodes.map((d) => own(d, b.eid)) };
    // and past the result window (the round's end + 600 s + 5 s): what the seats then hold for the lone revealer
    const { windowsOf } = await import('../../arena-protocol/src/window.js');
    skipTo(Number(windowsOf(w.c).finalAfterMs) + 2000);
    await wait(6000);
    const nq = (d, eid) => { const x = d.round.noQuorum(eid); return x ? x.outcome : null; };
    got.later = { a: w.nodes.map((d) => own(d, a.eid)), noQuorumA: w.nodes.map((d) => nq(d, a.eid)), noQuorumB: w.nodes.map((d) => nq(d, b.eid)),
      settlement: await Promise.all(w.nodes.map(async (d) => { try { const j = await (await fetch(`http://127.0.0.1:${d.port}/lock-settlement?round=${toHex(w.rid)}`)).json(); return `${j.state} ${String(j.why || '').slice(0, 120)}`; } catch (e) { return e.message; } })) };
    console.log('  FACTS:', JSON.stringify(got));
    // the honest seats hold every reveal that stood (A's at all three; B none) and are two of three: they sign now, not after the window
    assert.deepEqual(got.a[0], ['DELIVERED 2'], `honest seat 0 signed nothing for the lone revealer inside the window: ${JSON.stringify(got)}`);
    assert.deepEqual(got.a[1], ['DELIVERED 2'], `honest seat 1 signed nothing for the lone revealer inside the window: ${JSON.stringify(got)}`);
    assert.deepEqual(got.later.noQuorumA, [null, null, null], `the lone revealer's win was VOIDED at the seats (no quorum in the window): ${JSON.stringify(got)}`);
  } finally { proxy.close(); await w.close(); }
}

test('#1489 r4-h2h-1: one seat answering 503 on /reveals voids a walk-away round (below protocol 28)', { timeout: 110000 }, () => attack(ROUND, false));
test('#1489 r4-h2h-1: one seat answering 503 on /reveals voids a walk-away round (protocol 28, certified lock set)', { timeout: 110000 }, () => attack({ ...ROUND, protocolVersion: LOCK_SET_VERSION }, true));
