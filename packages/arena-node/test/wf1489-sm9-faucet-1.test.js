// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 sm9-faucet-1 (state-machine audit, crash-restart): the faucet's request handler parses req.url with new URL() before any try, and the
// process has no uncaughtException handler. One request whose target new URL() cannot parse ("//[") throws inside the 'request' listener and kills the
// whole faucet: every grant, refill and reward claim in flight is cut between its payment and its record, and every limit kept only in memory
// (REPORTS per address and per day, ADDR_CHECKS, SHOT_UPLOADS, LN_ASKS, NODE_CHECK_ASKS) starts again from zero when the unit restarts it.
// Invariant: no request kills the faucet; an address's report limit for the day holds across the faucet's restart.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { connect } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEEDBACK_PER_IP_PER_DAY } from '../src/faucet.js';

const FAUCET = fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('#1489 sm9-faucet-1: one malformed request target kills the faucet, and its restart forgets the day\'s report limits', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm9-faucet-1-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') };
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    const c = spawn(process.execPath, [FAUCET], { stdio: ['ignore', 'ignore', 'pipe'], env });
    c.exitedWith = null; c.on('exit', (code, sig) => { c.exitedWith = code ?? sig; });
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/rewards`); return c; } catch { await sleep(100); } }
    return c;
  };
  const send = async (i) => (await (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '10.7.7.7' },
    body: JSON.stringify({ text: `the lobby froze again after the second round, report ${i}` }) })).json());
  let faucet = await start(), second = null;
  try {
    const firstDay = [];
    for (let i = 0; i < FEEDBACK_PER_IP_PER_DAY + 1; i++) firstDay.push((await send(i)).ok ? 'ok' : 'refused');
    // ONE RAW REQUEST: an absolute-looking target the URL parser refuses
    await new Promise((r) => { const s = connect(port, '127.0.0.1', () => s.end('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n')); s.on('close', r); s.on('error', r); s.resume(); });
    await sleep(500);
    const died = faucet.exitedWith !== null;
    // as the unit's Restart= would: the same faucet on the same files
    if (died) second = await start();
    const after = died ? await send(999) : { ok: false, why: 'not restarted' };
    const facts = { limit: FEEDBACK_PER_IP_PER_DAY, keptBefore: firstDay.filter((x) => x === 'ok').length, lastBefore: firstDay.at(-1), died, exit: faucet.exitedWith,
      afterRestart: after.ok ? 'taken' : after.why };
    console.log('  FACTS sm9-faucet-1:', JSON.stringify(facts));
    assert.equal(died, false, 'a single request with the target "//[" killed the faucet process');
    assert.notEqual(after.ok, true, 'after the restart the same address had its whole day\'s report budget again');
  } finally {
    faucet.kill(); if (second) second.kill(); chat.close();
  }
});

// kanban #2284: the day's report limit holds across any restart of the faucet (a deploy, the unit's Restart=), not only one the request above caused
test('#2284: an address that sent its day\'s reports is still refused after the faucet restarts on the same files', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-sm9-faucet-1b-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  const port = 20000 + Math.floor(Math.random() * 9000);
  const env = { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
    FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') };
  const base = `http://127.0.0.1:${port}`;
  const start = async () => {
    const c = spawn(process.execPath, [FAUCET], { stdio: ['ignore', 'ignore', 'pipe'], env });
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/rewards`); return c; } catch { await sleep(100); } }
    return c;
  };
  const send = async (i, ip = '10.7.7.7') => (await (await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': ip },
    body: JSON.stringify({ text: `the lobby froze again after the second round, report ${i}` }) })).json());
  let faucet = await start(), second = null;
  try {
    for (let i = 0; i < FEEDBACK_PER_IP_PER_DAY; i++) assert.equal((await send(i)).ok, true, `report ${i} taken`);
    await new Promise((r) => { faucet.on('exit', r); faucet.kill(); });
    second = await start();
    const again = await send(999), other = await send(1000, '10.8.8.8');
    console.log('  FACTS #2284 restart:', JSON.stringify({ again, other: other.ok }));
    assert.notEqual(again.ok, true, 'after the restart the same address had its whole day\'s report budget again');
    assert.equal(other.ok, true, 'another address is still taken');
  } finally {
    faucet.kill(); if (second) second.kill(); chat.close();
  }
});
