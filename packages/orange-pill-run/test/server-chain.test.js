// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// #3256: a round posted on chain (ARNO OP_RETURN), open only once the post confirmed; test rounds by hand; one round open at a time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encodeRoundPost, decodeRoundPost, levelHashOf, bitcoinCliChain, POST_MOST } from '../server/opr-chain.mjs';
import { world, openRound, paidAttempt, keypair, logOf, at, MIN, DAY, candles48 } from './server-helpers.mjs';

const fields = { test: false, number: 1, startMs: at('2026-11-23T00:00:00Z'), endMs: at('2026-11-24T00:00:00Z'), entrySats: 100, attempts: 5,
  split: [50, 30, 20], chartDay: '2026-11-22', gameVersion: 'opr-1.0.0', levelHash: levelHashOf({ gameVersion: 'opr-1.0.0', seed: 3, candles: candles48('2026-11-22') }) };

test('#3256 the post encodes and decodes every field, within 80 bytes', () => {
  const b = encodeRoundPost(fields);
  assert.ok(b.length <= POST_MOST, `${b.length} bytes`);
  assert.equal(b.subarray(0, 4).toString(), 'ARNO');
  assert.deepEqual(decodeRoundPost(b), fields);
  const t = encodeRoundPost({ ...fields, test: true, gameVersion: '123456789012345' });
  assert.equal(t.length, 80);
  assert.deepEqual(decodeRoundPost(t), { ...fields, test: true, gameVersion: '123456789012345' });
  assert.throws(() => encodeRoundPost({ ...fields, gameVersion: '1234567890123456' }), /15/);
  assert.throws(() => encodeRoundPost({ ...fields, endMs: fields.startMs }), /ends after/);
  assert.equal(decodeRoundPost(Buffer.from('ARNV0000')), null);
  assert.equal(decodeRoundPost(b.subarray(0, b.length - 1)), null);
});

test('#3256 the wallet path: create, fund, sign, send, then the txid is listed for miner C', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'opr-cli-'));
  const calls = join(dir, 'calls.txt'), pending = join(dir, 'pending.txt');
  const cli = join(dir, 'bitcoin-cli');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('fs'); const a = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(a) + '\\n');
