// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 refute of #1537: the fix says "a global per-minute cap puts a hard limit on outbound fetches" - but the global cap (LN_ASKS_ALL, 120 a
// minute) is only on GET /feedback/lnaddress. POST /feedback checks the report's "Bounty address:" with the same lnAddressWorks (addressCheckFor,
// #1511): 50 a day per /64 and no cap across callers, and a failing address never enters REPORTS, so FEEDBACK_PER_DAY never trips either. A caller
// holding a /48 (65,536 /64s) makes the faucet fetch a host it names without any global bound.
// Safe: fetches the faucet makes for callers' addresses, both doors together, stay under the global 120 a minute.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const FAUCET = join(dirname(fileURLToPath(import.meta.url)), '..', 'tools', 'faucet.mjs');
const ORIGIN = 'https://testnet.bitcoinarena.io', KEY = 'k'.repeat(64);
test('#1489 refute #1537: POST /feedback is a second door around the global address-check cap', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489v1r40s1-'));
  writeFileSync(join(dir, 'chat.token'), 'x');
  const port = 20000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.execPath, [FAUCET], { env: { ...process.env, FAUCET_PORT: String(port), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_PENDING: join(dir, 'pending.txt'),
    FAUCET_RPC_URL: 'http://127.0.0.1:1/wallet/x', FAUCET_COOKIE: join(dir, 'none'), FAUCET_FEEDBACK_DB: join(dir, 'fb.db'), FAUCET_BOUNTY_ORIGINS: ORIGIN, FAUCET_WORKER_KEY: KEY,
    FAUCET_CHAT_URL: 'http://127.0.0.1:1', FAUCET_CHAT_TOKEN_FILE: join(dir, 'chat.token'), FAUCET_CHAT_CHANNEL: 'c' }, stdio: 'ignore' });
  try {
    for (let i = 0; i < 50; i++) { try { await fetch(`http://127.0.0.1:${port}/player`); break; } catch { await new Promise((ok) => setTimeout(ok, 100)); } }
    const hdr = (i) => ({ origin: ORIGIN, 'x-arena-ip': `2001:db8:7:${i.toString(16)}::1`, 'x-arena-worker': KEY });
    // first the GET door's global minute is used up (120 checks from 120 /64s of the /48)
    let getRefused = 0;
    for (let i = 1; i <= 130; i++) { const r = await (await fetch(`http://127.0.0.1:${port}/feedback/lnaddress?a=x@target.invalid`, { headers: hdr(i) })).json(); if (/too many checks/.test(String(r.why))) getRefused++; }
    // then, still in the same minute, unsigned reports from other /64s of the same /48, each naming a bounty address on the caller's host
    let fetched = 0;
    await Promise.all(Array.from({ length: 150 }, async (_, j) => {
      const r = await (await fetch(`http://127.0.0.1:${port}/feedback`, { method: 'POST', headers: { 'content-type': 'application/json', ...hdr(1000 + j) },
        body: JSON.stringify({ text: `it broke\nBounty address: n${j}@target.invalid` }) })).json();
      if (/does not work: its wallet (could not be reached|did not answer|answered|said)/.test(String(r.why))) fetched++;
    }));
    console.log('  MEASURED:', JSON.stringify({ getRefused, postFetchedSameMinute: fetched }));
    assert.ok(getRefused >= 10, 'the GET door is capped');
    assert.ok(fetched === 0, `${fetched} more outbound fetches to the caller's host in the same minute, after the global cap of 120 was full`);
  } finally { child.kill(); }
});
