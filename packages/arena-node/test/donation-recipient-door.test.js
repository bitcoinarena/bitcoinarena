// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// A DONATION RECIPIENT THAT DOES NOT ANSWER, AND WHY (kanban #1044 B1 phase 4, ruling #1145 A). Measured on four devnet runs (s29b-s29e): every
// settlement held both donation shares "the recipient did not answer", and the harness's door on 18777 was never asked.
//   1. the seat's reason is whole: fetch says only "fetch failed", the reason (ECONNREFUSED 127.0.0.1:port) is in its cause - said now
//   2. the cause: tools/named-offence-devnet.mjs closed the recipients' door inside its watch loop's first pass, before the round ended
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { WinningsSend, fetchErrorText } from '../src/winnings-send.js';
import { serveDonationRecipients } from '../src/lnurl-recipients.js';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';

/** A port nothing listens on: bound once and let go. */
const freePort = () => new Promise((ok) => { const s = createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => ok(p)); }); });

test('a recipient whose door refuses: the held reason names the refusal and the address, not only "fetch failed"', async () => {
  const port = await freePort();
  const w = new WinningsSend({ round: null, port: null, lnurlFetch: (u, o) => fetch(u, o), lnurlMs: 5000 });
  const said = await w.invoiceFor(lnurlFor(`http://127.0.0.1:${port}/lnurlp/blwp-test-a`), 1000n);
  assert.equal(said.ok, false);
  assert.match(said.why, new RegExp(`http://127\\.0\\.0\\.1:${port}/lnurlp/blwp-test-a did not answer`));
  assert.match(said.why, /ECONNREFUSED/, `the reason is not said: ${said.why}`);
  assert.match(said.why, new RegExp(`127\\.0\\.0\\.1:${port}`));
});

test('fetchErrorText: the whole cause chain, a timeout by name', () => {
  const e = new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:18777'), { code: 'ECONNREFUSED', address: '127.0.0.1', port: 18777 }) });
  assert.equal(fetchErrorText(e), 'fetch failed <- connect ECONNREFUSED 127.0.0.1:18777 ECONNREFUSED 127.0.0.1:18777');
  const t = new DOMException('The operation was aborted due to timeout', 'TimeoutError');
  assert.match(fetchErrorText(t), /^TimeoutError /);
});

test('the recipients\' door is told of a connection that sends no request', async () => {
  const conns = [];
  const d = await serveDonationRecipients({ port: 0, onConnect: (r) => conns.push(r) });
  try {
    const r = await fetch(`${d.base}/lnurlp/blwp-test-a`);
    assert.equal(r.status, 200);
    assert.equal(conns.length, 1);
    assert.match(conns[0], /^127\.0\.0\.1:\d+$/);
  } finally { await d.close(); }
});

test('the devnet harness closes the recipients\' door after its watch loop, never inside it', () => {
  const src = readFileSync(new URL('../tools/named-offence-devnet.mjs', import.meta.url), 'utf8');
  const loop = src.indexOf('\nfor (;;) {');
  assert.ok(loop > 0, 'the watch loop is not found');
  const end = src.indexOf('\n}\n', loop);   // the loop's own closing brace, at column 0
  const closes = [...src.matchAll(/recipients\.close\(\)/g)].map((m) => m.index);
  assert.ok(closes.length >= 1, 'the door is never closed');
  for (const i of closes) assert.ok(i > end, `the recipients' door is closed inside the watch loop (at ${src.slice(0, i).split('\n').length})`);
});
