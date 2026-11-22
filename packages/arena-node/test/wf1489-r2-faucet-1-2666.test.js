// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #2666, #1489 round 2 (faucet, Season 2): POST /feedback/link writes one link_codes row per signed-in key, and a key costs a stranger nothing (a
// fresh secp256k1 key signs its own NIP-98 sign-in). There is no caller limit, no global limit and no expiry sweep: every request from one machine
// adds a row (synchronous=FULL, an fsync each), forever. And makeCode counts a key's open codes with `WHERE pubkey = ?` on a table whose only
// index is the code, so each later /feedback/link is a scan of every row ever made - in the faucet's one thread, beside the welcomes and the
// LNURL claims (P5). Safe: one caller cannot make an unbounded number of link codes; past a bound its asks are refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { schnorr } from '@noble/curves/secp256k1.js';
import { randomBytes } from 'node:crypto';
import { eventId } from '../src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../src/feedback-store.js';

const hex = (b) => Buffer.from(b).toString('hex');
const STAGE = 'https://stage.example/api/faucet/feedback';
const auth = () => { const secret = randomBytes(32); const e = { pubkey: hex(schnorr.getPublicKey(secret)), created_at: Math.floor(Date.now() / 1000), kind: HTTP_AUTH_KIND,
  tags: [['u', `${STAGE}/link`], ['method', 'POST']], content: '' }; e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), secret));
  return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`; };

test('#1489-r2 one caller cannot grow the Season 2 link codes without bound by fresh keys', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r2f1-'));
  const port = 20000 + Math.floor(Math.random() * 9000), s2db = join(dir, 'season2.db');
  const faucet = spawn(process.execPath, [fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: 'ignore',
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_BOOK: join(dir, 'book.json'),
      FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'), FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_BASES: STAGE } });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    let took = 0;
    const N = 400;
    for (let i = 0; i < N; i++) {
      const r = await fetch(`${base}/feedback/link`, { method: 'POST', headers: { authorization: auth(), 'x-forwarded-for': '203.0.113.9' } }).then((x) => x.json()).catch(() => ({}));
      if (r.ok && r.code) took++;
    }
    const db = new DatabaseSync(s2db, { readOnly: true });
    const rows = db.prepare('SELECT COUNT(*) AS n FROM link_codes').get().n;
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM link_codes WHERE pubkey = ? AND used_ms IS NULL AND made_ms > ?").all('a'.repeat(64), 0).map((x) => x.detail).join(' | ');
    db.close();
    console.log(`  MEASURED: ${took} of ${N} sign-ins from one address took a code; link_codes rows ${rows}; makeCode's count: ${plan}`);
    assert.ok(took < N, `one caller made ${took} link codes under ${N} fresh keys, every one a new row (${rows}), none refused`);
    assert.match(plan, /link_codes_by_key/, `makeCode's count of a key's open codes reads an index, not every row: ${plan}`);   // kanban #2666
  } finally { faucet.kill(); }
});
