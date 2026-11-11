// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// kanban #1489 r1-faucet-3: POST /feedback checks a report's "Bounty address" (lnAddressWorks: an HTTPS GET to wherever the address or LNURL points)
// BEFORE the report is counted against its sender's limits, and a report whose address fails is never counted. So a stranger makes the faucet
// fetch any HTTPS URL it names - an LNURL may encode https://127.0.0.1:<port>/..., an internal host - as often as it likes, each up to 8 s, outside the
// one-at-a-time queue. Safe: one address gets no more outside lookups a day than it may send reports (FEEDBACK_PER_IP_PER_DAY).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lnurlFor } from '../../arena-protocol/src/bech32.js';
import { FEEDBACK_PER_IP_PER_DAY } from '../src/faucet.js';

test('#1489 r1-faucet-3: one address cannot make the faucet fetch an outside URL without limit', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489-r1-faucet-3-'));
  writeFileSync(join(dir, 'token'), 'x');
  const chat = createServer((req, res) => { req.resume(); req.on('end', () => { res.writeHead(200); res.end('{}'); }); });
  await new Promise((r) => chat.listen(0, '127.0.0.1', r));
  // the "internal service": every connection the faucet opens to it is counted, then closed (no TLS: the lookup fails fast)
  let hits = 0;
  const target = tcpServer((s) => { hits++; s.destroy(); });
  await new Promise((r) => target.listen(0, '127.0.0.1', r));
  const lnurl = lnurlFor(`https://127.0.0.1:${target.address().port}/internal/admin`);
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_CHAT_URL: `http://127.0.0.1:${chat.address().port}`, FAUCET_CHAT_CHANNEL: '6', FAUCET_CHAT_TOKEN_FILE: join(dir, 'token'),
      FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOOK: join(dir, 'book.json') } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`${base}/feedback/rewards`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    const answers = [];
    const SENDS = FEEDBACK_PER_IP_PER_DAY + 20;
    for (let i = 0; i < SENDS; i++) {
      const r = await fetch(`${base}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-arena-ip': '10.9.9.9' },
        body: JSON.stringify({ text: `the round froze again, number ${i}\nBounty address: ${lnurl}` }) });
      answers.push((await r.json()).why || 'ok');
    }
    const facts = { sends: SENDS, outsideLookups: hits, lastAnswer: answers.at(-1), limitAnswers: answers.filter((w) => /sent all it can/.test(w)).length };
    console.log('  FACTS r1-faucet-3:', JSON.stringify(facts));
    assert.ok(hits <= FEEDBACK_PER_IP_PER_DAY, `one address made the faucet open ${hits} connections to a URL it named (limit ${FEEDBACK_PER_IP_PER_DAY} reports a day)`);
  } finally {
    faucet.kill(); chat.close(); target.close(); rmSync(dir, { recursive: true, force: true });
  }
});
