// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 state machine audit round 2 (node lifecycle): THE OWNER BINDING ACROSS A CRASH. main.js keeps the owner
// (claimed, leaving, settings) in <db>.owner.json, written with a plain writeFileSync (truncate, then write) on every claim,
// leave, stay and settings. A node killed or a machine losing power between the truncate and the write leaves the file empty;
// at the next start store.read() answers null for "unreadable" exactly as for "absent", and the node starts UNCLAIMED: a fresh
// claim code, its signed GET /owner statement says no owner, the owner's leave is gone (the seat takes new rounds again) and
// the owner's signed requests are refused. The test drives the real process: claim, leave, SIGTERM, the file as a crash in
// that write leaves it, start again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { schnorr } from '@noble/curves/secp256k1.js';
import { signOwnerRequest } from '../src/owner.js';

const MAIN = new URL('../src/main.js', import.meta.url).pathname;
const CWD = new URL('..', import.meta.url).pathname;

function startMain(store) {
  const child = spawn(process.execPath, [MAIN, '0', store], { cwd: CWD, env: { ...process.env, ARENA_BITCOIND_URL: '', ARENA_BITCOIND_COOKIE: '',
    ARENA_STAKE_LOCK_BIN: '', ARENA_FEDERATION_CLIENT_DIR: '', ARENA_APPS: '',
    PATH: process.env.PATH.split(':').filter((d) => !/fedimint|patched/.test(d)).join(':') }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.out = ''; child.err = '';
  child.stdout.on('data', (d) => { child.out += d; });
  child.stderr.on('data', (d) => { child.err += d; });
  child.exited = new Promise((r) => child.on('exit', (code, signal) => r({ code, signal })));
  child.up = new Promise((resolve, reject) => {
    const look = setInterval(() => { const m = /arena-node on http:\/\/[^:]+:(\d+)/.exec(child.out); if (m) { clearInterval(look); resolve(Number(m[1])); } }, 50);
    child.exited.then((e) => { clearInterval(look); reject(new Error(`main.js exited ${e.code}: ${child.err.trim().split('\n').slice(-3).join(' | ')}`)); });
  });
  child.up.catch(() => {});
  return child;
}
const getJson = async (port, path) => (await fetch(`http://127.0.0.1:${port}${path}`)).json();
const post = async (port, path, body) => { const r = await fetch(`http://127.0.0.1:${port}${path}`, { method: 'POST', body: JSON.stringify(body), headers: { 'content-type': 'application/json' } }); return { status: r.status, body: await r.json() }; };

test('#1489 sm2-node-1: an owner.json torn by a crash in its write turns a claimed, leaving node into an unclaimed one with a new claim code', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm2-node-1-'));
  const store = join(dir, 'node.db');
  const secret = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey();
  const ownerKey = Buffer.from(schnorr.getPublicKey(secret)).toString('hex');
  // 1. first start: the claim code, the claim, the leave
  let child = startMain(store);
  let port = await child.up;
  const st0 = await getJson(port, '/owner');
  assert.equal(st0.claimed, false);
  const code = readFileSync(`${store}.owner-claim`, 'utf8').trim();
  const sig = (action, args) => signOwnerRequest({ node: st0.node, action, args, secret, sign: (m, s) => schnorr.sign(m, s), pubkeyOf: (s) => schnorr.getPublicKey(s) });
  const c = await post(port, '/owner/claim', sig('claim', { code }));
  assert.equal(c.status, 200, JSON.stringify(c.body));
  const l = await post(port, '/owner/leave', sig('leave', {}));
  assert.equal(l.status, 200, JSON.stringify(l.body));
  const st1 = await getJson(port, '/owner');
  assert.equal(st1.claimed, true); assert.equal(st1.owner, ownerKey); assert.ok(st1.leavingAtMs);
  child.kill('SIGTERM'); await child.exited;
  // 2. the crash: writeFileSync opened owner.json with O_TRUNC, the process died before its bytes landed (or the machine lost power
  // before they reached the disk): the file is there, empty
  writeFileSync(`${store}.owner.json`, '');
  // 3. the node starts again
  child = startMain(store);
  port = await child.up;
  const st2 = await getJson(port, '/owner');
  const newCode = existsSync(`${store}.owner-claim`);
  const stay = await post(port, '/owner/stay', sig('stay', {}));
  child.kill('SIGTERM'); await child.exited;
  console.log(`  #1489 sm2-node-1 after a torn owner.json: claimed ${st2.claimed}, owner ${st2.owner ? st2.owner.slice(0, 12) : 'none'}, leaving ${st2.leavingAtMs ?? 'no'}, a new claim code ${newCode ? 'WRITTEN' : 'not written'}; the owner's signed stay answered ${stay.status} (${stay.body.why || 'ok'})`);
  rmSync(dir, { recursive: true, force: true });
  assert.notEqual(st2.claimed === false && newCode, true, 'a claimed node came back unclaimed, with a fresh claim code anyone holding the machine\'s files can use');
  assert.equal(st2.owner, ownerKey, 'the node no longer names its owner');
  assert.ok(st2.leavingAtMs, 'the owner\'s leave is forgotten: the seat takes new rounds again');
});
