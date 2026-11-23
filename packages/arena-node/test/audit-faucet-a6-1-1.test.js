// Audit faucet a6-1-1 (gap in #3027): a reporter's X link code must be posted publicly on X. Since #3027 a code links one account PER PLATFORM,
// so the public X code stays a valid Discord / Telegram code for 24 h. A stranger who reads it DMs it to the Discord bot: S2.redeem's
// ON CONFLICT (pubkey, platform) DO UPDATE replaces the reporter's own, code-proven, member Discord link with the stranger's non-member account.
// The reporter's "2 of 3 communities" bonus is gone at payout (S2.payable), with no step by the reporter.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';
import { linkFromText } from '../tools/bounty-link-bot.mjs';

test('a public X link code DMed to the Discord bot by a stranger does not replace the reporter\'s own Discord link', async () => {
  const S2 = openBountySeason(':memory:', { startMs: 0 });
  const victim = 'a'.repeat(64);
  const t0 = Date.now() - 600_000;
  // the community checks: the reporter's own accounts are members, the stranger's Discord account is not
  const verifiers = {
    discord: async (l) => ({ member: l.userId === 'd-own', why: l.userId === 'd-own' ? 'member' : 'not in the server' }),
    telegram: async (l) => ({ member: l.userId === 't-own', why: 'member' }),
    x: async (l) => ({ member: l.userId === 'x-own', why: 'follows' }),
  };
  // 1) the reporter links Discord and Telegram by his own codes (DM to the bots), and X by a code posted on X
  const c1 = S2.makeCode(victim, { nowMs: t0 }).code;
  await linkFromText(S2, verifiers, { platform: 'discord', userId: 'd-own', username: 'reporter', text: c1, nowMs: t0 + 1000 });
  const c2 = S2.makeCode(victim, { nowMs: t0 + 2000 }).code;
  await linkFromText(S2, verifiers, { platform: 'telegram', userId: 't-own', username: '@reporter', text: `/link ${c2}`, nowMs: t0 + 3000 });
  const c3 = S2.makeCode(victim, { nowMs: t0 + 4000 }).code;   // posted publicly: "@bitcoinarena_io BA-..."
  await linkFromText(S2, verifiers, { platform: 'x', userId: 'x-own', username: 'reporter', text: `@bitcoinarena_io ${c3}`, nowMs: t0 + 5000 });
  const before = S2.flagsOf(victim);
  assert.equal(before.discord && before.telegram && before.x, true, 'setup: the reporter is a member of Discord, Telegram and follows on X');
  // 2) a report of his is approved by the Season 2 rules: high + X + 2 of 3 communities
  const report = { id: 'f'.repeat(64), pubkey: victim, receivedMs: t0 };
  const p = S2.plan(report, { level: 'high' });
  assert.ok(p.ok && p.fits, `setup: plan ${JSON.stringify(p)}`);
  S2.commit(report, p);
  // 3) a stranger reads the X code from the public post and DMs it to the Discord bot (discordLoop MESSAGE_CREATE) from his own account
  const dm = await linkFromText(S2, verifiers, { platform: 'discord', userId: 'd-stranger', username: 'stranger', text: c3, nowMs: t0 + 60_000 });
  // 4) the payout reads the reporter's links again (faucet.mjs reward action: S2.verify + S2.payable)
  await S2.verify(victim, verifiers, { cause: 'payout' });
  const pay = S2.payable(report.id);
  const discord = S2.links(victim).find((l) => l.platform === 'discord');
  assert.equal(discord && discord.userId, 'd-own', `the reporter's own Discord account stays linked to his key; the stranger's DM was answered: ${dm && dm.reply}`);
  assert.equal(pay.payableSats, pay.approvedSats, `the reporter is paid what was approved (${pay.approvedSats}), not ${pay.payableSats} (${pay.why})`);
});
