// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2773 (2026-11-21 13:15Z): 100,000,256 msat of e-cash sent from gw-c to gw-b in federation 337ae01a (gateway-cli ecash send on
// gw-c, ecash receive on gw-b). Neither payment log records it (measured: only lightning events in 13:00-13:40Z), so gw-c showed
// "100,000 sat left the e-cash balance with no payment to explain it" and the watcher stayed red for hours. A drop matched by the same
// rise on another of our gateways, or announced, is a move; a drop with neither stays red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readGateway } from '../src/hosts.js';
import { netMoves } from '../src/gateway-loss.js';
import { config, pass } from '../tools/health-watcher.mjs';

const FED = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e';
const T = Date.UTC(2026, 10, 21, 13, 15, 23);
const SENT = 100000256n;

// one fake gateway: its balance in FED, an empty payment log (as both logs read around the move)
function gw(name, msat) {
  const g = { name, msat };
  g.fetcher = async (url, opts = {}) => {
    const p = new URL(url).pathname, j = (b) => ({ ok: true, status: 200, json: async () => b });
    if (p === '/v1/info') return j({ gateway_state: 'Running', federations: [{ federation_id: FED, federation_name: 'blwp-testnet4', balance_msat: Number(g.msat) }] });
    if (p === '/v1/balances') return j({});
    if (p === '/v1/payment_summary') return j(null);
    if (p === '/v1/payment_log') return j([]);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  return g;
}

function watcher(gws, { moves = [] } = {}) {
  const cfg = config({ HW_STATE: '/nonexistent/hw.json', HW_HOST_SEATS: 'http://127.0.0.1:1', HW_MAC_SEATS: 'http://127.0.0.1:2', HW_SIGNAL_TO: '+10000000000',
    HW_GATEWAYS: gws.map((g) => `${g.name},http://${g.name},/x/pw`).join(';') }, []);
  const w = { now: T - 180000, posts: [], signals: [], moves };
  w.io = { now: () => w.now, loadavg: async () => [1, 1, 1], identity: async () => ({ ok: true, key: 'ab'.repeat(32) }), get: async () => ({ ok: false, why: 'HTTP 404' }),
    units: async () => ({}), post: async (t) => { w.posts.push(t); }, signal: async (t) => { w.signals.push(t); }, gatewayMoves: async () => w.moves,
    gateway: (c, prev) => { const g = gws.find((x) => x.name === c.name); return readGateway(c, { prev, fetcher: g.fetcher, readPassword: () => 'pw', nowMs: w.now }); } };
  w.pass = async () => { w.r = await pass(w.io, cfg, w.r ? w.r.state : {}); w.now += 180000; return w.r; };
  return w;
}
const red = (r, name) => r.problems.some((p) => p.key === `gateway:${name}` && p.alert);
const moved = (r) => r.problems.filter((p) => /^gateway-move:/.test(p.key)).map((p) => p.title);

test('#2773 the 13:15Z move gw-c -> gw-b in one interval: a plain "moved" line, never red', async () => {
  const c = gw('gw-c', 198136817152n), b = gw('gw-b', 25079296n), a = gw('gw-a', 618509824n);
  const w = watcher([a, b, c]);
  await w.pass();                                     // the readings before the move
  c.msat -= SENT; b.msat += SENT;                     // gateway-cli ecash send on gw-c, ecash receive on gw-b
  const r = await w.pass();
  assert.equal(red(r, 'gw-c'), false, r.problems.map((p) => p.key + ' ' + p.title).join('\n'));
  assert.deepEqual(moved(r), ['moved 100,000 sat gw-c -> gw-b (337ae01a, 13:15 UTC)']);
  for (let i = 0; i < 3; i++) { const r2 = await w.pass(); assert.equal(red(r2, 'gw-c'), false); assert.equal(moved(r2).length, 1); }
  assert.equal(w.signals.length, 0); assert.equal(w.posts.filter((t) => /gateway/.test(t)).length, 0);
});

test('#2773 the receive lands in the next reading (neighbouring interval), and a receive 1 sat off: still a move, never red', async () => {
  const c = gw('gw-c', 198136817152n), b = gw('gw-b', 25079296n);
  const w = watcher([b, c]);                           // gw-b read before gw-c in a pass
  await w.pass();
  c.msat -= SENT;
  const r1 = await w.pass();
  assert.equal(red(r1, 'gw-c'), false, 'one pass for the matching receive');
  assert.equal(r1.facts.gateways.find((g) => g.name === 'gw-c').warning.level, 'warn');
  b.msat += SENT - 1000n;
  const r2 = await w.pass();
  assert.equal(red(r2, 'gw-c'), false);
  assert.deepEqual(moved(r2), ['moved 100,000 sat gw-c -> gw-b (337ae01a, 13:15 UTC)']);
  assert.equal(w.signals.length, 0);
});

test('#2773 an unmatched drop stays red (and a rise of another size, or in another federation, does not explain it)', async () => {
  const c = gw('gw-c', 198136817152n), b = gw('gw-b', 25079296n);
  const w = watcher([b, c]);
  await w.pass();
  c.msat -= SENT; b.msat += SENT / 2n;
  await w.pass();
  const r = await w.pass();
  assert.equal(red(r, 'gw-c'), true);
  assert.match(r.problems.find((p) => p.key === 'gateway:gw-c').lines.join(' '), /100,000 sat left the e-cash balance with no payment to explain it/);
  assert.deepEqual(moved(r), []);
  assert.equal(w.signals.length, 1);
  // another federation's rise is not the other end
  const g1 = { name: 'gw-c', readAtMs: T, watch: { drops: [{ federation: FED, unexplainedMsat: String(SENT), over: true, fromMs: T - 180000, toMs: T - 180000 }] } };
  const g2 = { name: 'gw-b', readAtMs: T, watch: { drops: [], rises: [{ federation: 'b18947f0', msat: String(SENT), fromMs: T - 180000, toMs: T }] } };
  assert.deepEqual(netMoves([g1, g2]), []);
  assert.equal(g1.watch.drops[0].moved, undefined);
});

test('#2773 an announced move (ops/gateway-moves.json) explains the drop; one announcement explains one drop', async () => {
  const c = gw('gw-c', 198136817152n);
  const w = watcher([c], { moves: [{ from: 'gw-c', to: 'gw-x', federation: '337ae01a', msat: '100000256', atMs: T - 60000 }] });
  await w.pass();
  c.msat -= SENT;
  const r = await w.pass();
  assert.equal(red(r, 'gw-c'), false);
  assert.deepEqual(moved(r), ['moved 100,000 sat gw-c -> gw-x (337ae01a, 13:15 UTC, announced)']);
  c.msat -= SENT;                                     // the same amount again: not announced
  await w.pass();
  const r2 = await w.pass();
  assert.equal(red(r2, 'gw-c'), true);
  // announced for another time: does not explain it
  const g1 = { name: 'gw-c', readAtMs: T, watch: { drops: [{ federation: FED, unexplainedMsat: String(SENT), over: true, fromMs: T - 180000, toMs: T - 180000 }] } };
  assert.deepEqual(netMoves([g1], { announced: [{ from: 'gw-c', to: 'gw-b', federation: '337ae01a', msat: String(SENT), atMs: T + 3600000 }] }), []);
});
