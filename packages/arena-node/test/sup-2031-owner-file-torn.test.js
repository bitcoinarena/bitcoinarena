// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// Adapted to 1.9 by #2536 (kanban #2031): the card's kept-json.js did not reach 1.9; the same durable write is durable-json.js (#1630). The
// first test is unchanged; the second uses readDurableJson; the third takes any non-zero exit (1.9 throws, exit 1).
// kanban #1489 state machine audit, round 6, area node (finding 2): the owner binding (node.db.owner.json: the owner key, its leave, its
// settings) is rewritten in place by main.js (`writeFileSync`: truncate, then write; no temp file, no fsync, no copy beside it) on every
// claim, Leave, Stay and settings change. A node killed or powered off inside that write leaves the file empty or half; at the next start
// `read()` answers null for a file that does not parse, and the node starts as one that has NO owner: a new claim code, the owner's key
// refused (every owner door 409 "no owner yet"), and a seat that was leaving takes new rounds again. state.json and the update journal
// write atomically with a .bak since #1178/#1166; this file does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { ownerSecretFromSeed, signOwnerRequest } from '../src/owner.js';
import { toHex } from '../../arena-protocol/src/hash.js';

const MAIN = new URL('../src/main.js', import.meta.url).pathname;
const CWD = new URL('..', import.meta.url).pathname;

function startMain(store) {
  const child = spawn(process.execPath, [MAIN, '0', store], { cwd: CWD, env: { ...process.env, ARENA_BITCOIND_URL: '', ARENA_BITCOIND_COOKIE: '', ARENA_STAKE_LOCK_BIN: '',
    ARENA_FEDERATION_CLIENT_DIR: '', ARENA_APPS: '', PATH: process.env.PATH.split(':').filter((d) => !/fedimint|patched/.test(d)).join(':') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = ''; child.err = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.err += d; });
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  child.up = new Promise((resolve, reject) => {
    const look = setInterval(() => { const m = /arena-node on http:\/\/[^:]+:(\d+)/.exec(child.out); if (m) { clearInterval(look); resolve(Number(m[1])); } }, 50);
    child.exited.then((e) => { clearInterval(look); reject(new Error(`main.js exited ${e.code}: ${child.err.trim().split('\n').slice(-3).join(' | ')}`)); });
  });
  return child;
}

test('wf1489-sm6-node-2: a node killed while it rewrites its owner file starts again with its owner and its leave', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm6-node-2-'));
  const store = join(dir, 'node.db');
  const secret = ownerSecretFromSeed(new Uint8Array(32).fill(7));
  const pub = toHex(schnorr.getPublicKey(secret));
  const sign = (node, action, args = {}) => signOwnerRequest({ node, action, args, secret, sign: (m, k) => schnorr.sign(m, k), pubkeyOf: (k) => schnorr.getPublicKey(k) });
  let a = startMain(store), b = null;
  try {
    const port = await a.up;
    const base = `http://127.0.0.1:${port}`;
    const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const node = (await (await fetch(`${base}/owner`)).json()).node;
    const code = readFileSync(`${store}.owner-claim`, 'utf8').trim();
    assert.equal((await post('/owner/claim', sign(node, 'claim', { code }))).status, 200);
    const left = await (await post('/owner/leave', sign(node, 'leave'))).json();
    assert.equal(left.ok, true);
    const before = await (await fetch(`${base}/owner`)).json();
    // the next owner write (a Stay, a settings change) is cut by a kill / power loss after writeFileSync truncated the file
    a.kill('SIGKILL'); await a.exited;
    const was = readFileSync(`${store}.owner.json`, 'utf8');
    writeFileSync(`${store}.owner.json`, was.slice(0, 0));   // what the truncating open leaves when nothing after it reached the disk
    b = startMain(store);
    const port2 = await b.up;
    const after = await (await fetch(`http://127.0.0.1:${port2}/owner`)).json();
    console.log(`  before the kill: claimed ${before.claimed}, owner ${String(before.owner).slice(0, 12)}, leaving ${before.leavingAtMs}; after the restart: claimed ${after.claimed}, owner ${after.owner}, leaving ${after.leavingAtMs}, a new claim file ${existsSync(`${store}.owner-claim`)}`);
    assert.equal(before.claimed, true);
    assert.equal(after.claimed, true, 'the node still has its owner after a write cut by a crash');
    assert.equal(after.owner, pub);
    assert.equal(after.leavingAtMs, before.leavingAtMs, 'and its owner\'s Leave stands');
  } finally {
    a.kill('SIGKILL'); if (b) b.kill('SIGKILL');
  }
});

// kanban #2031 on 1.9's durable-json.js (#1630, the card's keptJson did not reach 1.9): the file is kept whole beside a .bak; one that reads
// neither way refuses (never "no owner")
test('#2031 (1.9): readDurableJson reads the .bak for a torn file and refuses a file that reads neither way', async () => {
  const { readDurableJson, writeDurableJson, DurableJsonUnreadable } = await import('../src/durable-json.js');
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm6-node-2k-'));
  const f = join(dir, 'node.db.owner.json');
  assert.equal(readDurableJson(f, null), null, 'never written: no owner');
  writeDurableJson(f, { pubkey: 'ab', leaving: { atMs: 5 } });
  assert.deepEqual(JSON.parse(readFileSync(`${f}.bak`, 'utf8')), { pubkey: 'ab', leaving: { atMs: 5 } });
  writeFileSync(f, '{"pubkey":"a');
  assert.deepEqual(readDurableJson(f, null), { pubkey: 'ab', leaving: { atMs: 5 } }, 'a torn file reads from its .bak');
  writeFileSync(f, '');
  writeFileSync(`${f}.bak`, '');
  assert.throws(() => readDurableJson(f, null), (e) => e instanceof DurableJsonUnreadable && e.message.includes(f));
  const old = join(dir, 'old.json');   // a file an older node wrote, no .bak beside it
  writeFileSync(old, '[1]\n');
  assert.deepEqual(readDurableJson(old, []), [1]);
  writeFileSync(old, '[1');
  assert.throws(() => readDurableJson(old, []), DurableJsonUnreadable);
});

test('wf1489-sm6-node-2: a node whose owner file reads neither from itself nor its .bak does not start, and names the file', { timeout: 60000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm6-node-2r-'));
  const store = join(dir, 'node.db');
  writeFileSync(`${store}.owner.json`, '{"pubkey":"ab');
  const c = startMain(store);
  await assert.rejects(c.up, /exited [1-9]/);   // 1.9 throws DurableJsonUnreadable at start (exit 1); the card's build exited 2
  assert.match(c.err, /owner\.json does not read/);
  assert.equal(existsSync(`${store}.owner-claim`), false, 'no new claim code over a node that has an owner');
});
