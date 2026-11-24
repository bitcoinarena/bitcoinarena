// Audit faucet a7 round 3 #1 (finding, never a fix): gap in #3032 / #2958. The bot list is matched against the X account(s) a key links NOW
// (flagsOf reads links + link_names of the current link's account id). A listed bot whose key K already holds approved, unpaid reports makes a
// second, fresh X account (free), posts a fresh BA- link code from it: redeem's ON CONFLICT (pubkey, platform) DO UPDATE moves K's X link to the
// new account id, the listed account is no longer looked at, and K is "human" again - its approved reports pay the full level, not the bot share.
// SAFE: a key that once linked a listed X account stays a bot whatever X account it links later ("Alle tickets mit diesem handle als bot
// markieren, auch in Zukunft").
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBountySeason } from '../src/bounty-season.js';

test('audit faucet a7-3 #1: a listed X bot relinks its key to a fresh X account by a new code and is paid as a human again', () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-a7-3-1-'));
  const list = join(dir, 'bot-x-handles.txt');
  writeFileSync(list, '# known AI bots\nlistedbot\n');
  const had = process.env.FAUCET_BOT_X_HANDLES;
  try {
    process.env.FAUCET_BOT_X_HANDLES = join(dir, 'none.txt');
    const S2 = openBountySeason(':memory:', { startMs: Date.now() - 3600000 });
    const K = 'b'.repeat(64);
    // the bot's key K links X account 111 (@listedbot) by a posted code, and follows
    const c = S2.makeCode(K);
    assert.equal(S2.redeem(c.code, { platform: 'x', userId: '111', username: 'listedbot' }).ok, true);
    S2.record(K, 'x', { member: true, why: 'follows' });
    // a 'high' report approved before the owner listed the handle (full level)
    const rep = { id: 'a'.repeat(64), pubkey: K, receivedMs: Date.now() };
    const p = S2.plan(rep, { level: 'high' }); assert.equal(p.ok, true); S2.commit(rep, p);
    const approved = S2.approval(rep.id).sats;
    process.env.FAUCET_BOT_X_HANDLES = list;
    assert.equal(S2.flagsOf(K).bot, true, 'control: the listed handle marks K a bot');
    const botPay = S2.payable(rep.id).payableSats;
    assert.ok(botPay < approved, `control: the bot share is paid (${botPay} < ${approved})`);

    // the bot opens a fresh X account 222 (@fresh_human), makes a NEW link code in My feedback and posts it from that account
    const c2 = S2.makeCode(K);
    const r = S2.redeem(c2.code, { platform: 'x', userId: '222', username: 'fresh_human' });
    assert.equal(r.ok, true, 'the fresh code links the new X account to K');
    S2.record(K, 'x', { member: true, why: 'follows' });

    const f = S2.flagsOf(K);
    const after = S2.payable(rep.id).payableSats;
    console.log('after relink: flags', JSON.stringify(f), 'payable', after, 'bot share', botPay, 'approved', approved, 'link', JSON.stringify(S2.links(K).map((l) => [l.userId, l.username])));
    assert.equal(f.bot, true, 'K once linked the listed X account 111: it stays a bot after relinking another X account');
    assert.equal(after, botPay, 'its approved report still pays the bot share');
    S2.close();
  } finally { if (had === undefined) delete process.env.FAUCET_BOT_X_HANDLES; else process.env.FAUCET_BOT_X_HANDLES = had; }
});
