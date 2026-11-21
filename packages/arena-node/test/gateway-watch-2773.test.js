// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #2773: the gateway money-loss watch - the #2771 signs (failed incoming payments "note already spent", a balance drop no
// payment explains, notes the guardians count as spent) turn a gateway red; a healthy gateway's log does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import { failuresOf, explainedMsat, balanceCheck, deadNotes, notesInDump, gatewayWarning, readPaymentLog } from '../src/gateway-loss.js';
import { readGateway, hostsReader } from '../src/hosts.js';

const T0 = Date.UTC(2026, 10, 14, 17, 0);
const us = (ms) => ms * 1000;
const img = (h) => ({ Hash: h.padEnd(64, '0') });
let id = 0;
const ev = (kind, atMs, payload, module = 'lnv2') => ({ id: ++id, kind, module: { kind: module, id: 0 }, ts_usecs: us(atMs), payload });
const inStart = (h, at, amount) => ev('incoming-payment-started', at, { incoming_contract_commitment: { amount, payment_image: img(h) } });
const inOk = (h, at) => ev('incoming-payment-succeeded', at, { payment_image: img(h) });
const inFail = (h, at, error = 'The transaction had an invalid input: 2-The note is already spent') => ev('incoming-payment-failed', at, { error, payment_image: img(h) });
const outStart = (h, at, amount) => ev('outgoing-payment-started', at, { outgoing_contract: { amount, payment_image: img(h) } });
const outOk = (h, at) => ev('outgoing-payment-succeeded', at, { payment_image: img(h), target_federation: null });

// gw-c on 11-14, as its log read: a good receive, then 17:44 one funded with a dead note
const gwc = [inStart('aa', T0, 305000), inOk('aa', T0 + 3000), inStart('b8', T0 + 44 * 60000, 8858988544), inFail('b8', T0 + 44 * 60000 + 2000)];
const healthy = [inStart('c1', T0, 305000), inOk('c1', T0 + 3000), outStart('d1', T0 + 60000, 1708345), outOk('d1', T0 + 62000)];

test('#2773 failures: "already spent" is counted by name with what it put at stake; a healthy log has none', () => {
  const f = failuresOf(gwc, { nowMs: T0 + 3600000 });
  assert.equal(f.failed, 1); assert.equal(f.alreadySpent, 1); assert.equal(f.failedMsat, '8858988544');
  assert.match(f.lastError, /already spent/);
  assert.equal(failuresOf(healthy, { nowMs: T0 + 3600000 }).failed, 0);
  // older than 24 h: out of the window
  assert.equal(failuresOf(gwc, { nowMs: T0 + 2 * 86400000 }).failed, 0);
});

test('#2773 balance: payments explain the move; the #2771 refund loss is a drop nothing explains', () => {
  const at0 = T0 - 1000, at1 = T0 + 3600000;
  // healthy: -305000 funded, +1708345 claimed
  assert.equal(explainedMsat(healthy, at0, at1), 1708345n - 305000n);
  const ok = balanceCheck({ atMs: at0, ecashMsat: '10000000000' }, { atMs: at1, ecashMsat: String(10000000000n - 305000n + 1708345n) }, healthy);
  assert.equal(ok.over, false); assert.equal(ok.unexplainedMsat, '0');
  // gw-c: the failed payment's funding should have come back; it did not (the refund itself was rejected)
  const before = 105739638272n;
  const after = before - 305000n - 8858988544n;   // the good receive funded, the failed one's inputs stranded
  const bad = balanceCheck({ atMs: at0, ecashMsat: String(before) }, { atMs: at1, ecashMsat: String(after) }, gwc);
  assert.equal(bad.over, true); assert.equal(bad.unexplainedMsat, '8858988544');
  // a rise (a peg-in) is never a warning
  assert.equal(balanceCheck({ atMs: at0, ecashMsat: '1' }, { atMs: at1, ecashMsat: '999999999' }, []).over, false);
});

