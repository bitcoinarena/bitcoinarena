// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// THE NEXT PAID ROUND ONLY WITH ITS STAKE IN THE PLAYER WALLET (kanban #158, comment 592: on 0.0.2832, round dcd6cbb6, the
// page entered the next paid round d8cf7893 with 73 sat for a 100 sat stake; its join waited on a deposit nobody asked for,
// Unity held that join as its next one, and the result card held the screen past 420 s). index.html's continueToTheNextRound,
// cancelNextJoin and BLWP_ASK_JOIN_DEPOSIT run under the page's name (page-script.js), with the bundle's own nextRoundAfter
// and lobbyStakeSats. Measured: a next paid round the wallet cannot pay is not entered; one it can pay, a free one, or one
// with no balance read yet is; a continuing join that reaches a deposit is dropped (Unity reads it refused and shows the
// lobby) and no deposit box opens; a join the player pressed PLAY on still gets its deposit offer; exit game still drops it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { pageFunction } from './page-script.js';
import { nextRoundAfter } from '../src/next-round.js';
import { lobbyStakeSats } from '../src/lobby.js';

const PAGE = new URL('../../../unity-proto/Assets/WebGLTemplates/NextBlock/index.html', import.meta.url);
const HTML = readFileSync(PAGE, 'utf8');
const cut = (from, end) => { const a = HTML.indexOf(from); assert.ok(a > 0, `index.html holds ${from.slice(0, 50)}`); return HTML.slice(a, HTML.indexOf(end, a) + end.length); };
const CONTINUE = cut('    function continueToTheNextRound(played) {', '\n      look();\n    }\n');
const CANCEL = cut('    function cancelNextJoin(state) {', '\n      return show(offer);\n    };\n');

const NOW = Date.now();
const played = { stakeMsat: '100000', startTimeMs: String(NOW - 120000) };
const row = (o = {}) => ({ id: 'd8cf7893'.repeat(8), free: false, stakeMsat: '100000', joinable: true, startTimeMs: String(NOW + 60000), entryCloseMs: String(NOW + 90000), ...o });

function page({ balance, rows = [row()], join } = {}) {
  const joins = [];
  const said = [];
  const window = { BLWP_LOBBY_ROWS: rows, BLWP_WALLET_BALANCE: balance, BLWP_CONTINUE: undefined, BLWP_JOIN: join,
    BLWP_ROUND: { id: 'played' }, BLWP_ENTRY: { id: 'entry' }, BLWP_LOBBY_BACK: '',
    BLWP_LOBBY_ACT: { join: (id, opts) => { joins.push([id, opts]); return true; } } };
  const BLWPCLIENT = { nextRoundAfter, lobbyStakeSats };
  const history = { replaceState: () => {} };
  const location = { pathname: '/' };
  const fns = pageFunction(PAGE, ['window', 'BLWPCLIENT', 'history', 'location', 'console', 'setTimeout'], [CONTINUE, CANCEL],
    'return { continueToTheNextRound, cancelNextJoin };')(window, BLWPCLIENT, history, location, { log: (s) => said.push(s) }, () => {});
  return { ...fns, window, joins, said };
}

test('dcd6cbb6\'s case: a next paid round of 100 sat with 73 sat in the player wallet is not entered', () => {
  const p = page({ balance: { sats: 73, pending: 0 } });
  p.continueToTheNextRound(played);
  assert.equal(p.joins.length, 0, 'no join, so no deposit and nothing for Unity to wait on');
  assert.equal(p.window.BLWP_NEXT.state, 'none');
  assert.match(p.said.join('\n'), /not entered - its stake is 100 sat and the player wallet holds 73 sat/);
});

test('a next paid round the wallet can pay is entered, as before', () => {
  const p = page({ balance: { sats: 173, pending: 0 } });
  p.continueToTheNextRound(played);
  assert.equal(p.joins.length, 1);
  assert.equal(p.joins[0][1].next, true);
  assert.equal(p.window.BLWP_NEXT.state, 'joining');
});

test('exactly the stake in the wallet is enough; a free next round needs none; no balance read yet - entered (the deposit guard below covers it)', () => {
  const exact = page({ balance: { sats: 100, pending: 0 } }); exact.continueToTheNextRound(played);
  assert.equal(exact.joins.length, 1);
  const free = page({ balance: { sats: 0, pending: 0 }, rows: [row({ free: true, stakeMsat: '0' })] });
  free.continueToTheNextRound({ stakeMsat: '0', startTimeMs: played.startTimeMs }); assert.equal(free.joins.length, 1);
  const unknown = page({ balance: undefined }); unknown.continueToTheNextRound(played);
  assert.equal(unknown.joins.length, 1);
});

test('a continuing join that reaches a deposit is dropped: refused for Unity, no deposit box, the played round let go', async () => {
  const j = { state: 'joining', round: 'd8cf7893'.repeat(8), next: true, stage: 'stake lock: waiting for the deposit into the player wallet' };
  const p = page({ join: j });
  p.window.BLWP_NEXT = { state: 'joining', round: j.round };
  let shown = 0;
  await assert.rejects(p.window.BLWP_ASK_JOIN_DEPOSIT({ amountMsat: 100000n }, () => { shown++; return Promise.resolve({}); }), /needs a deposit/);
  assert.equal(shown, 0, 'no deposit offer for a round nobody pressed PLAY on');
  assert.deepEqual([j.state, j.cancelled, j.why], ['refused', true, ''], 'Unity reads it refused with no reason and shows the plain lobby');
  assert.equal(p.window.BLWP_NEXT.state, 'none');
  assert.equal(p.window.BLWP_ROUND, undefined);
  assert.notEqual(p.window.BLWP_CONTINUE, false, 'continuing stays on for the next PLAY');
});

test('a join the player pressed PLAY on still gets its deposit offer', async () => {
  const j = { state: 'joining', round: 'aa'.repeat(32), next: false };
  const p = page({ join: j });
  const offered = await p.window.BLWP_ASK_JOIN_DEPOSIT({ amountMsat: 100000n }, () => Promise.resolve('the offer'));
  assert.equal(offered, 'the offer');
  assert.equal(j.state, 'joining');
});

test('exit game drops the next join as before', () => {
  const j = { state: 'joining', round: 'd8cf7893'.repeat(8), next: true };
  const p = page({ join: j });
  p.window.BLWP_NEXT = { state: 'joining', round: j.round };
  p.cancelNextJoin('exited');
  assert.equal(p.window.BLWP_NEXT.state, 'exited');
  assert.deepEqual([j.state, j.cancelled], ['refused', true]);
});
