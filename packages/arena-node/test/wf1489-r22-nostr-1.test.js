// wf1489 r22-nostr-1: the faucet's "played a round" (Season 2 payout: full only when played, else 25 %) comes from ONE seat's unsigned
// GET /season?scope=network rows. Safe: one seat alone cannot make a key a player, nor drop a player the other seats list.
import test from 'node:test';
import assert from 'node:assert/strict';
import { networkPlayers } from '../src/feedback-store.js';

test('r22-nostr-1 one seat\'s unsigned network board decides who played (bounty paid in full vs 25 %)', async () => {
  const X = 'e5'.repeat(32);   // the attacker's reporter key, never played
  const H = 'a1'.repeat(32);   // an honest player every other seat lists
  const fetcher = async (url) => {
    const evil = url.startsWith('https://evil.example');
    return new Response(JSON.stringify({ rows: evil ? [{ player: X, rounds: 1 }] : [{ player: H, rounds: 5 }] }), { status: 200 });
  };
  const np = networkPlayers({ seats: ['https://evil.example', 'https://s2.example', 'https://s3.example', 'https://s4.example'], games: ['rock-paper-scissors'], fetcher });
  await np.refresh();
  console.log('  FACTS r22-nostr-1:', JSON.stringify({ X: np.played(X), H: np.played(H) }));
  assert.equal(np.played(X), false, 'one seat alone named the attacker a player: his report is paid in full, not 25 %');
  assert.equal(np.played(H), true, 'one seat alone dropped an honest player listed by three other seats');
});