test('#2773 e-cash sent and received count in the explanation; a rejected receive does not', () => {
  const evs = [ev('payment-send', T0 + 1, { amount: 5000000000 }, 'mintv2'), ev('payment-receive', T0 + 2, { amount: 1000448, operation_id: 'o1' }, 'mintv2'),
    ev('payment-receive-update', T0 + 3, { operation_id: 'o1', status: 'Rejected' }, 'mintv2'),
    ev('payment-receive', T0 + 4, { amount: 2000, operation_id: 'o2' }, 'mintv2'), ev('payment-receive-update', T0 + 5, { operation_id: 'o2', status: 'Success' }, 'mintv2')];
  assert.equal(explainedMsat(evs, T0, T0 + 10), -5000000000n + 2000n);
  const f = failuresOf(evs, { nowMs: T0 + 10 });
  assert.equal(f.failed, 1); assert.equal(f.rejectedReceives, 1);
});

const nonceOf = (sk) => createHash('ripemd160').update(createHash('sha256').update(secp256k1.getPublicKey(Buffer.from(sk, 'hex'), true)).digest()).digest('hex');

test('#2773 dead notes: a wallet note the guardians count as spent is found in a dbtool dump', () => {
  const fed = '337ae01ad1e9bb35b5628faad3457e62d69d036efe8a34bcfc20cb31b42bb75e';
  const sk = (b) => b.repeat(64).slice(0, 64);
  const row = (d, k) => `10${fed}ff0220${d.toString(16).padStart(2, '0')}${k}${'ab'.repeat(48)} `;
  const dump = [row(9, sk('1')), row(30, sk('2')), row(12, sk('3')), `10${fed}a2${'00'.repeat(40)} 00`];
  const notes = notesInDump(dump, fed, 2);
  assert.equal(notes.length, 3);
  const spent = new Set([nonceOf(sk('2'))]);
  assert.deepEqual(deadNotes(notes, spent, nonceOf), { notes: 3, dead: 1, deadMsat: String(1n << 30n) });
  assert.equal(deadNotes(notes, new Set(), nonceOf).dead, 0);
});

test('#2773 the warning: red with "already spent", a drop or a dead note; a plain failure is only a warning', () => {
  const nowMs = T0 + 3600000;
  const red = gatewayWarning('gw-c', { failures: failuresOf(gwc, { nowMs }), drops: [{ over: true, unexplainedMsat: '8858988544' }], dead: { dead: 62, deadMsat: '72586682368', notes: 300 } });
  assert.equal(red.level, 'bad');
  assert.match(red.text, /^gw-c: 1 failed payment in 24 h \(1 "note already spent"\), 8,858,988 sat at stake; 8,858,988 sat left the e-cash balance/);
  assert.match(red.text, /62 dead notes \(72,586,682 sat\)/);
  const expired = gatewayWarning('gw-a', { failures: failuresOf([inStart('e1', T0, 1000), inFail('e1', T0 + 1, 'invoice expired')], { nowMs }) });
  assert.equal(expired.level, 'warn');
  assert.equal(gatewayWarning('gw-b', { failures: failuresOf(healthy, { nowMs }) }).level, 'ok');
});

test('#2773 the log read pages back to the window and keeps each event once', async () => {
  const all = []; id = 1000;
  for (let i = 0; i < 450; i++) all.push(inStart(`p${i}`, T0 - (450 - i) * 600000, 1000));   // one every 10 min, newest last
  const asked = [];
  const post = async (path, body) => { asked.push(body.end_position); const newest = all.filter((e) => body.end_position == null || e.id <= body.end_position).sort((a, b) => b.id - a.id); return newest.slice(0, body.pagination_size); };
  const got = await readPaymentLog(post, 'f', { sinceMs: T0 - 86400000, pageSize: 100 });
  assert.equal(new Set(got.map((e) => e.id)).size, got.length);
  assert.ok(got.length >= 144 && got.length <= 300, `read ${got.length}`);
  assert.ok(asked.length >= 2 && asked.length <= 3);
});