const m = a.find((x) => !x.startsWith('-')) ;
if (m === 'createrawtransaction') console.log('rawhex');
else if (a.includes('fundrawtransaction')) console.log(JSON.stringify({ hex: 'fundedhex', fee: 0.000001 }));
else if (m === 'signrawtransactionwithwallet') console.log(JSON.stringify({ hex: 'signedhex', complete: true }));
else if (m === 'sendrawtransaction') console.log('${'ab'.repeat(32)}');
else if (m === 'gettransaction') console.log(JSON.stringify({ confirmations: 2, blockheight: 162700 }));
`);
  chmodSync(cli, 0o755);
  writeFileSync(pending, 'old\n');
  const c = bitcoinCliChain({ cli, datadir: '/x/tn4', wallet: 'arena-opr', pendingFile: pending });
  const hex = encodeRoundPost(fields).toString('hex');
  assert.equal(await c.post(hex), 'ab'.repeat(32));
  assert.deepEqual(await c.status('ab'.repeat(32)), { confirmations: 2, height: 162700 });
  const lines = readFileSync(calls, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(lines[0], ['-datadir=/x/tn4', '-rpcwallet=arena-opr', 'createrawtransaction', '[]', JSON.stringify([{ data: hex }])]);
  assert.ok(lines[1].includes('hexstring=rawhex'));
  assert.deepEqual(lines[2].slice(2), ['signrawtransactionwithwallet', 'fundedhex']);
  assert.deepEqual(lines[3].slice(2), ['sendrawtransaction', 'signedhex']);
  assert.equal(readFileSync(pending, 'utf8'), `old\n${'ab'.repeat(32)}\n`);
});

test('#3256 a daily round is posted after its level and opens only once the post confirmed; the post carries the round', async () => {
  const w = world({ start: '2026-11-23T00:00:30Z' });
  await w.opr.tick();
  let r = w.opr.roundRow('2026-11-23');
  assert.equal(r.state, 'posting');
  assert.equal(r.chart_day, '2026-11-22');
  await w.opr.tick();
  assert.equal(w.chain.posts.length, 1);
  assert.equal((await w.opr.startAttempt(keypair().pk, {})).ok, false);   // not confirmed: not open
  const d = decodeRoundPost(Buffer.from(w.chain.posts[0].hex, 'hex'));
  assert.deepEqual(d, { ...w.opr.postFields('2026-11-23') });
  assert.equal(d.levelHash, levelHashOf({ gameVersion: 'opr-test-1', seed: 7, candles: candles48('2026-11-22') }));
  w.chain.confirm(); await w.opr.tick();
  r = w.opr.roundRow('2026-11-23');
  assert.equal(r.state, 'ready'); assert.equal(r.post_height, 162700);
  const pub = w.opr.publicRound(r);
  assert.equal(pub.post.txid, w.chain.posts[0].txid); assert.equal(pub.post.confirmed, true); assert.equal(pub.phase, 'open');
  assert.equal((await w.opr.startAttempt(keypair().pk, {})).ok, true);
});

test('#3256 a round whose post never confirms still ends at its end time; an alert 15 minutes after the start', async () => {
  const w = world({ start: '2026-11-23T00:00:00Z' });
  await w.opr.tick(); await w.opr.tick();
  w.clock.set(at('2026-11-23T00:14:00Z')); await w.opr.tick();
  assert.equal(w.alerts.length, 0);
  w.clock.set(at('2026-11-23T00:15:00Z')); await w.opr.tick(); await w.opr.tick();
  assert.equal(w.alerts.length, 1); assert.match(w.alerts[0], /no round open 15 min/);
  w.clock.set(at('2026-11-24T00:00:00Z')); await w.opr.tick();
  assert.equal(w.opr.roundRow('2026-11-23').state, 'closed');
});

test('#3256 a test round: any start, 30 minutes, a past chart day; full path; no bounty list; marked test', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z' });
  const bad = w.opr.testRound({ minutes: 30, chartDay: '2026-11-22' });
  assert.equal(bad.ok, false); assert.match(bad.why, /past, complete/);
  const made = w.opr.testRound({ startMs: at('2026-11-22T10:05:00Z'), minutes: 30, chartDay: '2026-11-21' });
  assert.equal(made.ok, true, made.why);
  const id = made.round.id;
  assert.equal(made.round.test, true); assert.equal(made.round.bountySats, 0);
  await openRound(w, id);
  assert.equal(decodeRoundPost(Buffer.from(w.chain.posts[0].hex, 'hex')).test, true);
  assert.equal(w.opr.publicRound(w.opr.roundRow(id)).phase, 'soon');
  w.clock.set(at('2026-11-22T10:06:00Z'));
  const a = keypair(), b = keypair(); w.link(a.pk); w.link(b.pk);
  for (const [p, n] of [[a, 12], [b, 8]]) {
    const s = await paidAttempt(w, p.pk, id);
    w.clock.add(20000);
    assert.equal(w.opr.submit(p.pk, { attempt: s.attempt, token: s.token, log: logOf(n) }).ok, true);
  }
  assert.equal(w.opr.potOf(id), 200);
  w.clock.set(at('2026-11-22T10:35:00Z')); await w.opr.tick();
  assert.equal(w.opr.roundRow(id).state, 'closed');
  w.clock.add(60 * MIN); await w.opr.tick();
  const lists = w.opr.listsOf(id);
  assert.deepEqual(lists.map((l) => l.kind), ['pot']);   // no real-sats bounty for a test round
  assert.deepEqual(lists[0].rows.map((x) => [x.player, x.sats]), [[a.pk, 120], [b.pk, 80]]);
  assert.equal(lists[0].state, 'waiting');
  assert.equal(w.alerts.length, 1); assert.match(w.alerts[0], /test.*wait for sign-off/);
});

test('#3256 one round open at a time: a test round refuses another, the daily day, and holds the daily round back', async () => {
  const w = world({ start: '2026-11-22T22:00:00Z' });
  assert.equal(w.opr.testRound({ startMs: at('2026-11-22T23:45:00Z'), minutes: 30, chartDay: '2026-11-21' }).why, 'the daily round of 2026-11-23 runs then: one round at a time');
  assert.equal(w.opr.testRound({ minutes: 30, chartDay: '2026-11-21' }).ok, true);
  const two = w.opr.testRound({ startMs: at('2026-11-22T23:00:00Z'), minutes: 20, chartDay: '2026-11-20' });
  assert.equal(two.ok, false); assert.match(two.why, /round test-1 is open or about to open .*one round at a time/);
  // the daily round waits while a test round runs over midnight (daily off when it was made, on again now)
  const v = world({ start: '2026-11-22T23:50:00Z', cfg: { daily: false } });
  assert.equal(v.opr.testRound({ minutes: 30, chartDay: '2026-11-21' }).ok, true);
  v.opr.cfg.daily = true;
  v.clock.set(at('2026-11-23T00:01:00Z'));
  assert.equal(v.opr.ensureDaily(v.clock.now()), null);
  assert.equal(v.opr.roundRow('2026-11-23'), undefined);
  assert.ok(v.lines.some((l) => /daily round 2026-11-23 waits: round test-1/.test(l)));
  v.clock.set(at('2026-11-23T00:20:00Z')); await v.opr.tick();
  assert.equal(v.opr.roundRow('test-1').state, 'closed');
  assert.equal(v.opr.roundRow('2026-11-23').state, 'posting');
  // a daily round open: no test round
  const d = world({ start: '2026-11-24T08:00:00Z' });
  await openRound(d);
  const t3 = d.opr.testRound({ minutes: 30, chartDay: '2026-11-21' });
  assert.equal(t3.ok, false); assert.match(t3.why, /one round at a time/);
});

test('#3256 test rounds are hidden from the public routes unless the stage shows them', async () => {
  const w = world({ start: '2026-11-22T10:00:00Z', cfg: { showTest: false } });
  assert.equal(w.opr.testRound({ minutes: 30, chartDay: '2026-11-21' }).ok, true);
  await openRound(w, 'test-1');
  assert.equal(w.opr.currentRound(), null);
  assert.equal((await w.opr.startAttempt(keypair().pk, { round: 'test-1' })).ok, false);
  void DAY;
});
