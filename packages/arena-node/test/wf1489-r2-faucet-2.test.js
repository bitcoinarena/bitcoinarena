// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// kanban #1489 round 2 (faucet, Week 2 bonus): A TELEGRAM LINK IS READ BY ITS STORED NAME, NOT BY ITS ACCOUNT. faucet.mjs's Telegram verifier asks
// the user-account reader (S2_USERBOT) for the link's stored `username` and takes `member: true` as it comes - the reader answers the userId of
// the member it found under that name, and nobody compares it with the link's own user_id. The stored name is not the account's: the link bot
// (tools/bounty-link-bot.mjs telegramLoop) stores `m.from.first_name` when the account has no @username, and a first name is free text. So a
// stranger's Telegram account with no username and the first name "alice" (any real member's username) posts its code: the link is proven
// ('code'), its id is the stranger's, and every verify (approve, payout, draw) reads alice's membership for it - +25 % on a mainnet bounty and a
// draw entry named exactly as alice's ("telegram:alice"), without ever joining. Safe: a link counts as a member only when the account the
// reader found under the name is the linked account (user_id).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { schnorr } from '@noble/curves/secp256k1.js';
import { eventId } from '../src/nostr-relay.js';
import { HTTP_AUTH_KIND } from '../src/feedback-store.js';
import { openBountySeason } from '../src/bounty-season.js';

const hex = (b) => Buffer.from(b).toString('hex');
const STAGE = 'https://stage.example/api/faucet/feedback';
const key = (n) => { const secret = new Uint8Array(32).fill(n); return { secret, pubkey: hex(schnorr.getPublicKey(secret)) }; };
const auth = (k, url) => { const e = { pubkey: k.pubkey, created_at: Math.floor(Date.now() / 1000), kind: HTTP_AUTH_KIND, tags: [['u', url], ['method', 'POST']], content: '' };
  e.id = eventId(e); e.sig = hex(schnorr.sign(Buffer.from(e.id, 'hex'), k.secret)); return `Nostr ${Buffer.from(JSON.stringify(e)).toString('base64')}`; };

test('#1489-r2 a Telegram link is a member only when the account found under its name is the linked account', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wf1489r2f2-'));
  // the `telegram` package as the faucet loads it: a fake gramjs whose group holds one member, @alice (id 42)
  writeFileSync(join(dir, 'fake-telegram.mjs'), `export class TelegramClient { async connect() {} async disconnect() {} async getEntity() { return { id: -100 }; }
    async getDialogs() { return []; } async getParticipants() { return [{ id: 42, username: 'alice' }]; } setLogLevel() {} }
    export const sessions = { StringSession: class { constructor(s) { this.s = s; } } };`);
  writeFileSync(join(dir, 'hooks.mjs'), `export async function resolve(spec, ctx, next) { if (spec === 'telegram') return { url: ${JSON.stringify(pathToFileURL(join(dir, 'fake-telegram.mjs')).href)}, shortCircuit: true }; return next(spec, ctx); }`);
  writeFileSync(join(dir, 'register.mjs'), `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(join(dir, 'hooks.mjs')).href)});`);
  for (const [f, v] of [['api-id', '12345'], ['api-hash', 'h'.repeat(32)], ['session', 's'.repeat(40)], ['chat', '-100']]) writeFileSync(join(dir, f), v);
  const s2db = join(dir, 'season2.db');
  // THE STRANGER'S LINK, as the link bot makes it: Telegram account 999 (no @username, first name "alice") posted its own code - proof 'code'
  const mallory = key(7);
  { const s = openBountySeason(s2db); const c = s.makeCode(mallory.pubkey);
    assert.equal(s.redeem(c.code, { platform: 'telegram', userId: '999', username: 'alice' }).ok, true); s.close(); }
  const port = 20000 + Math.floor(Math.random() * 9000);
  const faucet = spawn(process.execPath, ['--import', pathToFileURL(join(dir, 'register.mjs')).href, fileURLToPath(new URL('../tools/faucet.mjs', import.meta.url))], { stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, FAUCET_PORT: String(port), FAUCET_FEEDBACK_DB: join(dir, 'feedback.db'), FAUCET_BOOK: join(dir, 'book.json'), FAUCET_FOUNDING_FILE: join(dir, 'founding.jsonl'),
      FAUCET_BOUNTY_S2_DB: s2db, FAUCET_BOUNTY_S2_BASES: STAGE, FAUCET_BOUNTY_TG_CHAT_FILE: join(dir, 'chat'), FAUCET_BOUNTY_TG_USERBOT_API_ID_FILE: join(dir, 'api-id'),
      FAUCET_BOUNTY_TG_USERBOT_API_HASH_FILE: join(dir, 'api-hash'), FAUCET_BOUNTY_TG_USERBOT_SESSION_FILE: join(dir, 'session') } });
  let out = ''; faucet.stdout.on('data', (d) => { out += d; }); faucet.stderr.on('data', (d) => { out += d; });
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(`${base}/feedback/paid-log`); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
    assert.match(out, /telegram reader on/, 'the faucet runs with its Telegram member-list reader');
    const v = await fetch(`${base}/feedback/verify`, { method: 'POST', headers: { authorization: auth(mallory, `${STAGE}/verify`) } }).then((r) => r.json());
    const s = openBountySeason(s2db); const entries = s.drawEntries(2); const link = s.links(mallory.pubkey)[0]; s.close();
    console.log(`  MEASURED: link user_id ${link.userId} (stored name "${link.username}"), the group's member list { alice: 42 } -> flags.telegram ${v.flags && v.flags.telegram}, why "${link.why}"`);
    assert.equal(v.ok, true, JSON.stringify(v));
    assert.equal(v.flags.telegram, false, 'account 999 is in no group, yet its link reads as a member: alice\'s membership counted for it');
  } finally { faucet.kill(); }
});
