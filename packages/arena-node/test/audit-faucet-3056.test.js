// kanban #3056: the card's test
// Audit 2026-11-19 r4, module faucet, round 2, finding 1 (attacker audit, never a fix).
// THE SEASON DRAW'S ENTRY LIST IS READ AFTER ITS SEED IS PUBLIC: the seed is the first Bitcoin block after the season's end (draw.mjs
// seedBlockAfter), but the entries are what S2.drawEntries(season) answers when the admin asks for them (POST /feedback/admin/act
// draw-entries, after that block exists) - each entry text is the entrant's own platform username, read from his link as it is then.
// An entrant who reads the seed block re-names his link (POST /feedback/social -> claimName, same account id; or a code from his renamed
// account -> redeem) so that his entry sorts where the published seed picks place 1. Safe behaviour: the entry list a seed draws from is the
// one as it stood when the season ended (before the seed was known) - a change made after the end does not move anyone in the draw.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openBountySeason } from '../src/bounty-season.js';
import { draw } from '../tools/bounty-draw.mjs';

const K = (n) => n.toString(16).padStart(64, '0');
const rep = (n, pubkey) => ({ id: `e${n}`.padEnd(64, '0'), pubkey });

test('a season draw entrant cannot pick his place after the seed block is known (entries frozen at the season end)', async () => {
  const s = openBountySeason();
  const yes = { telegram: async () => ({ member: true }), discord: async () => ({ member: true }) };
  // five honest reporters and the attacker (K6), each with an approved report and a Telegram link
  const names = ['@alice_tg', '@bob_tg', '@carol_tg', '@dave_tg', '@erin_tg', '@mallory'];
  for (let n = 1; n <= 6; n++) {
    assert.equal(s.redeem(s.makeCode(K(n)).code, { platform: 'telegram', userId: `tg${n}`, username: names[n - 1] }).ok, true);   // proven by code (kanban #2645)
    await s.verify(K(n), yes);
    const r = rep(n, K(n)); const p = s.plan(r, { level: 'low' }); assert.equal(p.ok, true); s.commit(r, p);
  }
  // the season ends: this is the list as it stands before anyone can know the seed
  const atEnd = s.drawEntries(2);
  assert.equal(atEnd.length, 6);
  // the seed block is mined and public (any 64-hex block hash); the attacker reads it
  const seed = '00000000000000000001a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f7';
  const honestWinner = draw(atEnd, seed).winners[0].entry;
  // he tries usernames for his own account until the published script gives him place 1 ([a-z0-9_], as Telegram allows)
  const others = atEnd.filter((x) => x !== 'telegram:@mallory');
  let chosen = null;
  for (let i = 0; i < 5000 && !chosen; i++) {
    const name = `@${i.toString(36)}_m`;
    if (draw([...others, `telegram:${name}`], seed).winners[0].entry === `telegram:${name}`) chosen = name;
  }
  assert.ok(chosen, 'a winning username exists');
  // POST /feedback/social with his renamed Telegram account: the same account id, so claimName only updates the stored username
  assert.equal(s.claimName(K(6), 'telegram', { userId: 'tg6', username: chosen }).ok, true);
  // the admin asks for the entries (draw-entries verifies every key first) and runs the published draw with the seed
  await s.verify(K(6), yes);
  const atDraw = s.drawEntries(2);
  const out = draw(atDraw, seed);
  console.log('MEASURED', JSON.stringify({ seed: seed.slice(0, 16), honestWinnerWithEndList: honestWinner, chosenName: chosen, winnerAtDraw: out.winners[0].entry }));
  assert.deepEqual(atDraw, atEnd, `the entry list changed after the season end: ${JSON.stringify(atEnd)} -> ${JSON.stringify(atDraw)}`);
  assert.equal(out.winners[0].entry, honestWinner, `place 1 (20,000 sat) moved to the entrant who renamed after the seed: ${out.winners[0].entry}`);
});
