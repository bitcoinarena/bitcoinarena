// kanban #3309: the card's test (audit faucet a5-2-1)
// Audit faucet r2 (a5-2-1): POST /opponent keeps the LAST signed tap's key on a round (P3). A stranger who reads GET /opponent (public) and
// signs a tap of a real player's open round with his OWN key replaces the player's tapKey. tools/rps-opponent.mjs then learns w.tapKey as a
// KNOWN player as soon as the real player's stake lock verifies (rps-opponent.mjs:334 knownAdd(String(w.tapKey))) - the stranger's key, which
// never staked - and from then on his signed taps alone send the bot into empty rounds ('a known player tapped', :316).
// Safe behaviour asserted: a later tap by ANOTHER key does not replace the key that tapped the round first.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { schnorr } from '@noble/curves/secp256k1.js';
import { opponentWant, opponentWants, tapSigned } from '../src/faucet.js';
import { presenceId } from '../../arena-protocol/src/match.js';
import { fromHex } from '../../arena-protocol/src/hash.js';

const hex = (b) => Buffer.from(b).toString('hex');
function tapOf(round, priv) {
  const key = hex(schnorr.getPublicKey(priv));
  const sig = hex(schnorr.sign(presenceId({ roundId: fromHex(round), identityKey: fromHex(key) }), priv));
  return { key, sig };
}

test('a stranger\'s signed tap on a real player\'s round does not replace the player\'s tap key', () => {
  const wants = new Map();
  const round = 'ab'.repeat(32);
  const player = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey();
  const stranger = schnorr.utils.randomSecretKey ? schnorr.utils.randomSecretKey() : schnorr.utils.randomPrivateKey();
  const pTap = tapOf(round, player), sTap = tapOf(round, stranger);
  assert.equal(tapSigned(round, pTap), true);
  assert.equal(tapSigned(round, sTap), true);
  const now = Date.now();
  // the real page taps (its own address)
  assert.equal(opponentWant(wants, round, now, pTap, '203.0.113.7').ok, true);
  // the stranger read GET /opponent and signs a tap of the same round with his own key, from his own address
  assert.equal(opponentWant(wants, round, now + 500, sTap, '198.51.100.9').ok, true);
  const row = opponentWants(wants, now + 600).find((x) => x.round === round);
  assert.ok(row);
  assert.equal(row.tapKey, pTap.key, `the round's tap key is now the stranger's (${String(row.tapKey).slice(0, 8)}), not the player's (${pTap.key.slice(0, 8)})`);
});
