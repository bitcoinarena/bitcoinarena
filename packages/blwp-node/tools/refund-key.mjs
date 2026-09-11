#!/usr/bin/env node
// THE PLAYER'S OWN CHECK OF THE REFUND KEY, OUTSIDE THE PAGE (§24, v4.6.2, F2).
//
//   node packages/blwp-node/tools/refund-key.mjs <seed-hex> <round-id-hex>
//
// The page shows a fingerprint of the key a round's refund and payout go to. A
// compromised web host could show one thing and build the lock with another,
// so the player checks it HERE - on their own machine, from their own seed
// backup, with code the web host does not serve - and compares the line below
// with the page. The rule is `protocol/src/player-key.js`; the curve is noble's
// BIP-340, the same `pointX` the page and the node use.
import { schnorr } from '@noble/curves/secp256k1.js';
import { fromHex, toHex } from '../../protocol/src/hash.js';
import { playerSecretFor, refundFingerprint } from '../../protocol/src/player-key.js';
import { refundKeyOf } from '../../protocol/src/stake-lock.js';

const [seedHex = '', roundHex = ''] = process.argv.slice(2);
const hex32 = /^[0-9a-f]{64}$/i;
if (!hex32.test(seedHex) || !hex32.test(roundHex)) {
  console.error('usage: node refund-key.mjs <seed: 64 hex> <round id: 64 hex>');
  process.exit(2);
}
const playerKey = schnorr.getPublicKey(playerSecretFor(fromHex(seedHex.toLowerCase()), fromHex(roundHex.toLowerCase())));
console.log(`player key   ${toHex(playerKey)}`);
console.log(`refund key   ${toHex(refundKeyOf(playerKey))}`);
console.log(`fingerprint  ${refundFingerprint(playerKey)}`);
