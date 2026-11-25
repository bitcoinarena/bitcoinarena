// Audit faucet a8 r1 (a8-1-1): gap in the #3309 fix. opponentWant now keeps the FIRST verified tap key of a round
// (src/faucet.js:230 `tapKey: was?.tapKey || (signed ? tap.key : null)`). A stranger who reads an open RPS round id from the seats'
// public round list and POSTs /opponent with a tap signed by his OWN fresh key before the real player taps holds the row's tapKey for
// the whole round (each re-post within 12 s keeps the row). tools/rps-opponent.mjs:347 then learns w.tapKey as KNOWN once the real
// player's stake lock verifies - the stranger's never-staked key - and from then on his taps alone send the bot to empty tables
// ('a known player tapped', :329). The #3309 test only covered the stranger tapping AFTER the player.
// Safe behaviour asserted: when two different keys tapped one round, the row does not name the stranger's key as THE tap key
// (it names the player's, or no single key), so rps-opponent cannot learn a key that never staked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { opponentWant, opponentWants, tapSigned } from '../src/faucet.js';
import { presenceId } from '../../arena-protocol/src/match.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const hex = (b) => Buffer.from(b).toString('hex');
const freshKey = () => (schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey());
function tapOf(round, priv) {
  const key = hex(schnorr.getPublicKey(priv));
  const sig = hex(schnorr.sign(presenceId({ roundId: fromHex(round), identityKey: fromHex(key) }), priv));
  return { key, sig };
}

test('a stranger who taps a real round first does not become the round\'s tap key (gap in #3309)', () => {
  const wants = new Map();
  const round = 'cd'.repeat(32);
  const pTap = tapOf(round, freshKey()), sTap = tapOf(round, freshKey());
  assert.equal(tapSigned(round, pTap), true);
  assert.equal(tapSigned(round, sTap), true);
  const now = Date.now();
  // the stranger taps the open round first (its id is public at the seats), from his own address
  assert.equal(opponentWant(wants, round, now, sTap, '198.51.100.9').ok, true);
  // the real player's page taps the same round a moment later, from its own address
  assert.equal(opponentWant(wants, round, now + 700, pTap, '203.0.113.7').ok, true);
  // the stranger keeps re-posting (as a page does every 2 s)
  assert.equal(opponentWant(wants, round, now + 2000, sTap, '198.51.100.9').ok, true);
  const row = opponentWants(wants, now + 2100).find((x) => x.round === round);
  assert.ok(row);
  assert.notEqual(row.tapKey, sTap.key,
    `the round's tap key is the stranger's (${String(row.tapKey).slice(0, 8)}), which rps-opponent learns as KNOWN once the player's (${pTap.key.slice(0, 8)}) lock verifies`);
});
