// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 a44 refute of #1630 (skeptic 3): #1630 says "the same for <db>.operator-tokens.json" and STATE-MACHINES SM-O1 says a file
// that exists but does not parse is read from its .bak, "with no good .bak the node refuses to start (DurableJsonUnreadable)". main.js's
// store does throw - but createOperatorTokens (operator-tokens.js) wraps store.read() in try { } catch { return [] }, so the throw is
// swallowed: the node starts over a torn tokens file (as an older build's crash in its plain writeFileSync leaves it, no .bak), mints a
// fresh first pairing token and writes [that one] over the file - every paired operator UI is dropped, silently. The real process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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

test('#1489 a44-refute-32-s3-1: a torn operator-tokens.json with no good .bak is started over (tokens dropped, a new pairing minted) instead of refused', { timeout: 120000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-a44-32-s3-1-'));
  const store = join(dir, 'node.db');
  // 1. first start: the node mints its first pairing token and keeps it durably (file + .bak)
  let child = startMain(store);
  await child.up;
  child.kill('SIGTERM'); await child.exited;
  const good = readFileSync(`${store}.operator-tokens.json`, 'utf8');
  // a bare list, or { tokens, paired } since kanban #2548 (merged onto 1.9, kanban #2536)
  const parsed = JSON.parse(good), kept = Array.isArray(parsed) ? parsed : parsed.tokens;
  assert.ok(Array.isArray(kept) && kept.length >= 1, 'the first start keeps a pairing token');
  // 2. the file as an older build's crash in its plain write left it (truncated mid-write), and no good .bak (that build wrote none;
  //    here the .bak is torn as well, standing for "no good copy")
  const torn = good.slice(0, Math.floor(good.length / 2));
  writeFileSync(`${store}.operator-tokens.json`, torn);
  if (existsSync(`${store}.operator-tokens.json.bak`)) writeFileSync(`${store}.operator-tokens.json.bak`, torn);
  const pairingBefore = existsSync(`${store}.operator-pairing`) ? readFileSync(`${store}.operator-pairing`, 'utf8') : null;
  // 3. start again
  child = startMain(store);
  let started = true;
  try { await child.up; } catch { started = false; }
  if (started) { child.kill('SIGTERM'); }
  await child.exited;
  const after = readFileSync(`${store}.operator-tokens.json`, 'utf8');
  const pairingAfter = existsSync(`${store}.operator-pairing`) ? readFileSync(`${store}.operator-pairing`, 'utf8') : null;
  let ids = null; try { const p = JSON.parse(after); ids = (Array.isArray(p) ? p : p.tokens).map((t) => t.id); } catch { ids = 'unparsed'; }
  console.log(`  #1489 a44-32-s3-1 torn tokens file, no good .bak: node ${started ? 'STARTED' : 'refused'}; tokens file ${after === torn ? 'left as it was' : `REWRITTEN (ids ${JSON.stringify(ids)}; before ${JSON.stringify(kept.map((t) => t.id))})`}; pairing ${pairingAfter === pairingBefore ? 'unchanged' : 'NEW one written'}`);
  assert.equal(started, false, 'SM-O1: a node whose operator-tokens.json exists but does not parse, with no good .bak, refuses to start (DurableJsonUnreadable) - it started');
  assert.equal(after, torn, 'the torn tokens file was written over with a fresh list: every paired operator UI is gone');
});