test('#2773 the node reads its gateway\'s log and judges it: the dashboard\'s hosts.gateway carries the warning, red for gw-c', async () => {
  const nowMs = T0 + 3600000;
  let balance = 105739638272n;
  const fetcher = async (url, opts = {}) => {
    const p = new URL(url).pathname, j = (b) => ({ ok: true, status: 200, json: async () => b });
    if (p === '/v1/info') return j({ gateway_state: 'Running', federations: [{ federation_id: 'f1', federation_name: 'A', balance_msat: Number(balance) }] });
    if (p === '/v1/balances') return j({});
    if (p === '/v1/payment_summary') return j(null);
    if (p === '/v1/payment_log') { const b = JSON.parse(opts.body); assert.equal(b.federation_id, 'f1'); return j(b.end_position == null ? [...gwc].reverse() : []); }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  let t = T0 - 1000;
  const r = hostsReader({ gateway: { name: 'gw-c', base: 'http://gw', passwordFile: '/x' } }, { now: () => t,
    readGatewayWith: (g, o) => readGateway(g, { ...o, fetcher, readPassword: () => 'pw' }) });
  await r.refresh();
  assert.equal(r.snapshot().gateway.warning.level, 'ok');    // the first reading: nothing in its window yet, no balance to compare
  t = nowMs; balance -= 305000n + 8858988544n;
  await r.refresh();
  const g = r.snapshot().gateway;
  assert.equal(g.warning.level, 'bad');
  assert.match(g.warning.text, /left the e-cash balance with no payment to explain it/);
  assert.equal(g.watch.failures.alreadySpent, 1);
});

test('#2773 the health watcher: a red gateway goes to the chat and to Signal at once, "again" after an hour, "resolved" when it clears', async () => {
  const { config, pass } = await import('../tools/health-watcher.mjs');
  const cfg = config({ HW_STATE: '/nonexistent/hw.json', HW_HOST_SEATS: 'http://127.0.0.1:1', HW_MAC_SEATS: 'http://127.0.0.1:2', HW_GATEWAYS: 'gw-c,http://127.0.0.1:31290,/x/password', HW_SIGNAL_TO: '+10000000000' }, []);
  assert.equal(cfg.gateways[0].name, 'gw-c');
  let now = T0 + 3600000, warning = gatewayWarning('gw-c', { failures: failuresOf(gwc, { nowMs: now }) });
  const posts = [], signals = [], prevs = [];
  const io = { now: () => now, loadavg: async () => [1, 1, 1], identity: async () => ({ ok: true, key: 'ab'.repeat(32) }), get: async () => ({ ok: false, why: 'HTTP 404' }),
    units: async () => ({}), post: async (t) => { posts.push(t); }, signal: async (t) => { signals.push(t); },
    gateway: async (g, prev) => { prevs.push(prev); return { name: g.name, readAtMs: now, federations: [{ id: 'f1', ecashMsat: '1' }], watch: { failures: failuresOf(gwc, { nowMs: now }), drops: [] }, warning }; } };
  let r = await pass(io, cfg, {});
  assert.ok(r.problems.some((p) => p.key === 'gateway:gw-c' && p.alert));
  assert.equal(signals.length, 1); assert.match(signals[0], /#2773 .*PROBLEM: gateway gw-c: money at risk/); assert.match(signals[0], /note already spent/);
  assert.ok(posts.some((t) => /gateway gw-c: money at risk/.test(t)));
  now += 180000; r = await pass(io, cfg, r.state);
  assert.equal(signals.length, 1, 'not again within the hour');
  assert.equal(prevs[1].federations[0].ecashMsat, '1', 'the last reading is kept for the balance check');
  warning = { level: 'ok', text: 'gw-c: fine', parts: [] };
  for (let i = 0; i < 2; i++) { now += 180000; r = await pass(io, cfg, r.state); }
  assert.equal(signals.length, 2); assert.match(signals[1], /RESOLVED: gateway gw-c: money at risk/);
});
