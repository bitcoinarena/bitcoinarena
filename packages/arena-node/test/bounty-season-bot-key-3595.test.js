// kanban #3595: the bot mark sticks to the report key. A key that once linked a listed X account stays a bot after it moves its X link to another
// account (by a new code), also after the store is opened again; a key that never linked a listed account is not marked.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openBountySeason } from '../src/bounty-season.js';

test('#3595: a key that once linked a listed X account stays a bot after relinking, across a reopen; other keys stay human', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bounty-3595-'));
  const list = join(dir, 'bot-x-handles.txt');
  writeFileSync(list, 'listedbot\n');
  const dbPath = join(dir, 'season.db');
  const had = process.env.FAUCET_BOT_X_HANDLES;
  try {
    process.env.FAUCET_BOT_X_HANDLES = list;
    const K = 'c'.repeat(64), H = 'd'.repeat(64);
    let S2 = openBountySeason(dbPath, { startMs: Date.now() - 3600000 });
    assert.equal(S2.redeem(S2.makeCode(K).code, { platform: 'x', userId: '111', username: 'listedbot' }).ok, true);
    assert.equal(S2.redeem(S2.makeCode(K).code, { platform: 'x', userId: '222', username: 'fresh_name' }).ok, true);
    assert.equal(S2.redeem(S2.makeCode(H).code, { platform: 'x', userId: '333', username: 'some_human' }).ok, true);
    S2.record(H, 'x', { member: true, why: 'follows' });
    assert.equal(S2.flagsOf(K).bot, true, 'K stays a bot after relinking');
    assert.equal(S2.flagsOf(H).bot, undefined, 'a key that never linked a listed account is not a bot');
    assert.equal(S2.flagsOf(H).x, true);
    S2.close();
    S2 = openBountySeason(dbPath, { startMs: Date.now() - 3600000 });
    assert.equal(S2.flagsOf(K).bot, true, 'the mark survives a reopen');
    S2.close();

    // a store from before #3595 (no key_accounts): the history is filled at open from the used codes and the membership reads
    const db = new DatabaseSync(dbPath);
    db.exec('DROP TRIGGER key_accounts_add; DROP TRIGGER key_accounts_move; DROP TABLE key_accounts;');
    db.close();
    S2 = openBountySeason(dbPath, { startMs: Date.now() - 3600000 });
    assert.equal(S2.flagsOf(K).bot, true, 'an older store marks K from its used link codes');
    assert.equal(S2.flagsOf(H).bot, undefined);
    S2.close();
  } finally { if (had === undefined) delete process.env.FAUCET_BOT_X_HANDLES; else process.env.FAUCET_BOT_X_HANDLES = had; }
});
