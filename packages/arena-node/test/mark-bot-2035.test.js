// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// EVERY HARNESS ENTRY MARKED BOT AS IT GOES OUT (kanban #2035, measured 2026-11-12: the #1479 paid probe's entry de5c4209 from tn4-live-run.mjs counted
// as a real player's). markBot posts the entry id and player key to the explorer's /api/mark with the admin code and kind 'bot'; each live harness
// calls it right where its entry id is made, before the seats are asked; the code never leaves the request body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { markBot, entryKeys, adminCodeFile } from '../tools/mark-bot.mjs';

const TOOLS = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools');
const CODE = 'not-the-real-code-' + 'x'.repeat(20);
const hex = (n) => n.toString(16).padStart(64, '0');
const codeFile = () => { const d = mkdtempSync(join(tmpdir(), 'mark2035-')); writeFileSync(join(d, 'code'), CODE + '\n'); return join(d, 'code'); };

test('#2035 markBot posts the entry id and the player key as bot, with the code from the file, and returns no trace of the code', async () => {
  const calls = [];
  const fetcher = async (url, o) => { calls.push({ url, body: JSON.parse(o.body), method: o.method }); return new Response(JSON.stringify({ ok: true, marked: 2, kind: 'bot' }), { status: 200 }); };
  const eid = new Uint8Array(32).fill(0xab), entry = { playerPubkey: new Uint8Array(32).fill(0xcd) };
  const r = await markBot(entryKeys(eid, entry), { env: { ADMIN_CODE_FILE: codeFile() }, fetcher });
  assert.deepEqual(r, { ok: true, marked: 2 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://explorer.bitcoinarena.io/api/mark');
  assert.equal(calls[0].method, 'POST');
  assert.deepEqual(calls[0].body, { kind: 'bot', keys: ['ab'.repeat(32), 'cd'.repeat(32)], code: CODE });
  assert.ok(!JSON.stringify(r).includes(CODE));
});

test('#2035 markBot: MARK_BOT=off and a missing code file ask nothing; a refused code is not asked again; a dead explorer is asked 3 times; never throws, never names the code', async () => {
  let n = 0;
  const count = async () => { n++; return new Response('{}', { status: 500 }); };
  assert.equal((await markBot([hex(1)], { env: { MARK_BOT: 'off', ADMIN_CODE_FILE: codeFile() }, fetcher: count })).ok, false);
  const none = await markBot([hex(1)], { env: { ADMIN_CODE_FILE: '/nonexistent/arena-admin-code' }, fetcher: count });
  assert.equal(none.ok, false); assert.match(none.why, /NOT marked/);
  assert.equal((await markBot(['zz', ''], { env: { ADMIN_CODE_FILE: codeFile() }, fetcher: count })).ok, false);
  assert.equal(n, 0, 'nothing was asked');
  const refused = await markBot([hex(1)], { env: { ADMIN_CODE_FILE: codeFile() }, waitMs: 1,
    fetcher: async () => { n++; return new Response(JSON.stringify({ ok: false, why: 'not the admin code' }), { status: 403 }); } });
  assert.equal(n, 1); assert.equal(refused.ok, false); assert.ok(!JSON.stringify(refused).includes(CODE));
  n = 0;
  const dead = await markBot([hex(1)], { env: { ADMIN_CODE_FILE: codeFile() }, waitMs: 1, fetcher: async () => { n++; throw new TypeError(`fetch failed ${CODE}`); } });
  assert.equal(n, 3); assert.equal(dead.ok, false); assert.ok(!JSON.stringify(dead).includes(CODE), 'an error message is never passed on');
  assert.equal(adminCodeFile({}), join(process.env.HOME || '', '.config', 'blwp', 'arena-admin-code'));
});

test('#2035 markBot reaches the explorer named by EXPLORER_MARK_URL over HTTP', async () => {
  const got = [];
  const srv = createServer((q, s) => { let b = ''; q.on('data', (c) => { b += c; }); q.on('end', () => { got.push({ path: q.url, body: JSON.parse(b) }); s.setHeader('content-type', 'application/json'); s.end('{"ok":true,"marked":1,"kind":"bot"}'); }); });
  await new Promise((ok) => srv.listen(0, '127.0.0.1', ok));
  try {
    const r = await markBot([hex(7)], { env: { ADMIN_CODE_FILE: codeFile(), EXPLORER_MARK_URL: `http://127.0.0.1:${srv.address().port}/api/mark` } });
    assert.deepEqual(r, { ok: true, marked: 1 });
    assert.deepEqual(got, [{ path: '/api/mark', body: { kind: 'bot', keys: [hex(7)], code: CODE } }]);
  } finally { srv.close(); }
});

test('#2035 each live harness marks its entry where the entry id is made, before any seat is handed the entry', () => {
  for (const f of ['tn4-live-run.mjs', 'tn4-rps-paid.mjs', 'testnet4-lock.mjs', 'market-bot.mjs', 'rps-opponent.mjs']) {
    const s = readFileSync(join(TOOLS, f), 'utf8');
    assert.match(s, /import \{ markBot, entryKeys \} from '\.\/mark-bot\.mjs';/, f);
    const made = s.indexOf('const eid = entryId(entry);'), mark = s.indexOf('markBot(entryKeys(eid, entry))', made), post = s.indexOf('/entry`', made);
    assert.ok(made > 0 && mark > made, `${f} calls markBot after its entry id`);
    assert.ok(post < 0 || mark < post, `${f} calls markBot before it posts the entry`);
    assert.equal(s.split('markBot(').length - 1, 1, `${f} marks once per entry`);
  }
  // the regtest stack's lock is no live entry
  assert.match(readFileSync(join(TOOLS, 'tn4-tools-regtest.sh'), 'utf8'), /MARK_BOT=off PAYER_RPC=.*testnet4-lock\.mjs/);
});
