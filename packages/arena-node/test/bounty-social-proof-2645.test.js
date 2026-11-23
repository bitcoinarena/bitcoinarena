// SPDX-License-Identifier: LicenseRef-Bitcoin-Arena-1.0
// Copyright (c) 2026 The Bitcoin Arena authors. See LICENSE.
// KANBAN #2645 / #2657 (audit faucet P1): a stranger signed in with a fresh key typed real members' usernames (X, Telegram, Discord) into the social
// screen; each was found live as a member and linked to the stranger's key (proof 'name'), and flagsOf counted those links like code-proven ones:
// +50 % on every approval and a draw entry under another person's name. The owner 2026-11-23: the game and the bounty are independent, and the bonus
// needs proof by the account's own action - the S2 link code posted from it. A typed name is still found and shown; it counts once proven.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';
import { socialCheck } from '../src/bounty-social.js';

const K = (n) => n.toString(16).padStart(64, '0');
const members = {
  x: async (n) => ({ userId: 'x-' + n, username: n, member: true, why: 'follows' }),
  discord: async (n) => ({ userId: 'd-' + n, username: n, member: true, why: 'member' }),
  telegram: async (n) => ({ userId: 't-' + n, username: n, member: true, why: 'member' }),
  nostr: async (n) => ({ userId: n, member: true, why: 'follows' }),
};

test('#2645 typed names of real members give no bonus and no human flag', async () => {
  const s = openBountySeason();
  const r = await socialCheck(s, K(1), { x: 'realmember', discord: 'realmember', telegram: 'realmember' }, members);
  assert.equal(r.bonusPct, 0, 'a stranger who typed three members\' names gets +' + r.bonusPct + ' %');
  assert.deepEqual(r.flags, { telegram: false, discord: false, x: false, armada: false, nostr: false });
  assert.equal(r.results.x.member, true, 'the name is still found and shown');
  assert.equal(r.results.x.needsCode, true, 'the answer says a link code from the account is needed');
  const p = s.plan({ id: 'r1'.padEnd(64, '0'), pubkey: K(1) }, { level: 'high' });
  assert.equal(p.bonusPct, 0); assert.equal(p.sats, seasonHigh(s));
  s.close();
});

test('#2645 the same account proven by a link code posted from it counts (after its name was typed: redeem threw on link_names before)', async () => {
  const s = openBountySeason();
  await socialCheck(s, K(2), { x: 'owner' }, members);
  const code = s.makeCode(K(2));
  assert.equal(s.redeem(code.code, { platform: 'x', userId: 'x-owner', username: 'owner' }).ok, true);
  await s.verify(K(2), { x: async () => ({ member: true }) });
  assert.equal(s.flagsOf(K(2)).x, true, 'a code-proven account is not counted');
  s.close();
});

test('#2645 a Nostr key counts when it is the report key itself, not another typed key', async () => {
  const s = openBountySeason();
  await socialCheck(s, K(3), { nostr: K(3) }, members);
  assert.equal(s.flagsOf(K(3)).nostr, true, 'the signed-in key\'s own follow is its own action');
  await socialCheck(s, K(4), { nostr: K(9) }, members);
  assert.equal(s.flagsOf(K(4)).nostr, false, 'another person\'s typed npub counts');
  s.close();
});

// what a high approval pays with no bonus, from the season's own rule
function seasonHigh(s) { return s.plan({ id: 'zz'.padEnd(64, '0'), pubkey: K(99) }, { level: 'high' }).sats; }
