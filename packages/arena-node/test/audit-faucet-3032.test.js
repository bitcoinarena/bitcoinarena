// kanban #3032: the card's test (audit faucet r3-1 of 2026-11-19)
// AUDIT faucet r3 #1 (finding, never a fix): the #2958 bot list matches the X handle STORED on a link, and the stored handle is whatever the
// account is called at its latest claim. A listed bot renames its X account (free, instant) and types the new name on the social screen
// (POST /feedback/social -> socialCheck -> S2.claimName): claimName finds the same account id and rewrites links.username, so flagsOf no longer
// sees a listed handle - the key is "human" again (x: true) and its approved, unpaid reports pay the full level instead of the 15 % bot share.
// SAFE: once a key's linked X account (its stable id) carried a listed handle, a rename does not lift the bot mark.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openBountySeason } from '../src/bounty-season.js';

test('audit faucet r3 #1: a listed X bot renames its handle, re-types it, and is paid as a human again (gap in #2958)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'audit-faucet-r3-1-'));
  const list = join(dir, 'bot-x-handles.txt');
  writeFileSync(list, '# known AI bots\nlistedbot\n');
  const had = process.env.FAUCET_BOT_X_HANDLES;
  process.env.FAUCET_BOT_X_HANDLES = list;
  try {
    const S2 = openBountySeason(':memory:', { startMs: Date.now() - 3600000 });
    const K = 'b'.repeat(64);
    // the bot linked its X account (stable id 111) by a posted code, as @listedbot, and follows
    const c = S2.makeCode(K);
    assert.equal(S2.redeem(c.code, { platform: 'x', userId: '111', username: 'listedbot' }).ok, true);
    S2.record(K, 'x', { member: true, why: 'follows' });
    // a report approved before the owner put the handle on the list (full level, verified X)
    const rep = { id: 'a'.repeat(64), pubkey: K, receivedMs: Date.now() };
    process.env.FAUCET_BOT_X_HANDLES = join(dir, 'none.txt');
    const p = S2.plan(rep, { level: 'high' }); assert.equal(p.ok, true); S2.commit(rep, p);
    const approved = S2.approval(rep.id).sats;
    process.env.FAUCET_BOT_X_HANDLES = list;
    assert.equal(S2.flagsOf(K).bot, true, 'control: the listed handle marks the key a bot');
    const botPay = S2.payable(rep.id).payableSats;
    assert.ok(botPay < approved, `control: the bot share is paid (${botPay} < ${approved})`);

    // the bot renames its X account to @listedbot_two and posts a fresh code from it (2.0 has no social screen: the redeem path); same account id 111
    const c2 = S2.makeCode(K);
    assert.equal(S2.redeem(c2.code, { platform: 'x', userId: '111', username: 'listedbot_two' }).ok, true);

    const f = S2.flagsOf(K);
    const after = S2.payable(rep.id).payableSats;
    console.log('after rename: flags', JSON.stringify(f), 'payable', after, 'bot share', botPay, 'approved', approved, 'stored handle', S2.links(K)[0].username);
    assert.equal(f.bot, true, 'the same X account (id 111) stays a listed bot after a rename');
    assert.equal(after, botPay, 'its approved report still pays the bot share');
    S2.close();
  } finally { if (had === undefined) delete process.env.FAUCET_BOT_X_HANDLES; else process.env.FAUCET_BOT_X_HANDLES = had; }
});

